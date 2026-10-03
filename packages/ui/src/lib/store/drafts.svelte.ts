import { untrack } from 'svelte';
import { previewReferencesError, type Attachment, type PreviewReference } from '@boite/contracts';
import type { Choice, Draft } from '../store.svelte';
import type { Composer, OutboxRequest } from './composer.svelte';
import type { StoreContext } from './context';
import { strings } from '../strings';
import { readDraftJournal, writeDraftJournal } from '../draft-journal';
import { unresolvedAssetId, type DraftAttachment } from '../draft-attachments';
import { secureId } from '../secure-id';

type Input = Composer['composerStates'][string];
type SavedDraft = { draft: Draft; choice: Choice | null; input: Input };
type Journal = { updatedAt?: number; inputs?: Record<string, unknown>; drafts?: Record<string, unknown> };
type Source = { section: 'inputs' | 'drafts'; id: string; input: Input; draft?: Draft };
type CachedEntry = { section: Source['section']; id: string; value: unknown; serialized: string; updatedAt: number; backedUp: boolean };
const entryKey = (section: Source['section'], id: string) => JSON.stringify([section, id]);
const empty = (): Input => ({ text: '', attachments: [], queued: [], sending: false, paused: false });
const hasText = (input: Input | undefined) => !!(input?.text || input?.queued.length);
const hasContent = (input: Input | undefined) => hasText(input) || !!(input?.attachments.length || input?.previewReferences?.length);
const vacant = (input: Input | undefined) => !hasContent(input) && !input?.editing && !input?.sending;
const projectKey = (id: string | null) => JSON.stringify(id);
/**
 * How long the durable journal waits after the last keystroke. The synchronous
 * backup already holds the text by then; the durable copy is what carries the
 * attachments' bytes, and writing it on every key cloned each picture into
 * IndexedDB and waited on the disk while the user typed.
 */
const DURABLE_DELAY_MS = 800;
/** Typing that never pauses still reaches the durable journal this often. */
const DURABLE_MAX_WAIT_MS = 5000;

/** Device-local unsent text. Each host and data directory owns a separate journal. */
export class Drafts {
  saved = $state<Record<string, SavedDraft>>({});
  #key: string | null = null;
  #stop: (() => void) | null = null;
  #entries = new Map<string, CachedEntry>();
  #collecting = false;
  #changed = false;
  #writingAssets = new Set<string>();
  #storedAssetIds = new Set<string>();
  #failedEntries = new Set<string>();
  #pending: { key: string; value: unknown } | null = null;
  #writing: Promise<void> | null = null;
  #generation = 0;
  #revision = 0;
  #assetIds = new Map<string, string>();
  #writeFailed = false;
  #hydrated = $state(false);
  #durableReady = $state(false);
  /** A file the durable journal has never held: its bytes live nowhere else yet. */
  #newAsset = false;
  /** The synchronous backup refused the last write, so the durable journal is the only copy. */
  #backupFailed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #waitingSince = 0;

  constructor(private readonly ctx: StoreContext) {}

