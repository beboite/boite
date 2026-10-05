import { untrack } from 'svelte';
import { previewReferencesError, type Attachment, type PreviewReference } from '@boite/contracts';
import type { Choice, Draft } from '../store.svelte';
import type { Composer } from './composer.svelte';
import type { StoreContext } from './context';
import { strings } from '../strings';
import { readDraftJournal, writeDraftJournal } from '../draft-journal';
import { unresolvedAssetId, type DraftAttachment } from '../draft-attachments';

type Input = Composer['composerStates'][string];
type SavedDraft = { draft: Draft; choice: Choice | null; input: Input };
type Journal = { updatedAt?: number; inputs?: Record<string, unknown>; drafts?: Record<string, unknown> };
const empty = (): Input => ({ text: '', attachments: [], queued: [], sending: false, paused: false });
const hasText = (input: Input | undefined) => !!(input?.text || input?.queued.length);
const hasContent = (input: Input | undefined) => hasText(input) || !!(input?.attachments.length || input?.previewReferences?.length);
const projectKey = (id: string | null) => JSON.stringify(id);

/** Device-local unsent text. Each host and data directory owns a separate journal. */
export class Drafts {
  saved = $state<Record<string, SavedDraft>>({});
  #key: string | null = null;
  #stop: (() => void) | null = null;
  #lastJournal: string | null = null;
  #pending: { key: string; value: unknown } | null = null;
  #writing: Promise<void> | null = null;
  #generation = 0;
  #revision = 0;
  #assetIds = new Map<string, string>();
  #writeFailed = false;
  #hydrated = false;
  #durableReady = false;

  constructor(private readonly ctx: StoreContext) {}

