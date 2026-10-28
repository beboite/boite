import { untrack } from 'svelte';
import { APP_LANGUAGES, EXPERIMENT_IDS, previewReferencesError, type Attachment, type PreviewReference, type SentFrom } from '@boite/contracts';
import type { Choice, Draft } from '../store.svelte';
import type { Composer, OutboxRequest } from './composer.svelte';
import type { StoreContext } from './context';
import { strings } from '../strings';
import { readDraftJournal, writeDraftJournal } from '../draft-journal';
import { readyAttachments, unresolvedAssetId, type DraftAttachment } from '../draft-attachments';
import { secureId } from '../secure-id';

export type Input = Composer['composerStates'][string];
/**
 * `parked` orders the drafts a project resumes: the most recently set aside
 * wins. It is a time from `created`, so the order survives a reload.
 */
type SavedDraft = { draft: Draft; choice: Choice | null; input: Input; parked: number };
type Journal = { updatedAt?: number; inputs?: Record<string, unknown>; drafts?: Record<string, unknown> };
type Source = { section: 'inputs' | 'drafts'; id: string; input: Input; draft?: Draft; parked?: number; choice?: Choice | null };
/** One composer as it is now: a thread's box and queue, or a draft with its project and choice. */
export type LiveSource = Source;
type CachedEntry = { section: Source['section']; id: string; value: unknown; serialized: string; updatedAt: number; backedUp: boolean };
const entryKey = (section: Source['section'], id: string) => JSON.stringify([section, id]);
/** A draft's row: its words, and whether it was sent while its machine was away and waits for it, or was refused. */
export type DraftEntry = {
  id: string; projectId: string | null; text: string; active: boolean; queued: 'waiting' | 'starting' | { failed: string } | null;
  /** Its start reached the core once: it may hold the conversation, so the start is retried, never taken back. */
  asked?: true;
};
const empty = (): Input => ({ text: '', attachments: [], queued: [], sending: false, paused: false });
const hasText = (input: Input | undefined) => !!(input?.text || input?.queued.length);
const hasContent = (input: Input | undefined) => hasText(input) || !!(input?.attachments.length || input?.previewReferences?.length);
const vacant = (input: Input | undefined) => !hasContent(input) && !input?.editing && !input?.sending;
const projectKey = (id: string | null) => JSON.stringify(id);
/**
 * A draft's key in the saved map and the journal. Drafts written before a
 * project could hold several are keyed by their project; restoring one makes
 * that key its id, so it keeps its journal entry.
 */
export const draftKey = (draft: Draft) => draft.id ?? projectKey(draft.projectId);
let lastCreated = 0;
/** A creation time no two drafts share, so the newest-first order is total. */
export const created = () => (lastCreated = Math.max(Date.now(), lastCreated + 1));
/** An empty draft of its own. */
const newDraft = (projectId: string | null, worktree: boolean): Draft => ({ id: secureId(), createdAt: created(), projectId, worktree });
/**
 * How long the durable journal waits after the last keystroke. The synchronous
 * backup already holds the text by then; the durable copy is what carries the
 * attachments' bytes, and writing it on every key cloned each picture into
 * IndexedDB and waited on the disk while the user typed.
 */
