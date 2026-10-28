import { ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, RpcErrorCode, type Attachment, type ComposerAttachment, type ComposerQueuedPrompt, type ComposerRecord, type ComposerValue, type PreviewReference } from '@boite/contracts';
import { RpcFailure, type Client } from '../client';
import { unresolvedAssetId, type DraftAttachment } from '../draft-attachments';
import { bytes } from '../format';
import { secureId } from '../secure-id';
import { fill, strings } from '../strings';
import type { Choice, Draft } from '../store.svelte';
import type { QueuedPrompt } from './composer.svelte';
import type { StoreContext } from './context';
import { draftKey, type Input, type LiveSource } from './drafts.svelte';

type Section = ComposerRecord['section'];
/** A record as the composer holds it: attachments carry their bytes, or a placeholder until they are fetched. */
type Local = { input: Pick<Input, 'text' | 'attachments' | 'previewReferences' | 'queued' | 'paused' | 'editing'>; draft?: Draft; choice?: Choice | null; parked?: number };
/**
 * The last record this device and the core agreed on, by hash: the whole
 * value, the box, the queue and its ids, so a later change on either side is
 * told apart from a stale copy.
 */
type Known = { revision: number; hash: string; box: string; queue: string; ids: string[]; paused: boolean; assets: string[]; draft?: string; prior?: string };
type Meta = { entries: Record<string, Known>; assets: Record<string, string> };

const entryKey = (section: Section, id: string) => JSON.stringify([section, id]);
const parseKey = (key: string) => JSON.parse(key) as [Section, string];
/** Typing waits this long before its record is sent; queuing and clearing go at once. */
const COALESCE_MS = 400;
/** A put that failed for a reason that may pass is tried again after this. */
const RETRY_MS = 5000;