  async start(): Promise<void> {
    if (this.#stop) return;
    const s = this.ctx.store;
    this.#key = 'boite.unsent.v1:' + JSON.stringify([s.localCore ? 'local' : s.machineId || s.endpointUrl, s.core?.hostname, s.core?.dataDir]);
    let local;
    try { local = JSON.parse(localStorage.getItem(this.#key) ?? 'null'); } catch { /* Try the durable journal. */ }
    const generation = ++this.#generation;
    try {
      let readable = true;
      const durable = await readDraftJournal(this.#key).catch(() => { readable = false; return null; }) as Journal | null;
      if (generation !== this.#generation) return;
      this.#durableReady = readable;
      this.#writeFailed = !readable;
      if (!readable) s.error = strings.errors.draftStorage;
      const data = durable && (durable.updatedAt ?? 0) >= (local?.updatedAt ?? 0) ? durable
        : local?.incomplete && durable ? { ...local, inputs: { ...durable.inputs, ...local.inputs }, drafts: { ...durable.drafts, ...local.drafts } } : local;
      const assets = journalAssets(durable);
      for (const [id, bytes] of assets) this.#assetIds.set(bytes, id);
      this.#revision = typeof data?.updatedAt === 'number' && Number.isFinite(data.updatedAt) ? data.updatedAt : 0;
      if (data && typeof data === 'object') {
        for (const [id, input] of Object.entries(data.inputs ?? {})) {
          const restored = restoreInput(input, assets);
          if (restored) this.ctx.composer.composerStates[id] ??= restored;
        }
        for (const value of Object.values(data.drafts ?? {})) {
          const entry = value as Partial<SavedDraft> | null;
          if (!entry?.draft || (entry.draft.projectId !== null && typeof entry.draft.projectId !== 'string')) continue;
          const input = restoreInput(entry.input, assets);
          if (input) this.saved[projectKey(entry.draft.projectId)] = {
            draft: { projectId: entry.draft.projectId, worktree: entry.draft.worktree === true, worktreeExplicit: true },
            choice: null, input
          };
        }
      }
    } catch { /* An unavailable or malformed journal leaves the current session usable. */ }
    this.#hydrated = true;
    this.#stop = $effect.root(() => { $effect(() => this.persist()); });
  }

  stop(): void {
    this.persist();
    this.#stop?.();
    this.#generation++;
    this.#stop = null;
    this.#key = null;
    this.#hydrated = false;
    this.#durableReady = false;
    this.#lastJournal = null;
    this.#assetIds.clear();
    this.saved = {};
  }

  park(): void {
    const s = this.ctx.store;
    if (!s.draft) return;
    const key = projectKey(s.draft.projectId);
    const input = this.ctx.composer.composerStates.draft;
    // An incognito draft is never set aside: leaving it lets its words go.
    if (hasContent(input) && !s.draft.incognito) this.saved[key] = { draft: { ...s.draft }, choice: s.draftChoice, input: input! };
    else delete this.saved[key];
  }

  resume(projectId: string | null): void {
    this.park();
    const s = this.ctx.store;
    const saved = this.saved[projectKey(projectId)];
    this.ctx.composer.composerStates.draft = saved?.input ?? empty();
    s.draft = saved ? { ...saved.draft } : { projectId, worktree: s.projects.some(p => p.id === projectId && p.kind !== 'drafts' && p.repository !== false && p.worktreeDefault === true) };
    s.draftChoice = saved?.choice ?? null;
  }

  forget(projectId: string | null): void { delete this.saved[projectKey(projectId)]; }
  has(projectId: string | null): boolean { return hasContent(this.saved[projectKey(projectId)]?.input); }
  async flush(): Promise<boolean> { this.persist(); while (this.#writing) await this.#writing; return !this.#writeFailed; }

  get entries(): { projectId: string | null; text: string; active: boolean }[] {
    const s = this.ctx.store;
    const entries = Object.values(this.saved).filter(entry => hasContent(entry.input))
      .filter(entry => entry.draft.projectId === null || s.projects.some(p => p.id === entry.draft.projectId && !p.archived))
      .map(entry => ({ projectId: entry.draft.projectId, text: entry.input.text, active: false }));
    if (s.draft) {
      const entry = { projectId: s.draft.projectId, text: this.ctx.composer.composerStates.draft?.text ?? '', active: true };
      const index = entries.findIndex(item => item.projectId === entry.projectId);
      if (index < 0) entries.push(entry); else entries[index] = entry;
    }
    return entries;
  }

  /** Called synchronously on typing, and reactively for queue, send and navigation changes. */
  persist(): void {
    if (!this.#key || !this.#hydrated) return;
    // Nothing typed into an incognito conversation reaches the device's storage.
    const incognito = this.#incognitoThreads();
    const inputs = Object.fromEntries(Object.entries(this.ctx.composer.composerStates)
      .filter(([id, input]) => id !== 'draft' && !incognito.has(id) && hasContent(input)).map(([id, input]) => [id, savedInput(input, this.#assetId)]));
    const drafts = { ...this.saved };
    const current = this.ctx.store.draft;
    if (current?.incognito) delete drafts[projectKey(current.projectId)];
    else if (current) {
      const input = this.ctx.composer.composerStates.draft;
      const key = projectKey(current.projectId);
      if (hasContent(input)) drafts[key] = { draft: current, choice: null, input: input! };
      else delete drafts[key];
    }
    const full = { inputs, drafts: Object.fromEntries(Object.entries(drafts)
      .filter(([, entry]) => hasContent(entry.input)).map(([id, entry]) => [id, { draft: { ...entry.draft }, input: savedInput(entry.input, this.#assetId) }])) };
    // The small synchronous backup covers typing while the durable transaction is pending.
    const journal = JSON.stringify(full, (key, value) => key === 'data' ? undefined : value);
    untrack(() => {
      if (journal === this.#lastJournal) return;
      const updatedAt = this.#revision = Math.max(Date.now(), this.#revision + 1);
      try { localStorage.setItem(this.#key!, JSON.stringify({ ...JSON.parse(journal), updatedAt, ...(!this.#durableReady ? { incomplete: true } : {}) })); }
      catch { if (typeof indexedDB === 'undefined') this.ctx.store.error = strings.errors.draftStorage; }
      this.#lastJournal = journal;
      // Never replace a durable journal we could not read. Text still has its backup.
      if (!this.#durableReady) return;
      this.#pending = { key: this.#key!, value: { ...full, updatedAt } };
      this.#schedule();
    });
  }

  #incognitoThreads(): Set<string> {
    const s = this.ctx.store;
    const ids = new Set(s.threads.filter(thread => thread.incognito).map(thread => thread.id));
    if (s.openThread?.incognito) ids.add(s.openThread.id);
    return ids;
  }

  #assetId = (bytes: string): string => {
    let id = this.#assetIds.get(bytes);
    if (!id) { id = crypto.randomUUID(); this.#assetIds.set(bytes, id); }
    return id;
  };

  #schedule(): void {
    this.#writing ??= this.#drain().finally(() => {
      this.#writing = null;
      if (this.#pending) this.#schedule();
    });
  }

  async #drain(): Promise<void> {
    while (this.#pending) {
      const next = this.#pending;
      this.#pending = null;
      try { await writeDraftJournal(next.key, next.value); this.#writeFailed = false; }
      catch {
        if (next.key === this.#key) { this.#writeFailed = true; this.#lastJournal = null; this.ctx.store.error = strings.errors.draftStorage; }
      }
    }
  }
}

function savedInput(input: Input, assetId: (bytes: string) => string) {
  const file = (item: Attachment) => ({ kind: item.kind, mimeType: item.mimeType, name: item.name,
    assetId: unresolvedAssetId(item) ?? assetId(item.data), ...(unresolvedAssetId(item) ? {} : { data: item.data }) });
  return { text: input.text, editing: input.editing ?? null, attachments: input.attachments.map(file),
    previewReferences: $state.snapshot(input.previewReferences),
    queued: input.queued.map(item => ({ text: item.text, attachments: item.attachments.map(file), previewReferences: $state.snapshot(item.previewReferences) })) };
}

function references(value: unknown): PreviewReference[] {
  return Array.isArray(value) && !previewReferencesError(value) ? value as PreviewReference[] : [];
}

function restoreInput(value: unknown, assets: Map<string, string>): Input | null {
  if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string') return null;
  const raw = value as { text: string; editing?: unknown; queued?: unknown; previewReferences?: unknown; attachments?: unknown };
  return { ...empty(), text: raw.text, editing: typeof raw.editing === 'string' ? raw.editing : null,
    previewReferences: references(raw.previewReferences),
    attachments: attachments(raw.attachments, assets),
    queued: Array.isArray(raw.queued) ? raw.queued.filter(item => item && typeof item.text === 'string').map(item => ({ text: item.text, attachments: attachments(item.attachments, assets), previewReferences: references(item.previewReferences) })) : [],
    paused: true };
}

function attachments(value: unknown, assets: Map<string, string>): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || !['image', 'file'].includes(item.kind) || typeof item.mimeType !== 'string') return [];
    const data = typeof item.data === 'string' ? item.data : assets.get(item.assetId);
    if (data === undefined && typeof item.assetId !== 'string') return [];
    // Keep unresolved IDs in the authoritative attachment list. Removing a
    // placeholder removes its ID too, so recovery cannot resurrect that file.
    const attachment: DraftAttachment = { kind: item.kind, mimeType: item.mimeType, data: data ?? '', name: typeof item.name === 'string' ? item.name : null,
      ...(data === undefined ? { pendingDraftAsset: item.assetId } : {}) };
    return [attachment];
  });
}

function journalAssets(value: unknown): Map<string, string> {
  const assets = new Map<string, string>();
  if (!value || typeof value !== 'object') return assets;
  const journal = value as { inputs?: Record<string, Input>; drafts?: Record<string, SavedDraft> };
  for (const input of [...Object.values(journal.inputs ?? {}), ...Object.values(journal.drafts ?? {}).map(entry => entry?.input)]) {
    if (!input) continue;
    const files = [...(Array.isArray(input.attachments) ? input.attachments : []), ...(Array.isArray(input.queued) ? input.queued.flatMap(entry => Array.isArray(entry?.attachments) ? entry.attachments : []) : [])];
    for (const file of files) {
      const stored = file as Attachment & { assetId?: string };
      if (stored && typeof stored.assetId === 'string' && typeof stored.data === 'string') assets.set(stored.assetId, stored.data);
    }
  }
  return assets;
}
