import { untrack } from 'svelte';
import type { ThreadId } from '@boite/contracts';
import { RpcFailure, wasDropped, wasUnanswered } from '../client';
import { titleFrom } from '../format';
import { secureId } from '../secure-id';
import { DRAFT_STASH_KEY } from '../prefs';
import { wasClosed } from '../rpc-error';
import type { Choice, Draft } from '../store.svelte';
import type { OutboxRequest } from './composer.svelte';
import type { StoreContext } from './context';
import { draftKey, type Input } from './drafts.svelte';

/** How long a queued draft whose start got nowhere waits before it is tried again. */
const DRAFT_RETRY_MS = 15_000;

/**
 * The drafts sent while their machine was away: each becomes its conversation
 * once the machine is back, in the order they were sent (`docs/machines.md`).
 */
export class DraftLaunch {
  /** The queued drafts are being started, one after the other; `again` asks for one more pass. */
  private launches: { again: boolean } | null = null;
  /** Drafts whose start got nowhere for a reason that may pass (no answer, no drafts project): left alone for a while, by the request that stalled. */
  private stalled = new Map<string, string>();
  /** Bumped when a stalled draft may be tried again. */
  private tick = $state(0);

  constructor(private readonly ctx: StoreContext) {}

  /** Runs inside the composer's effect root: a ready machine starts what its drafts queued. */
  watch(): void {
    $effect(() => {
      void this.tick;
      if (this.ctx.store.connection !== 'ready' || this.queuedDrafts().length === 0) return;
      untrack(() => void this.launchQueuedDrafts());
    });
  }

  /** The open draft, else a saved one, under its key, with what it was written with. */
  private draftAt(key: string): { draft: Draft; input: Input; choice: Choice | null } | null {
    const s = this.ctx.store;
    const input = this.ctx.composer.composerStates[DRAFT_STASH_KEY];
    if (s.draft && draftKey(s.draft) === key) return input ? { draft: s.draft, input, choice: s.draftChoice } : null;
    const saved = this.ctx.drafts.saved[key];
    return saved ? { draft: saved.draft, input: saved.input, choice: saved.choice } : null;
  }

  /** The drafts whose first prompt waits to start their conversation, oldest queue first. */
  private queuedDrafts(): string[] {
    const s = this.ctx.store;
    // A core that keeps composer records starts these drafts itself; incognito ones stay here.
    const own = (draft: Draft) => !this.ctx.sync.deferredDraft(draft);
    const waiting = (input: Input | undefined): input is Input => !!input && !input.sending && !!input.queued[0]?.request && input.queued[0].request.failed === undefined;
    // Only the request that stalled waits: one sent again after a cancel goes at once.
    const ready = (key: string, input: Input) => this.stalled.get(key) !== input.queued[0]?.request?.id;
    const keys: { key: string; at: number }[] = [];
    const open = s.draft ? draftKey(s.draft) : null;
    const input = this.ctx.composer.composerStates[DRAFT_STASH_KEY];
    if (open !== null && own(s.draft!) && waiting(input) && ready(open, input)) keys.push({ key: open, at: input.queued[0]!.request!.queuedAt });
    for (const [key, saved] of Object.entries(this.ctx.drafts.saved)) {
      if (key !== open && own(saved.draft) && waiting(saved.input) && ready(key, saved.input)) keys.push({ key, at: saved.input.queued[0]!.request!.queuedAt });
    }
    return keys.sort((a, b) => a.at - b.at).map(entry => entry.key);
  }

  /** One pass at a time, in the order the drafts were queued, so their conversations start in that order. */
  private async launchQueuedDrafts(): Promise<void> {
    if (this.launches) { this.launches.again = true; return; }
    const pass = { again: true };
    this.launches = pass;
    try {
      while (pass.again) {
        pass.again = false;
        for (const key of this.queuedDrafts()) {
          if (this.ctx.store.connection !== 'ready') return;
          await this.launchDraft(key);
        }
      }
    } finally { this.launches = null; }
  }