const DURABLE_DELAY_MS = 800;
/** Typing that never pauses still reaches the durable journal this often. */
const DURABLE_MAX_WAIT_MS = 5000;
/** How long a journal that is slow to open stays quiet before the user is told it cannot save. */
const LATE_JOURNAL_MS = 10_000;
/** Each read waits three seconds on the open: about a minute before giving up. */
const LATE_JOURNAL_ATTEMPTS = 20;
/** The journal timed out rather than refused: the open is still under way. */
const slow = (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError';

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
  /** When the armed timer writes the durable journal. */
  #due = 0;
  /** When `resume` last opened a draft: the open one outranks every draft parked before it. */
  #opened = 0;
  /** Drafts restored from a journal entry without a `choice` field. */
  #choiceUnsaved = new Set<string>();

  constructor(private readonly ctx: StoreContext) {}

  get readable(): boolean { return this.#hydrated && this.#durableReady; }
  /** The journal, or its synchronous backup, has been read into the composers. */
  get hydrated(): boolean { return this.#hydrated; }
  /** This host and data directory's journal key, null before `start`. */
  get storageKey(): string | null { return this.#key; }

  async start(): Promise<void> {
    if (this.#stop) return;
    const s = this.ctx.store;
    this.#key = 'boite.unsent.v1:' + JSON.stringify([s.localCore ? 'local' : s.machineId || s.endpointUrl, s.core?.hostname, s.core?.dataDir]);
    let local;
    try { local = JSON.parse(localStorage.getItem(this.#key) ?? 'null'); } catch { /* Try the durable journal. */ }
    const generation = ++this.#generation;
    try {
      let readable = true, late = false;
      const durable = await readDraftJournal(this.#key).catch((error: unknown) => { readable = false; late = slow(error); return null; }) as Journal | null;
      if (generation !== this.#generation) return;
      this.#durableReady = readable;
      this.#writeFailed = !readable;
      if (!readable && !late) s.error = strings.errors.draftStorage;
      this.#restore(local, durable);
      if (late) void this.#awaitJournal(generation);
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

  /** Restores the journal into vacant inputs: anything typed before it arrived keeps priority. */
  #restore(local: Journal & { incomplete?: boolean } | null | undefined, durable: Journal | null): void {
    const s = this.ctx.store;
    const previous = durable && (durable.updatedAt ?? 0) >= (local?.updatedAt ?? 0) ? durable
      : local?.incomplete && durable ? { ...local, inputs: { ...durable.inputs, ...local.inputs }, drafts: { ...durable.drafts, ...local.drafts } } : local ?? null;
    const data = overlayBackup(this.#key!, previous);
    const assets = journalAssets(durable);
    this.#storedAssetIds = new Set(assets.keys());
    for (const [id, bytes] of assets) this.#assetIds.set(bytes, id);
    this.#resolvePending(assets);
    this.#revision = Math.max(this.#revision, typeof data?.updatedAt === 'number' && Number.isFinite(data.updatedAt) ? data.updatedAt : 0);
    if (!data || typeof data !== 'object') return;
    for (const [id, input] of Object.entries(data.inputs ?? {})) {
      // A record the core settled on this connection is newer than this copy.
      if (this.ctx.sync.claims('inputs', id)) continue;
      const restored = restoreInput(input, assets);
      if (restored && vacant(this.ctx.composer.composerStates[id])) this.ctx.composer.composerStates[id] = restored;
    }
    for (const [key, value] of Object.entries(data.drafts ?? {})) {
      const entry = value as Partial<SavedDraft> | null;
      if (!entry?.draft || (entry.draft.projectId !== null && typeof entry.draft.projectId !== 'string') || this.ctx.sync.claims('drafts', key)) continue;
      const input = restoreInput(entry.input, assets);
      const createdAt = entry.draft.createdAt;
      const parked = typeof entry.parked === 'number' && Number.isFinite(entry.parked) ? entry.parked : 0;
      // The journal key is the id, a legacy project key included.
      if (input && vacant(this.saved[key]?.input)) this.saved[key] = {
        draft: { id: key, projectId: entry.draft.projectId, worktree: entry.draft.worktree === true, worktreeExplicit: true,
          ...(typeof createdAt === 'number' && Number.isFinite(createdAt) ? { createdAt } : {}) },
        choice: savedChoice(entry.choice), input, parked
      };
      // A journal written before drafts kept their choice cannot tell a default from a lost choice.
      if (!('choice' in entry)) this.#choiceUnsaved.add(key);
    }
    // A landing draft nobody wrote in becomes the project's latest saved
    // draft, id included, so one input never shows as two drafts.
    const current = s.draft;
    const saved = current && (this.saved[draftKey(current)] ?? this.#latest(current.projectId));
    if (current && saved && vacant(this.ctx.composer.composerStates.draft)) {
      this.ctx.composer.composerStates.draft = saved.input;
      s.draft = current.worktreeExplicit ? { ...current, id: saved.draft.id, ...(saved.draft.createdAt === undefined ? {} : { createdAt: saved.draft.createdAt }) } : { ...saved.draft };
      if (!s.draftChoice && saved.choice) s.draftChoice = { ...saved.choice };
    }
  }

  /**
   * Gives each attachment kept as an ID while the journal was unread the bytes
   * the journal holds, in inputs that are not vacant and so are not restored.
   * Text and attachments changed meanwhile stay. The cached entry goes: its
   * backup line reads the same without the bytes, so the next checkpoint
   * would keep the bare ID and overwrite the record that holds them.
   */
  #resolvePending(assets: Map<string, string>): void {
    if (!assets.size) return;
    const open = this.ctx.store.draft;
    const inputs = [
      ...Object.entries(this.ctx.composer.composerStates).map(([id, input]) =>
        [id !== 'draft' ? entryKey('inputs', id) : open ? entryKey('drafts', draftKey(open)) : '', input] as const),
      ...Object.entries(this.saved).map(([id, entry]) => [entryKey('drafts', id), entry.input] as const)
    ];
    // Keys first: the open draft and its saved entry can share one input.
    for (const [key, input] of inputs) if (input && pendingFiles(input).some(file => assets.has(unresolvedAssetId(file)!))) this.#entries.delete(key);
    for (const [, input] of inputs) if (input) resolvePending(input, assets);
  }

  /**
   * The journal answered the first read too late. Its open carries on, so the
   * read is tried again; meanwhile the synchronous backup holds what is typed.
   * Only a journal still silent after LATE_JOURNAL_MS, or one that fails, is
   * reported: four Windows CI shells showed "could not save your draft" from
   * their first second while nothing had failed but time. The answer clears
   * only the notice's own toast: never another error, nor one a refused
   * backup raised meanwhile.
   */
  async #awaitJournal(generation: number): Promise<void> {
    const key = this.#key!;
    const s = this.ctx.store;
    let noticed = false;
    const notice = setTimeout(() => {
      if (generation !== this.#generation || this.#durableReady || s.error) return;
      s.error = strings.errors.draftStorage;
      noticed = true;
    }, LATE_JOURNAL_MS);
    try {
      for (let attempt = 1; ; attempt++) {
        let durable: Journal | null;
        try { durable = await readDraftJournal(key) as Journal | null; }
        catch (error) {
          if (generation !== this.#generation) return;
          if (slow(error) && attempt < LATE_JOURNAL_ATTEMPTS) continue;
          throw error;
        }
        if (generation !== this.#generation) return;
        let local;
        try { local = JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { /* The journal alone. */ }
        this.#restore(local, durable);
        this.#durableReady = true;
        this.#writeFailed = false;
        if (noticed && s.error === strings.errors.draftStorage && !this.#backupFailed && !this.#failedEntries.size) s.error = null;
        this.#changed = true;
        this.persist();
        return;
      }
    } catch {
      if (generation === this.#generation) s.error = strings.errors.draftStorage;
    } finally { clearTimeout(notice); }
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
    this.#choiceUnsaved.clear();
    this.saved = {};
  }

  park(): void {
    const s = this.ctx.store;
    if (!s.draft) return;
    const key = draftKey(s.draft);
    const input = this.ctx.composer.composerStates.draft;
    // An incognito draft is never set aside: leaving it lets its words go.
    if (hasContent(input) && !s.draft.incognito) this.saved[key] = { draft: { ...s.draft }, choice: s.draftChoice, input: input!, parked: created() };
    else delete this.saved[key];
  }

  /**
   * Opens a draft in a project, setting the open one aside. `draftId` names a
   * saved draft; `fresh` asks for an empty one, keeping an empty open draft
   * already in that project; otherwise the project's most recently parked
   * draft comes back, else an empty one.
   */
  resume(projectId: string | null, options: { fresh?: boolean; draftId?: string } = {}): void {
    const s = this.ctx.store;
    const open = s.draft;
    if (options.fresh && open && !options.draftId && open.projectId === projectId && vacant(this.ctx.composer.composerStates.draft)) return;
    // The open draft's own row leaves it as it is; a copy, so the composer takes the keyboard as for any draft opened.
    if (open && options.draftId !== undefined && draftKey(open) === options.draftId) { s.draft = { ...open }; return; }
    this.park();
    const saved = options.draftId !== undefined ? this.saved[options.draftId]
      : options.fresh ? undefined : this.#latest(projectId);
    this.ctx.composer.composerStates.draft = saved?.input ?? empty();
    s.draft = saved ? { ...saved.draft }
      : newDraft(projectId, s.projects.some(p => p.id === projectId && p.kind !== 'drafts' && p.repository === true && p.worktreeDefault === true));
    s.draftChoice = saved?.choice ?? null;
    this.#opened = created();
  }

  /** The project of the open or a saved draft, or undefined when no draft has that id. */
  projectOf(id: string): string | null | undefined {
    const open = this.ctx.store.draft;
    return open && draftKey(open) === id ? open.projectId : this.saved[id]?.draft.projectId;
  }

  /** The project's most recently parked draft, then its newest. */
  #latest(projectId: string | null): SavedDraft | undefined {
    let best: SavedDraft | undefined;
    for (const entry of Object.values(this.saved)) {
      if (entry.draft.projectId !== projectId) continue;
      if (!best || entry.parked > best.parked || (entry.parked === best.parked && (entry.draft.createdAt ?? 0) > (best.draft.createdAt ?? 0))) best = entry;
    }
    return best;
  }

  /**
   * Words that met another device's newer ones in the same box: they become a
   * new draft of the project, so neither is lost.
   */
  keepAside(projectId: string | null, box: Pick<Input, 'text' | 'attachments' | 'previewReferences'>): void {
    const draft = newDraft(projectId, false);
    this.saved[draftKey(draft)] = { draft, choice: null, input: { ...empty(), ...box }, parked: created() };
  }

  /** Drops one draft by its key. The open draft's composer is left to the caller. */
  forget(id: string): void { delete this.saved[id]; }
  /** Drops every saved draft of a project. */
  forgetProject(projectId: string | null): void {
    for (const [id, entry] of Object.entries(this.saved)) if (entry.draft.projectId === projectId) delete this.saved[id];
  }

  /**
   * Takes back the prompts a draft queued while its machine was away: the
   * conversation will not start by itself. Their words return to the box,
   * after what it holds, so nothing typed is lost. A start already on its way,
   * or asked once (`start`), is not taken back: sent again under a new id, the
   * same words could make a second conversation beside one the core made.
   */
  unqueue(id: string): void {
    const s = this.ctx.store;
    const input = s.draft && draftKey(s.draft) === id ? this.ctx.composer.composerStates.draft : this.saved[id]?.input;
    if (!input || input.sending || !input.queued.length || input.queued.some(entry => entry.request?.start)) return;
    const taken = input.queued.splice(0);
    input.text = [input.text, ...taken.map(entry => entry.text)].filter(text => text.length > 0).join('\n\n');
    input.attachments = [...input.attachments, ...taken.flatMap(entry => entry.attachments)];
    const references = [...(input.previewReferences ?? []), ...taken.flatMap(entry => entry.previewReferences ?? [])];
    if (references.length) input.previewReferences = references;
    input.paused = false;
    this.persist();
  }

  /**
   * Drops a draft. The open one empties and stays open, in the same project.
   * One whose conversation is being started stays: the core may already hold
   * it, and its prompt goes there (`started` is that start handing it over).
   */
  discard(id: string, options: { started?: boolean } = {}): void {
    const s = this.ctx.store;
    const input = s.draft && draftKey(s.draft) === id ? this.ctx.composer.composerStates.draft : this.saved[id]?.input;
    if (!options.started && input?.sending && input.queued[0]?.request) return;
    delete this.saved[id];
    if (s.draft && draftKey(s.draft) === id) {
      this.ctx.composer.composerStates.draft = empty();
      const { id, createdAt } = newDraft(s.draft.projectId, s.draft.worktree);
      s.draft = { ...s.draft, id, createdAt };
    }
    this.persist();
  }
  async flush(): Promise<boolean> {
    this.persist(); this.#writeNow();
    while (this.#writing) await this.#writing;
    // Without IndexedDB, every entry must have reached its synchronous backup.
    return this.readable && !this.#writeFailed && !this.#failedEntries.size
      && (typeof indexedDB !== 'undefined' || [...this.#entries.values()].every(entry => entry.backedUp));
  }

  /**
   * Every draft with something in it, newest first by creation, so typing
   * never reorders the list. A draft with no project names the drafts project
   * once it exists; before that its project is null. A draft sent while its
   * machine was away says so (`queued`) and shows that prompt until its box
   * holds text of its own.
   */
  get entries(): DraftEntry[] {
    const s = this.ctx.store;
    const rows = new Map<string, DraftEntry & { createdAt: number }>();
    const row = (id: string, projectId: string | null, input: Input, active: boolean, createdAt: number) => {
      const head = input.queued[0]?.request ? input.queued[0] : undefined;
      return { id, projectId, text: input.text || head?.text || '', active, createdAt,
        queued: head?.request?.failed !== undefined ? { failed: head.request.failed } : head && input.sending ? 'starting' as const : head ? 'waiting' as const : null,
        ...(head?.request?.start ? { asked: true as const } : {}) };
    };
    for (const [id, entry] of Object.entries(this.saved)) {
      if (hasContent(entry.input)) rows.set(id, row(id, entry.draft.projectId, entry.input, false, entry.draft.createdAt ?? 0));
    }
    if (s.draft) {
      // The open draft gets a row only once it holds something: an empty one is just the composer.
      const id = draftKey(s.draft);
      const input = this.ctx.composer.composerStates.draft;
      if (!input || !hasContent(input)) rows.delete(id);
      else rows.set(id, row(id, s.draft.projectId, input, true, s.draft.createdAt ?? 0));
    }
    // A draft with no project is sent to the drafts, so it is listed there once they exist.
    const drafts = s.draftsProject?.id ?? null;
    return [...rows.values()]
      .filter(row => row.active || row.projectId === null || s.projects.some(p => p.id === row.projectId && !p.archived))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ createdAt: _createdAt, ...row }) => ({ ...row, projectId: row.projectId ?? drafts }));
  }

  /** Back up new input before hydration; only a readable journal can receive a full checkpoint. */
  persist(key?: string): void {
    if (!this.#key) return;
    this.#collecting = true;
    try {
      if (key !== undefined) {
        const input = this.ctx.composer.composerStates[key];
        if (key === 'draft') {
          const open = this.#openSource();
          if (open) this.#capture(open);
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

  /** Every composer the journal would save, by section and id. */
  localSources(): { section: Source['section']; id: string }[] {
    return this.#sources().map(({ section, id }) => ({ section, id }));
  }

  /** The composer a shared record names, or null when this device has none. */
  liveSource(section: Source['section'], id: string): LiveSource | null {
    if (section === 'inputs') {
      const input = this.ctx.composer.composerStates[id];
      return id !== 'draft' && input ? { section, id, input } : null;
    }
    const open = this.#openSource();
    if (open?.id === id) return open;
    const saved = this.saved[id];
    return saved ? { section, id, input: saved.input, draft: { ...saved.draft }, parked: saved.parked, choice: saved.choice } : null;
  }

  isIncognito(source: Source): boolean { return this.#incognito(source); }

  /** Whether a draft came back from a journal that predates saved choices, so its null choice says nothing. */
  choiceUnsaved(id: string): boolean { return this.#choiceUnsaved.has(id); }

  #sources(): Source[] {
    const sources: Source[] = Object.entries(this.ctx.composer.composerStates)
      .filter(([id]) => id !== 'draft').map(([id, input]) => ({ section: 'inputs', id, input }));
    const drafts = new Map<string, Source>(Object.entries(this.saved).map(([id, entry]) => [id, { section: 'drafts', id, input: entry.input, draft: { ...entry.draft }, parked: entry.parked, choice: entry.choice }]));
    const open = this.#openSource();
    if (open) drafts.set(open.id, open);
    return [...sources, ...drafts.values()];
  }

  #openSource(): Source | null {
    const current = this.ctx.store.draft;
    const input = this.ctx.composer.composerStates.draft;
    if (!current || !input) return null;
    const id = draftKey(current);
    return { section: 'drafts', id, input, draft: { ...current }, parked: Math.max(this.saved[id]?.parked ?? 0, this.#opened), choice: this.ctx.store.draftChoice };
  }

  #removeMissing(sources: Source[]): void {
    const present = new Set(sources.map(source => entryKey(source.section, source.id)));
    for (const key of this.#failedEntries) if (!present.has(key)) this.#failedEntries.delete(key);
    for (const key of this.#entries.keys()) if (!present.has(key)) this.#capture(null, key);
  }

  #capture(source: Source | null, key = source ? entryKey(source.section, source.id) : ''): void {
    if (!this.#key) return;
    try {
      // Nothing typed into an incognito conversation or its draft reaches the device's storage.
      const input = source && hasContent(source.input) && !this.#incognito(source) ? savedInput(source.input, this.#assetId) : null;
      const value = input && source ? source.section === 'drafts' ? { draft: source.draft, input, parked: source.parked ?? 0, choice: source.choice ? $state.snapshot(source.choice) : null } : input : null;
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
        if (!source || !this.#incognito(source)) this.ctx.sync.touched(entry.section, entry.id, value === null);
        // Each atomic entry includes its own revision; null is a deletion tombstone.
        // The old complete v1 backup remains available throughout migration.
        try { localStorage.setItem(`${this.#key}:entry:${key}`, `{"updatedAt":${updatedAt},"value":${serialized}}`); entry.backedUp = true; }
        // Without a journal, or while a late one is still opening, the backup is the only copy.
        catch { if (typeof indexedDB === 'undefined' || (this.#hydrated && !this.#durableReady)) this.ctx.store.error = strings.errors.draftStorage; }
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

  /**
   * The durable journal after a pause in typing, never later than the longest
   * wait. A key only moves the deadline: the armed timer, on firing early,
   * waits out the rest instead of every key clearing and setting a timer.
   */
  #writeLater(): void {
    const now = Date.now();
    if (this.#timer === undefined) this.#waitingSince = now;
    this.#due = now + Math.min(DURABLE_DELAY_MS, Math.max(0, this.#waitingSince + DURABLE_MAX_WAIT_MS - now));
    if (this.#timer === undefined) this.#armWrite();
  }

  #armWrite(): void {
    this.#timer = setTimeout(() => {
      if (Date.now() < this.#due) this.#armWrite();
      else this.#writeNow();
    }, Math.max(0, this.#due - Date.now()));
  }

  #writeNow(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#newAsset = false;
    if (this.#pending) this.#schedule();
  }

  #incognito(source: Source): boolean {
    if (source.section === 'drafts') return source.draft?.incognito === true;
    const s = this.ctx.store;
    return s.openThread?.id === source.id ? s.openThread.incognito === true : s.threads.some(thread => thread.id === source.id && thread.incognito);
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

/** A draft's saved choice, or null for a default or a value that is not one. */
function savedChoice(value: unknown): Choice | null {
  const raw = value as Partial<Choice> | null | undefined;
  return raw && typeof raw === 'object' && typeof raw.providerId === 'string' && typeof raw.accountId === 'string' ? { ...raw } as Choice : null;
}

function savedInput(input: Input, assetId: (bytes: string) => string) {
  const file = (item: Attachment) => ({ kind: item.kind, mimeType: item.mimeType, name: item.name,
    assetId: unresolvedAssetId(item) ?? assetId(item.data), ...(unresolvedAssetId(item) ? {} : { data: item.data }) });
  // `$state.snapshot` hands anything but an object to `structuredClone`, which an absent list costs on every key.
  return { text: input.text, editing: input.editing ?? null, attachments: readyAttachments(input.attachments).map(file),
    previewReferences: input.previewReferences && $state.snapshot(input.previewReferences),
    queued: input.queued.map(item => ({ ...(item.id ? { id: item.id } : {}), ...(item.choice ? { choice: $state.snapshot(item.choice) } : {}),
      ...(item.experiments ? { experiments: [...item.experiments] } : {}), ...(item.sentFrom !== undefined ? { sentFrom: item.sentFrom && { ...item.sentFrom } } : {}),
      text: item.text, attachments: item.attachments.map(file), previewReferences: item.previewReferences && $state.snapshot(item.previewReferences),
      ...(item.request ? { request: $state.snapshot(item.request) } : {}) })) };
}

/** An outbox prompt's request id, choice, refusal and whether it went out, or nothing for a stored value that is not one. */
function outboxRequest(value: unknown): OutboxRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<OutboxRequest>;
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(raw.id)) return undefined;
  const choice = raw.choice && typeof raw.choice === 'object' && typeof raw.choice.providerId === 'string' && typeof raw.choice.accountId === 'string' ? raw.choice : null;
  const start = raw.start && typeof raw.start === 'object' && typeof raw.start.projectId === 'string' && raw.start.projectId.length > 0
    && typeof raw.start.worktree === 'boolean' && typeof raw.start.incognito === 'boolean'
    ? { projectId: raw.start.projectId, worktree: raw.start.worktree, incognito: raw.start.incognito } : null;
  return { id: raw.id, choice, queuedAt: typeof raw.queuedAt === 'number' ? raw.queuedAt : 0, ...(typeof raw.failed === 'string' ? { failed: raw.failed } : {}),
    ...(raw.sent === true ? { sent: true as const } : {}), ...(start ? { start } : {}) };
}

/** The app a queued prompt came from as the core stamped it, null for an unidentified one, nothing for a stored value that is neither. */
function sentFrom(value: unknown): SentFrom | null | undefined {
  if (value === null) return null;
  const raw = value as Partial<SentFrom> | undefined;
  if (!raw || typeof raw !== 'object' || (raw.client !== 'shell' && raw.client !== 'pwa') || (raw.device !== null && typeof raw.device !== 'string')) return undefined;
  return { client: raw.client, device: raw.device, ...(APP_LANGUAGES.includes(raw.language as never) ? { language: raw.language } : {}) };
}

function references(value: unknown): PreviewReference[] {
  return Array.isArray(value) && !previewReferencesError(value) ? value as PreviewReference[] : [];
}

function restoreInput(value: unknown, assets: Map<string, string>): Input | null {
  if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string') return null;
  const raw = value as { text: string; editing?: unknown; queued?: unknown; previewReferences?: unknown; attachments?: unknown };
  const queued: Input['queued'] = Array.isArray(raw.queued) ? raw.queued.filter(item => item && typeof item.text === 'string').map(item => {
    const request = outboxRequest(item.request);
    const id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(item.id) ? item.id : request?.id;
    const choice = item.choice && typeof item.choice === 'object' && typeof item.choice.providerId === 'string' && typeof item.choice.accountId === 'string' ? item.choice as Choice : undefined;
    const experiments = Array.isArray(item.experiments) ? EXPERIMENT_IDS.filter(id => item.experiments.includes(id)) : undefined;
    const origin = sentFrom(item.sentFrom);
    return { ...(id ? { id } : {}), ...(choice ? { choice } : {}), ...(experiments ? { experiments } : {}), ...(origin !== undefined ? { sentFrom: origin } : {}), text: item.text, attachments: attachments(item.attachments, assets), previewReferences: references(item.previewReferences), ...(request ? { request } : {}) };
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

const pendingFiles = (input: Input) => [...input.attachments, ...input.queued.flatMap(item => item.attachments)].filter(file => unresolvedAssetId(file) !== undefined);

function resolvePending(input: Input, assets: Map<string, string>): void {
  const resolve = (files: Attachment[]) => files.map(file => {
    const data = assets.get(unresolvedAssetId(file) ?? '');
    if (data === undefined) return file;
    const { pendingDraftAsset: _id, ...rest } = file as DraftAttachment;
    return { ...rest, data };
  });
  if (input.attachments.some(file => assets.has(unresolvedAssetId(file) ?? ''))) input.attachments = resolve(input.attachments);
  for (const item of input.queued) if (item.attachments.some(file => assets.has(unresolvedAssetId(file) ?? ''))) item.attachments = resolve(item.attachments);
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
