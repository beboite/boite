import { untrack } from 'svelte';
import type { RpcParams } from '@boite/contracts';
import type { Choice, Draft } from '../store.svelte';
import type { Client } from '../client';
import { DRAFT_STASH_KEY } from '../prefs';
import { secureId } from '../secure-id';
import type { StoreContext } from './context';
import { AttachmentUploads } from './attachment-uploads';
import { readyAttachments } from '../draft-attachments';

type Prepared = { client: Client; generation: number; draft: Draft; key: string; id: string;
  source: Choice; choice: Choice | null; input: RpcParams<'drafts.prepare'> | null; ready: boolean; claimed: boolean };
const choiceKey = (choice: Choice) => JSON.stringify([choice.providerId, choice.accountId, choice.model, choice.effort, choice.speed ?? null, choice.permissionMode]);

/** Speculation belongs to the visible draft and never carries a prompt. */
export class DraftStartup {
  readonly uploads: AttachmentUploads;
  #prepared: Prepared | null = null;
  #sendingDraft: Draft | null = null;
  #hidden = $state(false);
  constructor(private readonly ctx: StoreContext) { this.uploads = new AttachmentUploads(ctx); }

  watch(): () => void {
    const visibility = () => { this.#hidden = document.hidden; };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    const stop = $effect.root(() => {
      $effect(() => {
        const s = this.ctx.store;
        const draft = s.draft;
        const input = s.composerStates[s.openThread?.id ?? DRAFT_STASH_KEY];
        const active = s.visible && !this.#hidden && s.page === 'chat' && s.connection === 'ready';
        const files = active ? readyAttachments(input?.attachments ?? []) : [];
        const choice = active && draft && !s.openThread && (input?.text.trim() || files.length) ? s.defaultChoice() : null;
        const key = draft && choice ? this.#key(draft, choice) : null;
        const client = this.ctx.client;
        const generation = this.ctx.clientGeneration;
        const supports = s.core?.features?.draftPreparation === true;
        untrack(() => {
          this.uploads.select(files, active && s.core?.features?.attachmentUploads === true);
          if (!supports || !key || !client || !draft || !choice) { this.release(); return; }
          if (this.#sendingDraft === draft) return;
          this.#sendingDraft = null;
          const held = this.#prepared;
          if (held?.key === key && held.client === client && held.generation === generation && held.draft === draft) return;
          this.release();
          const made: Prepared = { client, generation, draft, key, id: secureId(), source: { ...choice }, choice: null, input: null, ready: false, claimed: false };
          this.#prepared = made;
          void this.#prepare(made, choice);
        });
      });
    });
    return () => { document.removeEventListener('visibilitychange', visibility); stop(); this.reset(); };
  }

  async #prepare(made: Prepared, choice: Choice): Promise<void> {
    const s = this.ctx.store;
    try {
      const final = await this.ctx.models.prepareDraftChoice(choice, { background: true });
      if (!final || this.#prepared !== made) return;
      const projectId = made.draft.projectId ?? await this.ctx.projects.ensureDrafts();
      if (!projectId || this.#prepared !== made) return;
      made.choice = final;
      made.input = { preparationId: made.id, projectId, providerId: final.providerId, accountId: final.accountId,
        permissionMode: final.permissionMode, effort: final.effort, speed: final.speed ?? null,
        ...(final.model ? { model: final.model } : {}), ...(made.draft.worktree ? { worktree: {} } : {}),
        ...(made.draft.incognito && s.draftInDrafts ? { incognito: true } : {}) };
      await made.client.call('drafts.prepare', made.input);
      if (this.#prepared !== made || !this.ctx.currentClient(made.client, made.generation)) {
        await made.client.call('drafts.release', { preparationId: made.id }).catch(() => undefined);
        return;
      }
      made.ready = true;
    } catch { /* Send validates and creates normally when speculation fails. */ }
  }

  /** Pending work is never awaited by Send. Only the exact resolved choice can be claimed. */
  take(draft: Draft, choice: Choice): { preparationId: string; choice: Choice; projectId: string } | null {
    const held = this.#prepared;
    const s = this.ctx.store;
    this.#sendingDraft = draft;
    if (!held?.ready || !held.choice || !held.input || held.draft !== draft || held.claimed ||
      !s.visible || this.#hidden || s.connection !== 'ready' || !this.ctx.currentClient(held.client, held.generation)) return null;
    // A built-in default can have moved to the catalog's final choice in the background.
    const current = s.defaultChoice();
    if (!current || (choiceKey(current) !== choiceKey(held.source) && choiceKey(current) !== choiceKey(held.choice)) ||
      (choiceKey(choice) !== choiceKey(held.source) && choiceKey(choice) !== choiceKey(held.choice))) return null;
    if (held.key !== this.#key(draft, held.source)) return null;
    held.claimed = true;
    this.#prepared = null;
    return { preparationId: held.id, choice: held.choice, projectId: held.input.projectId };
  }

  /**
   * What a preparation is valid for. A draft with no project goes to the
   * drafts project: its id is part of the key, so removing the drafts drops a
   * preparation made in them instead of sending into a project that is gone.
   */
  #key(draft: Draft, choice: Choice): string {
    const s = this.ctx.store;
    const projectId = draft.projectId ?? s.draftsProject?.id ?? null;
    const project = projectId ? s.projects.find(p => p.id === projectId) : null;
    return JSON.stringify([draft.id, projectId, draft.worktree, draft.incognito, project?.path, choiceKey(choice)]);
  }

  finish(draft: Draft | null): void { if (this.#sendingDraft === draft) this.#sendingDraft = null; }

  release(): void {
    const held = this.#prepared;
    this.#prepared = null;
    if (held && !held.claimed) void held.client.call('drafts.release', { preparationId: held.id }).catch(() => undefined);
  }
  reset(): void { this.#sendingDraft = null; this.release(); this.uploads.reset(); }
}