/** A short, stable digest; the core's revisions decide, this only tells local edits from what was synced. */
function digest(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

const references = (refs: PreviewReference[] | undefined) => refs?.length ? $state.snapshot(refs) as PreviewReference[] : undefined;
const boxEmpty = (input: Local['input'] | undefined) => !input || (!input.text && !input.attachments.length && !input.previewReferences?.length);
const hasContent = (local: Local | null) => !!local && (!boxEmpty(local.input) || local.input.queued.length > 0 || !!local.input.editing);
/**
 * The composer records a core keeps for every device of its owner: each
 * thread's box and queue, each draft. The device-local journal stays the
 * offline cache; this class sends only the record that changed, after a short
 * pause in typing, and each attachment once, by the id the core gives its
 * bytes. A core without `composerPersistence` keeps the device-local behaviour.
 */
export class ComposerSync {
  /** True when this core answered that it has no composer records. */
  #refused = $state(false);
  #epoch = 0;
  #client: Client | null = null;
  #listed = false;
  /** Records heard before the list answered, latest per key. */
  #early = new Map<string, ComposerRecord>();
  #known = new Map<string, Known>();
  /** Asset ids the core holds: referenced by a record, uploaded or fetched. */
  #remoteAssets = new Set<string>();
  #dirty = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #inflight = new Set<string>();
  /** A record heard while this device's own put for the same key was on its way. */
  #stashed = new Map<string, ComposerRecord>();
  /** Asset ids by bytes, then by kind, type and name: the core's id covers all four. */
  #assetIds = new Map<string, Map<string, string>>();
  /** Records whose next put asks the core to skip its wait for a tool boundary. */
  #forced = new Set<string>();
  /** The first list after the journal was read: a cache killed mid-write may still hold the record before the last one synced. */
  #startup = false;
  #bytes = new Map<string, string>();
  #fetching = new Map<string, Promise<void>>();
  #byteHashes = new Map<string, string>();
  #meta: Meta = { entries: {}, assets: {} };
  #metaKey: string | null = null;
  /** Queued ids by the thread whose record holds them: a draft the core started hands its queue to that thread. */
  #homes = new Map<string, string>();
  /** Queued ids that left a draft on screen, waiting for the thread that took them. */
  #left = new Map<string, string>();
  constructor(private readonly ctx: StoreContext) {}

  /** The core keeps composer records: queues run there, and this device only syncs. */
  get active(): boolean {
    return !this.#refused && this.ctx.store.core?.features?.composerPersistence === true;
  }

  /**
   * True when the frontend must not deliver this thread's queue itself: the
   * core runs it. Incognito input never leaves the device and keeps the
   * frontend's queue.
   */
  deferred(threadId: string): boolean {
    if (!this.active) return false;
    const s = this.ctx.store;
    const thread = s.openThread?.id === threadId ? s.openThread : s.threads.find(row => row.id === threadId);
    return !thread?.incognito;
  }

  deferredDraft(draft: Draft): boolean { return this.active && !draft.incognito; }

  /** After the journal is read, and again on each reconnect: list, merge, then send what changed offline. */
  async resync(): Promise<void> {
    const client = this.ctx.client;
    if (!client || !this.ctx.drafts.hydrated || this.ctx.store.connection !== 'ready' || !this.active) return;
    const epoch = ++this.#epoch;
    if (this.#client !== client) this.#reset(client);
    this.#listed = false;
    let records: ComposerRecord[];
    try { records = await client.call('composer.list', {}); }
    catch (error) {
      if (epoch !== this.#epoch) return;
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) { this.#refused = true; return; }
      this.#later();
      return;
    }
    if (epoch !== this.#epoch || !this.ctx.currentClient(client, this.ctx.clientGeneration)) return;
    this.#listed = true;
    const listed = new Set<string>();
    for (const record of records) { listed.add(entryKey(record.section, record.id)); this.#receive(record); }
    for (const record of this.#early.values()) this.#receive(record);
    this.#early.clear();
    this.#startup = false;
    // What the core has never seen: this device's unsent input from before, or
    // input cleared offline. Unchanged synced records stay as the core has them.
    for (const key of [...this.#known.keys()]) {
      if (!listed.has(key)) this.#known.delete(key);
      this.#dirty.add(key);
    }
    for (const { section, id } of this.ctx.drafts.localSources()) this.#dirty.add(entryKey(section, id));
    this.#flushSoon(true);
  }

  /** A core's push: another device's edit, the core consuming a queue, or this device's own echo. */
  receive(record: ComposerRecord): void {
    if (!this.active || this.ctx.client !== this.#client) return;
    const key = entryKey(record.section, record.id);
    if (!this.#listed) {
      if ((this.#early.get(key)?.revision ?? -1) < record.revision) this.#early.set(key, record);
      return;
    }
    this.#receive(record);
  }

  /** The journal captured a change to this record. Clearing goes at once; typing waits for a pause. */
  touched(section: Section, id: string, cleared: boolean): void {
    if (!this.active) return;
    this.#dirty.add(entryKey(section, id));
    this.#flushSoon(cleared);
  }

  /** A prompt joined a queue: the core owns it once this put lands, so it goes before the app can close. */
  queued(section: Section, id: string): void {
    if (!this.active) return;
    this.#dirty.add(entryKey(section, id));
    // After the caller's own `emptyBox`, so the record does not hold the prompt twice.
    queueMicrotask(() => this.#flushSoon(true));
  }

  /** Send now: the core skips its wait for a tool boundary. */
  async sendNow(threadId: string): Promise<void> {
    const key = entryKey('inputs', threadId);
    this.#dirty.add(key);
    this.#forced.add(key);
    await this.#flush(key);
  }

  /**
   * True once this connection's list settled the record: the journal, read
   * late, must not put its older copy back into it.
   */
  claims(section: Section, id: string): boolean {
    return this.active && this.#listed && this.#known.has(entryKey(section, id));
  }

  /** The composer on screen fetches the bytes of attachments another device added. */
  watch(): () => void {
    return $effect.root(() => {
      $effect(() => {
        const s = this.ctx.store;
        if (s.connection !== 'ready' || !this.active) return;
        const key = s.openThread ? s.openThread.id : s.draft ? 'draft' : null;
        const input = key === null ? undefined : this.ctx.composer.composerStates[key];
        if (input && [...input.attachments, ...input.queued.flatMap(entry => entry.attachments)].some(file => unresolvedAssetId(file) !== undefined)) {
          this.materialize(input);
        }
      });
    });
  }

  /** Fetches the attachments of one composer when it is on screen or about to send. */
  materialize(input: Local['input'] | undefined): void {
    const client = this.ctx.client;
    if (!input || !client || !this.active) return;
    const ids = new Set<string>();
    for (const file of [...input.attachments, ...input.queued.flatMap(entry => entry.attachments)]) {
      const id = unresolvedAssetId(file);
      if (id && this.#remote(id)) ids.add(id);
    }
    for (const id of ids) void this.#fetch(client, id, input);
  }

  stop(): void {
    this.#epoch++;
    this.#reset(null);
  }

  #reset(client: Client | null): void {
    clearTimeout(this.#timer); clearTimeout(this.#retry);
    this.#timer = this.#retry = undefined;
    this.#client = client;
    this.#refused = false;
    this.#startup = true;
    this.#forced.clear();
    this.#listed = false;
    this.#early.clear(); this.#known.clear(); this.#remoteAssets.clear(); this.#dirty.clear(); this.#inflight.clear(); this.#stashed.clear();
    this.#assetIds.clear(); this.#bytes.clear(); this.#fetching.clear(); this.#byteHashes.clear(); this.#homes.clear(); this.#left.clear();
    this.#metaKey = client && this.ctx.drafts.storageKey ? `${this.ctx.drafts.storageKey}:composer` : null;
    this.#meta = { entries: {}, assets: {} };
    if (!this.#metaKey) return;
    try {
      const saved = JSON.parse(localStorage.getItem(this.#metaKey) ?? 'null') as Meta | null;
      if (saved && typeof saved === 'object') this.#meta = { entries: saved.entries ?? {}, assets: saved.assets ?? {} };
    } catch { /* Without metadata every cached record is merged as if new. */ }
    for (const [key, known] of Object.entries(this.#meta.entries)) {
      this.#known.set(key, known);
      for (const id of known.assets) this.#remoteAssets.add(id);
    }
  }

  #saveMeta(): void {
    if (!this.#metaKey) return;
    const entries: Record<string, Known> = {};
    const used = new Set<string>();
    // A confirmed deletion needs no memory once the device holds nothing there either.
    for (const [key, known] of this.#known) {
      if (known.hash === EMPTY.hash && !this.#dirty.has(key)) continue;
      entries[key] = known;
      for (const id of known.assets) used.add(id);
    }
    const assets: Record<string, string> = {};
    for (const [hash, id] of Object.entries(this.#meta.assets)) if (used.has(id)) assets[hash] = id;
    this.#meta = { entries, assets };
    try { localStorage.setItem(this.#metaKey, JSON.stringify(this.#meta)); } catch { /* The next sync merges instead. */ }
  }

  #remote(assetId: string): boolean { return this.#remoteAssets.has(assetId); }

  #later(): void {
    if (this.#retry !== undefined) return;
    // A list that failed is asked again: until one succeeds, nothing is sent.
    this.#retry = setTimeout(() => { this.#retry = undefined; if (this.#listed) this.#flushSoon(true); else void this.resync(); }, RETRY_MS);
  }

  #flushSoon(now: boolean): void {
    if (!this.#listed || !this.#dirty.size) return;
    if (this.#timer !== undefined && !now) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      for (const key of [...this.#dirty]) void this.#flush(key);
    }, now ? 0 : COALESCE_MS);
  }

  // ---------------------------------------------------------------------------
  // Local and remote forms
  // ---------------------------------------------------------------------------

  #source(key: string): LiveSource | null {
    const [section, id] = parseKey(key);
    return this.ctx.drafts.liveSource(section, id);
  }

  /** Every local read gives legacy queued prompts an identity, including reads after a network wait or during recovery. */
  #localOf(source: LiveSource | null): Local | null {
    if (!source) return null;
    for (const entry of source.input.queued) entry.id ??= entry.request?.id ?? secureId();
    const local: Local = { input: source.input };
    if (source.section === 'drafts') { local.draft = source.draft; local.choice = source.choice; local.parked = source.parked; }
    return hasContent(local) ? local : null;
  }

  /** The id an attachment is known by on the core, if any. */
  #assetOf(file: Attachment): string | undefined {
    const pending = unresolvedAssetId(file);
    if (pending !== undefined) return this.#remote(pending) ? pending : undefined;
    return this.#assetIds.get(file.data)?.get(fileMeta(file)) ?? this.#meta.assets[this.#byteHash(file)];
  }

  #byteHash(file: Pick<Attachment, 'kind' | 'mimeType' | 'name' | 'data'>): string {
    let hash = this.#byteHashes.get(file.data);
    if (hash === undefined) { hash = digest(file.data) + file.data.length.toString(36); this.#byteHashes.set(file.data, hash); }
    return `${hash}:${digest(fileMeta(file))}`;
  }

  #remember(file: Pick<Attachment, 'kind' | 'mimeType' | 'name' | 'data'>, assetId: string): void {
    let ids = this.#assetIds.get(file.data);
    if (!ids) this.#assetIds.set(file.data, ids = new Map());
    ids.set(fileMeta(file), assetId);
    this.#bytes.set(assetId, file.data);
    this.#remoteAssets.add(assetId);
    this.#meta.assets[this.#byteHash(file)] = assetId;
  }

  #fileShape(file: Attachment) {
    const pending = unresolvedAssetId(file);
    return { kind: file.kind, mimeType: file.mimeType, name: file.name ?? null,
      assetId: this.#assetOf(file) ?? (pending !== undefined ? `pending:${pending}` : `local:${this.#byteHash(file)}`) };
  }

  #queueShape(entry: QueuedPrompt): ComposerQueuedPrompt {
    return { id: entry.id ?? '', text: entry.text, attachments: entry.attachments.map(file => this.#fileShape(file)),
      ...(entry.previewReferences?.length ? { previewReferences: references(entry.previewReferences) } : {}),
      ...(entry.afterBoundary ? { afterBoundary: entry.afterBoundary } : {}),
      ...(entry.choice ? { choice: { ...$state.snapshot(entry.choice) } } : {}),
      ...(entry.experiments ? { experiments: [...entry.experiments] } : {}),
      ...(entry.sentFrom !== undefined ? { sentFrom: entry.sentFrom && { ...entry.sentFrom } } : {}),
      ...(entry.request ? { request: $state.snapshot(entry.request) as ComposerQueuedPrompt['request'] } : {}) };
  }

  /** The record a local value reads as, attachments by asset id; unknown files read as local placeholders. */
  #shape(local: Local | null): ComposerValue | null {
    // An empty composer and a deleted record are the same: neither side writes the other back.
    if (!local || !hasContent(local)) return null;
    const { input } = local;
    const value: ComposerValue = { input: {
      text: input.text, attachments: input.attachments.map(file => this.#fileShape(file)),
      ...(input.previewReferences?.length ? { previewReferences: references(input.previewReferences) } : {}),
      queued: input.queued.map(entry => this.#queueShape(entry)), paused: input.paused, editing: input.editing ?? null } };
    if (local.draft) {
      const { id, createdAt, projectId, worktree, worktreeExplicit, incognito } = local.draft;
      value.draft = { ...(id !== undefined ? { id } : {}), ...(createdAt !== undefined ? { createdAt } : {}), projectId, worktree,
        ...(worktreeExplicit ? { worktreeExplicit } : {}), ...(incognito ? { incognito } : {}) };
      value.choice = local.choice ? { ...$state.snapshot(local.choice) } : null;
      value.parked = local.parked ?? 0;
    }
    return value;
  }

  #parts(value: ComposerValue | null): Omit<Known, 'revision'> {
    if (!value) return EMPTY;
    // The journal brings every draft back with its worktree switch set, which changes nothing it would do.
    if (value.draft?.worktreeExplicit) { const { worktreeExplicit: _explicit, ...draft } = value.draft; value = { ...value, draft }; }
    const { text, attachments, previewReferences, editing, queued, paused } = value.input;
    return { hash: digest(JSON.stringify(value)), box: digest(JSON.stringify([text, attachments, previewReferences ?? [], editing ?? null])),
      queue: digest(JSON.stringify(queued)), ids: queued.map(entry => entry.id), paused,
      draft: digest(JSON.stringify(value.draft ? [value.draft, value.choice ?? null] : null)),
      assets: [...attachments, ...queued.flatMap(entry => entry.attachments)].map(file => file.assetId).filter(id => !id.startsWith('local:') && !id.startsWith('pending:')) };
  }

  /** The composer's form of a record: known bytes inline, the rest as placeholders fetched on demand. */
  #toLocal(value: ComposerValue | null): Local | null {
    if (!value) return null;
    const file = (item: ComposerAttachment): Attachment => {
      this.#remoteAssets.add(item.assetId);
      const data = this.#bytes.get(item.assetId);
      const base = { kind: item.kind, mimeType: item.mimeType, name: item.name } as Attachment;
      return data !== undefined ? { ...base, data } : { ...base, data: '', pendingDraftAsset: item.assetId } as DraftAttachment;
    };
    const queued: QueuedPrompt[] = value.input.queued.map(entry => ({ id: entry.id, text: entry.text, attachments: entry.attachments.map(file),
      ...(entry.previewReferences?.length ? { previewReferences: entry.previewReferences } : {}),
      ...(entry.afterBoundary ? { afterBoundary: entry.afterBoundary } : {}),
      ...(entry.choice ? { choice: entry.choice as Choice } : {}),
      ...(entry.experiments ? { experiments: [...entry.experiments] } : {}),
      ...(entry.sentFrom !== undefined ? { sentFrom: entry.sentFrom && { ...entry.sentFrom } } : {}),
      ...(entry.request ? { request: { ...entry.request, choice: entry.request.choice as Choice | null } } : {}) }));
    const local: Local = { input: { text: value.input.text, attachments: value.input.attachments.map(file), previewReferences: value.input.previewReferences ?? [],
      queued, paused: value.input.paused, editing: value.input.editing ?? null } };
    if (value.draft) local.draft = { ...value.draft } as Draft;
    if (value.choice !== undefined) local.choice = value.choice as Choice | null;
    if (value.parked !== undefined) local.parked = value.parked;
    return local;
  }

  #know(key: string, record: ComposerRecord): void {
    const prior = this.#known.get(key)?.hash;
    const known: Known = { revision: record.revision, ...this.#parts(this.#shape(this.#toLocal(record.value))), ...(prior ? { prior } : {}) };
    this.#known.set(key, known);
    for (const entry of record.value?.input.queued ?? []) if (record.section === 'inputs') this.#homes.set(entry.id, record.id);
    this.#saveMeta();
  }

  // ---------------------------------------------------------------------------
  // Receiving
  // ---------------------------------------------------------------------------

  #receive(record: ComposerRecord): void {
    const key = entryKey(record.section, record.id);
    const known = this.#known.get(key);
    // A delayed list or event never takes a newer record back.
    if (known && record.revision < known.revision) return;
    if (known && record.revision === known.revision) {
      // Killed between the sync and the journal's copy: the device still holds the record before it.
      const source = this.#source(key);
      if (!this.#startup || (source && this.ctx.drafts.isIncognito(source))) return;
      const mine = this.#parts(this.#shape(this.#restored(key, source, known, record.value))).hash;
      if (mine !== known.hash && mine === known.prior) this.#apply(key, this.#toLocal(record.value));
      return;
    }
    if (this.#inflight.has(key)) {
      if ((this.#stashed.get(key)?.revision ?? -1) < record.revision) this.#stashed.set(key, record);
      return;
    }
    const source = this.#source(key);
    if (source && this.ctx.drafts.isIncognito(source)) return;
    const base = known ?? EMPTY_KNOWN;
    const local = this.#restored(key, source, known, record.value);
    const mine = this.#parts(this.#shape(local));
    const remote = this.#toLocal(record.value);
    const before = record.section === 'drafts' ? this.#queuedIds(local) : [];
    this.#know(key, record);
    const now = this.#known.get(key)!;
    // Unchanged since the last sync, or a copy from before it that a killed write left: the core's record wins.
    if (mine.hash === base.hash || mine.hash === now.hash || (this.#startup && mine.hash === known?.prior)) {
      if (mine.hash !== now.hash) this.#apply(key, remote);
      this.#dirty.delete(key);
    } else {
      const merged = this.#merge(key, local, base, remote);
      this.#apply(key, merged);
      if (this.#parts(this.#shape(merged)).hash !== now.hash) { this.#dirty.add(key); this.#flushSoon(true); }
      else this.#dirty.delete(key);
    }
    if (record.section === 'drafts') this.#launched(record.id, before, remote);
    else this.#arrived(record);
    this.materialize(this.#onScreen(key));
  }

  /**
   * What the journal could not keep, read from the record this device last
   * synced. The journal keeps no pause: it hands back every ordinary queue
   * paused, in case a prompt was on its way out; once the core accepted each of
   * those prompts, that pause is the journal's and the core's flag stands. Nor
   * did a journal written before drafts kept their model: such a draft takes
   * the record's. Without a synced baseline, or with a prompt the core never
   * accepted, the queue stays paused. What it takes back is written into the
   * composer, so a later put carries it too; the device's composer is returned.
   */
  #restored(key: string, source: LiveSource | null, known: Known | undefined, remote: ComposerValue | null): Local | null {
    const local = this.#localOf(source);
    if (!this.#startup || !local) return local;
    // The pause needs a baseline that saw each prompt accepted; a missing model needs none.
    const accepted = new Set(known?.ids ?? []);
    const unpause = !!known && local.input.paused && !known.paused && !local.input.queued.every(entry => entry.request)
      && local.input.queued.every(entry => entry.request || (entry.id !== undefined && accepted.has(entry.id)));
    const choice = !!local.draft && !local.choice && !!remote?.choice && this.ctx.drafts.choiceUnsaved(draftKey(local.draft));
    if (!unpause && !choice) return local;
    if (unpause) local.input.paused = false;
    if (choice) {
      const id = parseKey(key)[1], s = this.ctx.store, saved = this.ctx.drafts.saved[id];
      if (s.draft && draftKey(s.draft) === id) s.draftChoice = { ...remote!.choice as Choice };
      else if (saved) this.ctx.drafts.saved[id] = { ...saved, choice: { ...remote!.choice as Choice } };
    }
    return this.#localOf(this.#source(key));
  }

  #queuedIds(local: Local | null): string[] { return local?.input.queued.flatMap(entry => entry.id ? [entry.id] : []) ?? []; }

  /** A draft the core started: the thread that took its queue replaces it on screen. */
  #launched(draftId: string, before: string[], after: Local | null): void {
    const remaining = new Set(this.#queuedIds(after));
    for (const id of before) {
      if (remaining.has(id)) continue;
      const home = this.#homes.get(id);
      if (home) { this.#follow(draftId, home); return; }
      this.#left.set(id, draftId);
    }
  }

  #arrived(record: ComposerRecord): void {
    for (const entry of record.value?.input.queued ?? []) {
      const draftId = this.#left.get(entry.id);
      if (draftId === undefined) continue;
      this.#left.delete(entry.id);
      this.#follow(draftId, record.id);
      return;
    }
  }

  #follow(draftId: string, threadId: string): void {
    const s = this.ctx.store;
    if (s.openThread || !s.draft || draftKey(s.draft) !== draftId) return;
    if (!boxEmpty(this.ctx.composer.composerStates.draft)) return;
    void s.open(threadId);
  }

  #onScreen(key: string): Local['input'] | undefined {
    const [section, id] = parseKey(key);
    const s = this.ctx.store;
    if (section === 'inputs') return s.openThread?.id === id ? this.ctx.composer.composerStates[id] : undefined;
    return s.draft && draftKey(s.draft) === id ? this.ctx.composer.composerStates.draft : undefined;
  }

  /**
   * Both sides changed one record. The core's queue wins for what it holds,
   * this device's new prompts follow it, and nothing either side typed is
   * lost: when both boxes changed, the core's box stays and this device's
   * words move to a new draft of the same project. `strict` keeps every
   * queued entry the core has, for a core that refused to drop one it runs.
   */
  #merge(key: string, local: Local | null, base: Omit<Known, 'revision'>, remote: Local | null, strict = false): Local | null {
    const mine = this.#parts(this.#shape(local)), theirs = this.#parts(this.#shape(remote));
    const empty = { text: '', attachments: [], previewReferences: [], queued: [], paused: false, editing: null };
    const l = local?.input ?? empty, r = remote?.input ?? empty;
    let box: Pick<Local['input'], 'text' | 'attachments' | 'previewReferences' | 'editing'> = r;
    let fork = false;
    if (mine.box === theirs.box || mine.box === base.box) box = r;
    else if (theirs.box === base.box || boxEmpty(r)) box = l;
    else if (!boxEmpty(l)) fork = true;
    let queued: QueuedPrompt[];
    const localIds = new Set(this.#queuedIds(local)), remoteIds = new Set(this.#queuedIds(remote));
    if (mine.queue === theirs.queue || mine.queue === base.queue) queued = r.queued;
    else if (!strict && theirs.queue === base.queue) queued = l.queued;
    else {
      // An id the last sync held and the core no longer has was consumed or removed there: never sent again.
      const baseIds = new Set(base.ids);
      queued = [...r.queued.filter(entry => strict || !(baseIds.has(entry.id!) && !localIds.has(entry.id!))),
        ...l.queued.filter(entry => entry.id && !remoteIds.has(entry.id) && !baseIds.has(entry.id))];
    }
    const paused = mine.paused === base.paused ? r.paused : l.paused;
    if (fork) this.#fork(key, local);
    const merged: Local = { input: { text: box.text, attachments: box.attachments, previewReferences: box.previewReferences ?? [], editing: box.editing ?? null, queued, paused } };
    // The draft's project, worktree switch and model merge on their own: the side that changed them wins.
    const meta = !local?.draft || (remote?.draft && mine.draft === base.draft) ? remote : local;
    if (meta?.draft) { merged.draft = meta.draft; merged.choice = meta.choice ?? null; merged.parked = Math.max(local?.parked ?? 0, remote?.parked ?? 0); }
    return hasContent(merged) ? merged : null;
  }

  #fork(key: string, local: Local | null): void {
    if (!local) return;
    const [section, id] = parseKey(key);
    const s = this.ctx.store;
    const projectId = section === 'drafts' ? local.draft?.projectId ?? null
      : (s.openThread?.id === id ? s.openThread : s.threads.find(row => row.id === id))?.projectId ?? null;
    this.ctx.drafts.keepAside(projectId, { text: local.input.text, attachments: [...local.input.attachments],
      previewReferences: [...(local.input.previewReferences ?? [])] });
  }

  /** Writes a record into the composer it belongs to, in place, so an open box keeps its focus and bubbles keep their identity. */
  #apply(key: string, value: Local | null): void {
    const [section, id] = parseKey(key);
    const s = this.ctx.store;
    const states = this.ctx.composer.composerStates;
    const open = section === 'drafts' && !!s.draft && draftKey(s.draft) === id;
    if (section === 'drafts' && !open) {
      if (!value) { this.ctx.drafts.forget(id); return; }
      const saved = this.ctx.drafts.saved[id];
      const input = saved?.input ?? { text: '', attachments: [], queued: [], sending: false, paused: false };
      this.#write(input, value.input);
      this.ctx.drafts.saved[id] = { draft: { ...(value.draft ?? { projectId: null, worktree: false }), id }, choice: value.choice ?? null, input, parked: value.parked ?? 0 };
      return;
    }
    if (open && value?.draft) this.#applyDraft(value);
    const slot = section === 'inputs' ? id : 'draft';
    if (!value && !states[slot]) return;
    const state = states[slot] ??= { text: '', attachments: [], queued: [], sending: false, paused: false };
    this.#write(state, value?.input ?? { text: '', attachments: [], previewReferences: [], queued: [], paused: false, editing: null });
  }

  /** Another device moved the open draft to another project, worktree switch or model: the chips follow. */
  #applyDraft(value: Local): void {
    const s = this.ctx.store;
    const draft = s.draft!, { projectId, worktree, worktreeExplicit } = value.draft!;
    if (draft.projectId !== projectId || draft.worktree !== worktree || !!draft.worktreeExplicit !== !!worktreeExplicit) {
      const { worktreeExplicit: _explicit, ...rest } = draft;
      s.draft = { ...rest, projectId, worktree, ...(worktreeExplicit ? { worktreeExplicit } : {}) };
    }
    if (value.choice !== undefined && JSON.stringify($state.snapshot(s.draftChoice)) !== JSON.stringify(value.choice)) s.draftChoice = value.choice ? { ...value.choice } : null;
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  async #flush(key: string): Promise<void> {
    const client = this.ctx.client;
    if (!client || client !== this.#client || !this.#listed || this.ctx.store.connection !== 'ready' || !this.active) return;
    if (this.#inflight.has(key)) return;
    const source = this.#source(key);
    if (source && this.ctx.drafts.isIncognito(source)) { this.#dirty.delete(key); return; }
    let local = this.#localOf(source);
    const known = this.#known.get(key);
    const files = local ? [...local.input.attachments, ...local.input.queued.flatMap(entry => entry.attachments)] : [];
    // A file still waiting for the journal's bytes has nothing to upload yet: the record waits with it.
    if (files.some(file => unresolvedAssetId(file) !== undefined && !this.#remote(unresolvedAssetId(file)!))) return;
    const sendNow = this.#forced.has(key);
    let value = this.#shape(local);
    if (!sendNow && this.#parts(value).hash === (known?.hash ?? EMPTY.hash)) { this.#dirty.delete(key); return; }
    const epoch = this.#epoch;
    this.#inflight.add(key);
    this.#dirty.delete(key);
    let failed = false;
    const [section, id] = parseKey(key);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.#upload(client, files);
        if (epoch !== this.#epoch) return;
        local = this.#localOf(this.#source(key));
        value = this.#shape(local);
        if (value && [...value.input.attachments, ...value.input.queued.flatMap(entry => entry.attachments)].some(file => file.assetId.startsWith('local:'))) { this.#dirty.add(key); return; }
        const sent = this.#parts(value);
        const expectedRevision = this.#known.get(key)?.revision ?? 0;
        const result = await client.call('composer.put', { section, id, expectedRevision, value, ...(sendNow ? { sendNow: true as const } : {}) });
        if (epoch !== this.#epoch) return;
        const now = this.#localOf(this.#source(key));
        if (result.accepted) {
          if (sendNow) this.#forced.delete(key);
          this.#know(key, result.record);
          const stored = this.#known.get(key)!;
          if (stored.hash === sent.hash) { if (this.#parts(this.#shape(now)).hash !== sent.hash) this.#dirty.add(key); return; }
          // The core stamped a choice or dropped an entry it delivered: its record is what the box shows, with typing since kept.
          const merged = this.#merge(key, now, sent, this.#toLocal(result.record.value));
          this.#apply(key, merged);
          if (this.#parts(this.#shape(merged)).hash !== stored.hash) this.#dirty.add(key);
          return;
        }
        // Refused at the same revision: the core runs an entry this put dropped or changed, and keeps it.
        const strict = result.record.revision === expectedRevision;
        const base = this.#known.get(key) ?? EMPTY_KNOWN;
        this.#know(key, result.record);
        const merged = this.#merge(key, now, base, this.#toLocal(result.record.value), strict);
        this.#apply(key, merged);
        // Nothing left to send, unless Send now still has to reach the core.
        if (!sendNow && this.#parts(this.#shape(merged)).hash === this.#known.get(key)!.hash) return;
      }
      // Still refused: each try merged the core's latest record, so the box holds both sides; it goes again later.
      this.#dirty.add(key);
      failed = true;
      this.#later();
    } catch (error) {
      if (epoch !== this.#epoch) return;
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) { this.#refused = true; return; }
      const details = error instanceof RpcFailure ? error.data as { reason?: unknown; threadId?: unknown } | undefined : undefined;
      if (section === 'inputs' && error instanceof RpcFailure && error.code === RpcErrorCode.NotFound && details?.reason === 'thread-deleted' && details.threadId === id) {
        // A missed permanent-deletion event must not keep an offline cache retrying forever.
        this.#stashed.delete(key); this.#early.delete(key); this.#forced.delete(key);
        this.#apply(key, null);
        this.ctx.drafts.persist(id);
        this.#dirty.delete(key); this.#known.delete(key);
        this.#saveMeta();
        return;
      }
      this.#dirty.add(key);
      if (error instanceof RpcFailure && error.code === RpcErrorCode.InvalidParams && error.message.startsWith('composer.attachments:')) {
        // Past what one message may carry, no retry can fit: the box stays on this device, and the next edit tries again.
        this.ctx.store.error = fill(strings.errors.draftOverLimit, { count: String(ATTACHMENTS_PER_TURN), max: bytes(ATTACHMENTS_TOTAL_MAX_BYTES) });
        failed = true;
        return;
      }
      // A core that restarted dropped the assets nothing referenced: what this device holds the bytes of goes up again.
      if (error instanceof RpcFailure && error.message.includes('assetId') && this.#lost(this.#localOf(this.#source(key)))) return;
      failed = true;
      this.#later();
    } finally {
      // A resync on the same client outdates this answer, not the key: it is free again for the next put.
      if (epoch === this.#epoch || this.#client === client) {
        this.#inflight.delete(key);
        const stashed = this.#stashed.get(key);
        this.#stashed.delete(key);
        // Under a list still on its way, the record waits for it like any early push.
        if (stashed && !this.#listed) { if ((this.#early.get(key)?.revision ?? -1) < stashed.revision) this.#early.set(key, stashed); }
        else if (stashed) this.#receive(stashed);
        // A failed put waits for the retry; typing meanwhile still saves at the usual pause.
        if (this.#dirty.has(key) && !failed) this.#flushSoon(false);
      }
    }
  }

  /** Forgets the ids of the files this device has the bytes of, so the next put uploads them; false when none had one. */
  #lost(local: Local | null): boolean {
    let lost = false;
    for (const file of local ? [...local.input.attachments, ...local.input.queued.flatMap(entry => entry.attachments)] : []) {
      if (unresolvedAssetId(file) !== undefined || !this.#assetOf(file)) continue;
      this.#assetIds.get(file.data)?.delete(fileMeta(file));
      delete this.#meta.assets[this.#byteHash(file)];
      lost = true;
    }
    if (lost) this.#saveMeta();
    return lost;
  }

  /** Each file's bytes once per session, under the id the core derives from them. */
  async #upload(client: Client, files: Attachment[]): Promise<void> {
    for (const file of files) {
      if (unresolvedAssetId(file) !== undefined || this.#assetOf(file) !== undefined) continue;
      const { assetId } = await client.call('composer.asset.put', { attachment: { kind: file.kind, mimeType: file.mimeType, data: file.data, name: file.name } as Attachment });
      this.#remember(file, assetId);
    }
  }

  async #fetch(client: Client, assetId: string, input: Local['input']): Promise<void> {
    if (!this.#bytes.has(assetId)) {
      let pending = this.#fetching.get(assetId);
      if (!pending) {
        const epoch = this.#epoch;
        pending = client.call('composer.asset.get', { assetId }).then(attachment => {
          if (epoch !== this.#epoch) return;
          this.#remember(attachment, assetId);
          // Kept like an upload's, so a restart does not send these bytes back up.
          this.#saveMeta();
        }).catch(() => undefined).finally(() => this.#fetching.delete(assetId));
        this.#fetching.set(assetId, pending);
      }
      await pending;
    }
    const data = this.#bytes.get(assetId);
    if (data === undefined) return;
    const resolve = (files: Attachment[]) => files.map(file => {
      if (unresolvedAssetId(file) !== assetId) return file;
      const { pendingDraftAsset: _id, ...rest } = file as DraftAttachment;
      return { ...rest, data };
    });
    if (input.attachments.some(file => unresolvedAssetId(file) === assetId)) input.attachments = resolve(input.attachments);
    for (const entry of input.queued) if (entry.attachments.some(file => unresolvedAssetId(file) === assetId)) entry.attachments = resolve(entry.attachments);
  }

  /** Copies a record's fields into a live input, keeping attachments and queued entries whose content did not change. */
  #write(state: Input, value: Local['input']): void {
    const files = (list: Attachment[]) => JSON.stringify(list.map(file => this.#fileShape(file)));
    if (state.text !== value.text) state.text = value.text;
    if (files(state.attachments) !== files(value.attachments)) state.attachments = value.attachments;
    const refs = value.previewReferences ?? [];
    if (JSON.stringify(state.previewReferences ?? []) !== JSON.stringify(refs)) state.previewReferences = refs;
    if ((state.editing ?? null) !== (value.editing ?? null)) state.editing = value.editing ?? null;
    if (state.paused !== value.paused) state.paused = value.paused;
    const shape = (entry: QueuedPrompt) => JSON.stringify(this.#queueShape(entry));
    const queued = value.queued.map(entry => { const next = shape(entry); return state.queued.find(old => old.id === entry.id && shape(old) === next) ?? entry; });
    if (queued.length !== state.queued.length || queued.some((entry, at) => entry !== state.queued[at])) state.queued = queued;
  }
}

const fileMeta = (file: Pick<Attachment, 'kind' | 'mimeType' | 'name'>) => JSON.stringify([file.kind, file.mimeType, file.name ?? null]);

const EMPTY: Omit<Known, 'revision'> = { hash: digest('null'), box: digest(JSON.stringify(['', [], [], null])), queue: digest('[]'), ids: [], paused: false, assets: [], draft: digest('null') };
const EMPTY_KNOWN: Known = { revision: 0, ...EMPTY };