  get readable(): boolean { return this.#hydrated && this.#durableReady; }

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
      const previous = durable && (durable.updatedAt ?? 0) >= (local?.updatedAt ?? 0) ? durable
        : local?.incomplete && durable ? { ...local, inputs: { ...durable.inputs, ...local.inputs }, drafts: { ...durable.drafts, ...local.drafts } } : local;
      const data = overlayBackup(this.#key!, previous);
      const assets = journalAssets(durable);
      this.#storedAssetIds = new Set(assets.keys());
      for (const [id, bytes] of assets) this.#assetIds.set(bytes, id);
      this.#revision = typeof data?.updatedAt === 'number' && Number.isFinite(data.updatedAt) ? data.updatedAt : 0;
      if (data && typeof data === 'object') {
        for (const [id, input] of Object.entries(data.inputs ?? {})) {
          const restored = restoreInput(input, assets);
          if (restored && vacant(this.ctx.composer.composerStates[id])) this.ctx.composer.composerStates[id] = restored;
        }
        for (const value of Object.values(data.drafts ?? {})) {
          const entry = value as Partial<SavedDraft> | null;
          if (!entry?.draft || (entry.draft.projectId !== null && typeof entry.draft.projectId !== 'string')) continue;
          const input = restoreInput(entry.input, assets);
          const key = projectKey(entry.draft.projectId);
          if (input && vacant(this.saved[key]?.input)) this.saved[key] = {
            draft: { projectId: entry.draft.projectId, worktree: entry.draft.worktree === true, worktreeExplicit: true },
            choice: null, input
          };
        }
        const current = s.draft;
        const saved = current && this.saved[projectKey(current.projectId)];
        if (current && saved && vacant(this.ctx.composer.composerStates.draft)) {
          this.ctx.composer.composerStates.draft = saved.input;
          if (!current.worktreeExplicit) s.draft = { ...saved.draft };
        }
      }
    } catch { /* An unavailable or malformed journal leaves the current session usable. */ }
    this.#hydrated = true;
    this.persist();
    const root = $effect.root(() => {
      $effect(() => {
        const sources = this.#sources();
        untrack(() => this.#removeMissing(sources));
        for (const source of sources) $effect(() => this.#capture(source));
      });
    });
    // Leaving the page or the app going to the background writes the durable
    // journal at once: a phone may never bring a hidden page back.
    const leave = () => { this.persist(); this.#writeNow(); };
    const hidden = () => { if (document.visibilityState === 'hidden') leave(); };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hidden);
    this.#stop = () => {
      root();
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', hidden);
    };
  }

  stop(): void {
    this.persist();
    this.#writeNow();
    this.#stop?.();
    this.#generation++;
    this.#stop = null;
    this.#key = null;
    this.#hydrated = false;
    this.#durableReady = false;
    this.#entries.clear();
    this.#changed = false;
    this.#assetIds.clear();
    this.#storedAssetIds.clear();
    this.#failedEntries.clear();
    this.saved = {};
  }

  park(): void {
    const s = this.ctx.store;
    if (!s.draft) return;
    const key = projectKey(s.draft.projectId);
    const input = this.ctx.composer.composerStates.draft;
    if (hasContent(input)) this.saved[key] = { draft: { ...s.draft }, choice: s.draftChoice, input: input! };
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
  async flush(): Promise<boolean> {
    this.persist(); this.#writeNow();
    while (this.#writing) await this.#writing;
    // Without IndexedDB, every entry must have reached its synchronous backup.
    return this.readable && !this.#writeFailed && !this.#failedEntries.size
      && (typeof indexedDB !== 'undefined' || [...this.#entries.values()].every(entry => entry.backedUp));
  }

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

  /** Back up new input before hydration; only a readable journal can receive a full checkpoint. */
  persist(key?: string): void {
    if (!this.#key) return;
    this.#collecting = true;
    try {
      if (key !== undefined) {
        const input = this.ctx.composer.composerStates[key];
        const draft = this.ctx.store.draft;
        if (key === 'draft') {
          if (draft && input) this.#capture({ section: 'drafts', id: projectKey(draft.projectId), input, draft: { ...draft } });
        } else if (input) this.#capture({ section: 'inputs', id: key, input });
        else this.#capture(null, entryKey('inputs', key));
      } else {
        const sources = this.#sources();
        this.#removeMissing(sources);
        for (const source of sources) this.#capture(source);
      }
    } finally {
      this.#collecting = false;
      if (this.#changed || this.#writeFailed) this.#checkpoint();
      else this.#pruneAssets();
    }
  }

  #sources(): Source[] {
    const sources: Source[] = Object.entries(this.ctx.composer.composerStates)
      .filter(([id]) => id !== 'draft').map(([id, input]) => ({ section: 'inputs', id, input }));
    const drafts = new Map(Object.entries(this.saved).map(([id, entry]) => [id, { section: 'drafts' as const, id, input: entry.input, draft: { ...entry.draft } }]));
    const current = this.ctx.store.draft;
    const input = this.ctx.composer.composerStates.draft;
    if (current && input) drafts.set(projectKey(current.projectId), { section: 'drafts', id: projectKey(current.projectId), input, draft: { ...current } });
    return [...sources, ...drafts.values()];
  }

  #removeMissing(sources: Source[]): void {
    const present = new Set(sources.map(source => entryKey(source.section, source.id)));
    for (const key of this.#failedEntries) if (!present.has(key)) this.#failedEntries.delete(key);
    for (const key of this.#entries.keys()) if (!present.has(key)) this.#capture(null, key);
  }

  #capture(source: Source | null, key = source ? entryKey(source.section, source.id) : ''): void {
    if (!this.#key) return;
    try {
      const input = source && hasContent(source.input) ? savedInput(source.input, this.#assetId) : null;
      const value = input && source ? source.section === 'drafts' ? { draft: source.draft, input } : input : null;
      const stored = this.#storedAssetIds;
      // Until a strict durable write succeeds, keep inline bytes in the atomic
      // backup too. This also preserves old journals without IndexedDB.
      const serialized = JSON.stringify(value, function (this: { assetId?: string }, field, value) {
        return field === 'data' && stored.has(this.assetId ?? '') ? undefined : value;
      });
      untrack(() => {
        const previous = this.#entries.get(key);
        this.#failedEntries.delete(key);
        // A blank placeholder cannot delete a journal entry we did not read.
        if (value === null && !previous) return;
        if (previous?.serialized === serialized && previous.backedUp) return;
        const updatedAt = this.#revision = Math.max(Date.now(), this.#revision + 1);
        const entry = { section: source?.section ?? previous!.section, id: source?.id ?? previous!.id, value, serialized, updatedAt, backedUp: false };
        this.#entries.set(key, entry);
        // Each atomic entry includes its own revision; null is a deletion tombstone.
        // The old complete v1 backup remains available throughout migration.
        try { localStorage.setItem(`${this.#key}:entry:${key}`, `{"updatedAt":${updatedAt},"value":${serialized}}`); entry.backedUp = true; }
        catch { if (typeof indexedDB === 'undefined') this.ctx.store.error = strings.errors.draftStorage; }
        this.#changed = true;
        if (!this.#collecting) this.#checkpoint();
      });
    } catch {
      this.#failedEntries.add(key);
      this.#writeFailed = true;
      this.ctx.store.error = strings.errors.draftStorage;
    }
  }

  #checkpoint(): void {
    this.#changed = false;
    this.#backupFailed = [...this.#entries.values()].some(entry => !entry.backedUp);
    if (this.#durableReady) {
      const inputs: Record<string, unknown> = {}, drafts: Record<string, unknown> = {};
      for (const entry of this.#entries.values()) if (entry.value !== null) (entry.section === 'inputs' ? inputs : drafts)[entry.id] = entry.value;
      this.#pending = { key: this.#key!, value: { inputs, drafts, updatedAt: this.#revision } };
      if (this.#newAsset || this.#backupFailed) this.#writeNow();
      else this.#writeLater();
    }
    this.#pruneAssets();
  }

  #pruneAssets(): void {
    const retained = new Set(this.#writingAssets);
    for (const entry of this.#entries.values()) {
      const input = (entry.section === 'inputs' ? entry.value : (entry.value as { input?: Input } | null)?.input) as Input | null;
      if (!input) continue;
      for (const file of [...input.attachments, ...input.queued.flatMap(item => item.attachments)]) {
        if (typeof file.data === 'string') retained.add(file.data);
      }
    }
    for (const bytes of journalAssets(this.#pending?.value).values()) retained.add(bytes);
    for (const bytes of this.#assetIds.keys()) if (!retained.has(bytes)) this.#assetIds.delete(bytes);
  }

  /** The durable journal after a pause in typing, never later than the longest wait. */
  #writeLater(): void {
    const now = Date.now();
    if (this.#timer === undefined) this.#waitingSince = now;
    else clearTimeout(this.#timer);
    const wait = Math.min(DURABLE_DELAY_MS, Math.max(0, this.#waitingSince + DURABLE_MAX_WAIT_MS - now));
    this.#timer = setTimeout(() => this.#writeNow(), wait);
  }

  #writeNow(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#newAsset = false;
    if (this.#pending) this.#schedule();
  }

  #assetId = (bytes: string): string => {
    let id = this.#assetIds.get(bytes);
    if (!id) { id = secureId(); this.#assetIds.set(bytes, id); this.#newAsset = true; }
    return id;
  };

  /** A write already under way does not pick up text that is still waiting for its pause. */
  #schedule(): void {
    this.#writing ??= this.#drain().finally(() => {
      this.#writing = null;
      if (this.#pending && this.#timer === undefined) this.#schedule();
    });
  }

  async #drain(): Promise<void> {
    while (this.#pending && this.#timer === undefined) {
      const next = this.#pending;
      this.#pending = null;
      this.#writingAssets = new Set(journalAssets(next.value).values());
      try {
        await writeDraftJournal(next.key, next.value);
        if (next.key === this.#key) {
          this.#writeFailed = false;
          if (typeof indexedDB !== 'undefined') {
            this.#storedAssetIds = new Set(journalAssets(next.value).keys());
            // Retire the complete legacy backup only after the strict commit
            // and a successful synchronous backup for every current entry.
            if ([...this.#entries.values()].every(entry => entry.backedUp)) {
              try { localStorage.removeItem(next.key); } catch { /* Keep the older backup. */ }
            }
          }
        }
      }
      catch {
        if (next.key === this.#key) { this.#writeFailed = true; this.ctx.store.error = strings.errors.draftStorage; }
      } finally { this.#writingAssets.clear(); this.#pruneAssets(); }
    }
  }
}

function savedInput(input: Input, assetId: (bytes: string) => string) {
  const file = (item: Attachment) => ({ kind: item.kind, mimeType: item.mimeType, name: item.name,
    assetId: unresolvedAssetId(item) ?? assetId(item.data), ...(unresolvedAssetId(item) ? {} : { data: item.data }) });
  return { text: input.text, editing: input.editing ?? null, attachments: input.attachments.map(file),
    previewReferences: $state.snapshot(input.previewReferences),
    queued: input.queued.map(item => ({ text: item.text, attachments: item.attachments.map(file), previewReferences: $state.snapshot(item.previewReferences),
      ...(item.request ? { request: $state.snapshot(item.request) } : {}) })) };
}

/** An outbox prompt's request id, choice and refusal, or nothing for a stored value that is not one. */
function outboxRequest(value: unknown): OutboxRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<OutboxRequest>;
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(raw.id)) return undefined;
  const choice = raw.choice && typeof raw.choice === 'object' && typeof raw.choice.providerId === 'string' && typeof raw.choice.accountId === 'string' ? raw.choice : null;
  return { id: raw.id, choice, queuedAt: typeof raw.queuedAt === 'number' ? raw.queuedAt : 0, ...(typeof raw.failed === 'string' ? { failed: raw.failed } : {}) };
}

function references(value: unknown): PreviewReference[] {
  return Array.isArray(value) && !previewReferencesError(value) ? value as PreviewReference[] : [];
}

function restoreInput(value: unknown, assets: Map<string, string>): Input | null {
  if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string') return null;
  const raw = value as { text: string; editing?: unknown; queued?: unknown; previewReferences?: unknown; attachments?: unknown };
  const queued: Input['queued'] = Array.isArray(raw.queued) ? raw.queued.filter(item => item && typeof item.text === 'string').map(item => {
    const request = outboxRequest(item.request);
    return { text: item.text, attachments: attachments(item.attachments, assets), previewReferences: references(item.previewReferences), ...(request ? { request } : {}) };
  }) : [];
  return { ...empty(), text: raw.text, editing: typeof raw.editing === 'string' ? raw.editing : null,
    previewReferences: references(raw.previewReferences),
    attachments: attachments(raw.attachments, assets),
    queued,
    // A restored queue waits for the user, since a prompt that was going out
    // when the page went may have reached the core. Outbox prompts carry their
    // request id, which the core recognises, so a queue of only those goes out
    // by itself once the machine is back.
    paused: !queued.every(item => item.request) };
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

/** Overlay only newer entry revisions, preserving older journals and deletion intent. */
function overlayBackup(key: string, previous: Journal | null): Journal | null {
  const prefix = `${key}:entry:`;
  let data = previous;
  const checkpoint = previous?.updatedAt ?? 0;
  let names: string[];
  try { names = Object.keys(localStorage); } catch { return previous; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      const [section, id] = JSON.parse(name.slice(prefix.length));
      const entry = JSON.parse(localStorage.getItem(name)!);
      if (!['inputs', 'drafts'].includes(section) || typeof id !== 'string' || typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt) || entry.updatedAt <= checkpoint || !('value' in entry)) continue;
      data ??= { inputs: {}, drafts: {} };
      data = { ...data, inputs: { ...data.inputs }, drafts: { ...data.drafts }, updatedAt: Math.max(data.updatedAt ?? 0, entry.updatedAt) };
      const entries = section === 'inputs' ? data.inputs! : data.drafts!;
      if (entry.value === null) delete entries[id]; else entries[id] = entry.value;
    } catch { /* One malformed entry does not hide recoverable inputs. */ }
  }
  return data;
}