  /**
   * Starts the conversation of a draft whose first prompt was written while its
   * machine was away. The core makes it under that prompt's request id, so a
   * creation whose answer the link lost is not made twice, and the draft's queue
   * moves to the new thread's outbox, which sends it in order under the same ids.
   * A refusal stays on the prompt with its reason and Send again.
   */
  private async launchDraft(key: string): Promise<void> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    const generation = this.ctx.clientGeneration;
    const source = this.draftAt(key);
    const head = source?.input.queued[0];
    if (!client || !source || !head?.request || head.request.failed !== undefined || source.input.sending) return;
    const { draft, input } = source;
    const request = head.request;
    // The composer queues with the chips' choice; a draft saved without one starts on the machine's default.
    const choice = request.choice ?? source.choice ?? s.defaultChoice();
    if (!choice) { this.stall(key, request.id); return; }
    input.sending = true;
    input.outgoing = 1;
    try {
      await this.ctx.connection.reloading?.essential;
      if (!this.ctx.currentClient(client, generation) || s.connection !== 'ready' || input.queued[0] !== head) return;
      // A start asked once is asked again the same way, whatever the draft became since: the core holds the id to it.
      const start = request.start ?? await this.startOf(draft);
      if (!this.ctx.currentClient(client, generation)) return;
      if (start === null) { this.stall(key, request.id); return; }
      if (!request.start && input.queued[0] === head) {
        head.request = { ...request, start };
        this.ctx.drafts.persist(); void this.ctx.drafts.flush();
      }
      const created = await client.call('threads.create', {
        projectId: start.projectId,
        providerId: choice.providerId,
        accountId: choice.accountId,
        permissionMode: choice.permissionMode,
        title: titleFrom(head.text) || undefined,
        effort: choice.effort,
        speed: choice.speed ?? null,
        ...(choice.model ? { model: choice.model } : {}),
        ...(start.worktree ? { worktree: {} } : {}),
        ...(start.incognito ? { incognito: true } : {}),
        clientRequestId: request.id
      });
      if (!this.ctx.currentClient(client, generation)) return;
      this.ctx.threads.upsertThread(created);
      this.adoptLaunched(key, input, created.id);
    } catch (error) {
      if (!this.ctx.currentClient(client, generation)) return;
      // Lost with the link: the next connection asks again under the same id. Unanswered on a live one: a little later.
      if (wasDropped(error) || wasClosed(error) || wasUnanswered(error) || s.connection !== 'ready') {
        if (s.connection === 'ready') this.stall(key, request.id);
        return;
      }
      if (input.queued[0] === head) {
        // A refusal made nothing, so the start may be taken back or asked again differently; one about its
        // request id says the core holds a conversation under it, and keeps what was asked, unless that
        // conversation was deleted since: then nothing holds it, the start unlocks and Send again goes under a fresh id.
        const { start: asked, ...rest } = request;
        const data = error instanceof RpcFailure ? error.data as { field?: unknown; reason?: unknown } | undefined : undefined;
        const held = data?.field === 'clientRequestId' && data.reason !== 'deleted';
        // A deleted conversation burned its id: Send again goes under a fresh one.
        const burned = data?.field === 'clientRequestId' && data.reason === 'deleted';
        head.request = { ...rest, ...(burned ? { id: secureId() } : {}), ...(held && asked ? { start: asked } : {}), failed: this.ctx.reason(error) };
      }
      this.ctx.drafts.persist(); void this.ctx.drafts.flush();
    } finally {
      input.sending = false;
      input.outgoing = 0;
    }
  }

  /** A start that got nowhere is not tried again at once, which would loop on the same answer. */
  private stall(key: string, requestId: string): void {
    this.stalled.set(key, requestId);
    setTimeout(() => { if (this.stalled.get(key) === requestId) this.stalled.delete(key); this.tick++; }, DRAFT_RETRY_MS);
  }

  /**
   * Where the draft starts: its project, or the drafts project, which a
   * background start looks up without a notification, and the worktree and
   * incognito switches as the draft's own send would read them.
   */
  private async startOf(draft: Draft): Promise<NonNullable<OutboxRequest['start']> | null> {
    const s = this.ctx.store;
    const projectId = draft.projectId ?? await this.ctx.projects.ensureDrafts({ quiet: true });
    if (projectId === null) return null;
    return { projectId, worktree: draft.worktree, incognito: !!draft.incognito && projectId === s.draftsProject?.id };
  }

  /**
   * The new conversation takes the draft's queue as its outbox. The draft goes
   * unless text waits in its box; the one on screen gives way to the conversation.
   */
  private adoptLaunched(key: string, input: Input, threadId: ThreadId): void {
    const s = this.ctx.store;
    const state = (this.ctx.composer.composerStates[threadId] ??= { text: '', attachments: [], queued: [], sending: false, paused: false });
    // A draft started again after a crash finds its prompts there already: the same ids, once.
    const moved = input.queued.splice(0)
      .filter(entry => !state.queued.some(queued => queued.request && queued.request.id === entry.request?.id))
      .map(entry => {
        if (!entry.request?.start) return entry;
        const { start: _start, ...request } = entry.request;
        return { ...entry, request };
      });
    state.queued.push(...moved);
    // The thread's outbox is written before the draft goes: a crash between the two leaves the
    // prompt in both, which the core takes once under its ids, never in neither.
    this.ctx.drafts.persist(threadId);
    const viewing = !!s.draft && draftKey(s.draft) === key && !s.openThread;
    const kept = !!(input.text || input.attachments.length || input.previewReferences?.length);
    if (!kept) this.ctx.drafts.discard(key, { started: true });
    this.ctx.drafts.persist(); void this.ctx.drafts.flush();
    if (viewing && !kept) void s.open(threadId);
  }
}
