import { checkSettingsPatch, compareModelFavorites, MODEL_FAVORITES_MAX, type Account, type ModelFavorite, type ModelFavorites, type ProviderId, type Settings } from '@boite/contracts';
import { FAVORITES_KEY, readFavorites, type FavoriteModel } from './model-order';

/**
 * The starred models, one list for every machine of the window and every
 * client of the owner. Each core keeps a copy in its settings
 * (`Settings.modelFavorites`); between two copies the later `at` wins, the
 * content breaking a tie, so every client and core settles on the same list.
 */
export const FAVORITES_CACHE_KEY = 'boite.model-favorites.v2';

const EMPTY: ModelFavorites = { at: 0, items: [] };

/** One machine's Store as the shared list sees it. */
export interface FavoritesTarget {
  /** Its core's settings, null until the first read. */
  settings(): Settings | null;
  /** Its core takes `settings.set` from this client now: owner, connected. */
  writable(): boolean;
  /** Stores the list on its core. */
  write(favorites: ModelFavorites): Promise<void>;
  /** Its accounts are read, so an old favorite's account id can be named. */
  accountsReady(): boolean;
  /** The label of this machine's account of that provider, null when it is not here. */
  accountLabel(accountId: string, providerId: ProviderId): string | null;
}

/** The list as a core stores it: trimmed, repeats dropped, unknown keys gone. Null when malformed. */
export function cleanFavorites(value: unknown): ModelFavorites | null {
  if (value === undefined || value === null) return null;
  const checked = checkSettingsPatch({ modelFavorites: value as ModelFavorites });
  return checked.ok ? checked.patch.modelFavorites ?? null : null;
}

function itemKey(item: ModelFavorite): string {
  return JSON.stringify([item.providerId, item.model.id, item.account ?? null]);
}

/** Above zero when `a` wins: the later change, then the greater content, so a tie never flips back. */
export const compareFavorites = compareModelFavorites;

function readCache(): ModelFavorites {
  try { return cleanFavorites(JSON.parse(localStorage.getItem(FAVORITES_CACHE_KEY) ?? 'null')) ?? EMPTY; }
  catch { return EMPTY; }
}

/** Favorites of the first version, by account id. They stay stored until every one has joined the shared list. */
function dropLegacy(): void {
  try { localStorage.removeItem(FAVORITES_KEY); } catch { /* Read-only storage: read again next start, absorbed again. */ }
}

function unite(items: ModelFavorite[], more: ModelFavorite[]): ModelFavorite[] {
  const seen = new Set(items.map(itemKey));
  return [...items, ...more.filter(item => !seen.has(itemKey(item)) && seen.add(itemKey(item)))];
}

export class SharedFavorites {
  current = $state<ModelFavorites>(EMPTY);
  #targets = new Set<FavoritesTarget>();
  /**
   * The list last sent to each machine, and whether it answered. The same list
   * goes again only once the machine holds something older than it: a core that
   * stores it changed keeps its own copy instead of being written in a loop.
   */
  #pushed = new WeakMap<FavoritesTarget, { list: ModelFavorites; done: boolean }>();
  /** Old favorites whose account no machine has named yet. */
  #legacy: FavoriteModel[] = [];
  /** The machines whose list joined ours on arrival, the first start after the old favorites. */
  #joined = new WeakSet<FavoritesTarget>();
  #migrating = false;

  constructor() { this.load(); }

  /** Reads this device's copy again, and the old favorites once. */
  load(): void {
    this.current = readCache();
    this.#legacy = readFavorites();
    this.#migrating = this.#legacy.length > 0;
    this.#joined = new WeakSet();
    this.#pushed = new WeakMap();
  }

  register(target: FavoritesTarget): () => void {
    this.#targets.add(target);
    // A Store attached again may speak to another core than the one written to.
    this.#pushed.delete(target);
    this.sync(target);
    return () => { this.#targets.delete(target); };
  }

  /**
   * A machine read its settings or accounts: the later list wins and the
   * winner goes to every machine still behind. The first start after the old
   * per-device favorites joins each machine's list to them instead, once.
   */
  sync(target: FavoritesTarget): void {
    if (!this.#targets.has(target)) return;
    const settings = target.settings();
    if (settings === null) return;
    const remote = cleanFavorites(settings.modelFavorites) ?? EMPTY;
    if (this.#migrating && !this.#joined.has(target)) {
      this.#joined.add(target);
      const items = unite(this.current.items, remote.items);
      if (items.length > this.current.items.length) this.#change(items);
    }
    if (compareFavorites(remote, this.current) > 0) this.#store(remote);
    if (this.#legacy.length > 0 && target.accountsReady()) this.#absorb(target);
    // Every machine that answers has named what it could: the rest keep their model, on the account the picker uses.
    if (this.#legacy.length > 0 && [...this.#targets].every(each => each.settings() === null || each.accountsReady())) this.#absorb(null);
    this.#spread();
  }

  /** Adds the item, or removes every one given. */
  toggle(add: ModelFavorite | null, remove: ModelFavorite[] = []): void {
    const gone = new Set(remove.map(itemKey));
    const kept = this.current.items.filter(item => !gone.has(itemKey(item)));
    this.#migrating = false;
    this.#change(add ? unite(kept, [add]) : kept);
    this.#spread();
  }

  /** Old favorites whose account `target` names join with its label; with no target, every one left joins unlabelled. */
  #absorb(target: FavoritesTarget | null): void {
    const found: ModelFavorite[] = [];
    this.#legacy = this.#legacy.filter(entry => {
      const label = target ? target.accountLabel(entry.accountId, entry.providerId) : undefined;
      if (label === null) return true;
      found.push({ providerId: entry.providerId, model: { id: entry.model.id, name: entry.model.name }, ...(label ? { account: label } : {}) });
      return false;
    });
    const items = unite(this.current.items, found);
    if (items.length > this.current.items.length) this.#change(items);
    if (this.#legacy.length === 0) dropLegacy();
  }

  #change(items: ModelFavorite[]): void {
    const next = cleanFavorites({ at: Math.max(Date.now(), this.current.at + 1), items: items.slice(-MODEL_FAVORITES_MAX) });
    if (next) this.#store(next);
  }

  #store(favorites: ModelFavorites): void {
    this.current = favorites;
    try { localStorage.setItem(FAVORITES_CACHE_KEY, JSON.stringify(favorites)); }
    catch { /* Keep the list for this session when storage is unavailable. */ }
  }

  #spread(): void {
    const ours = this.current;
    for (const target of this.#targets) {
      const settings = target.settings();
      if (settings === null || !target.writable()) continue;
      const remote = cleanFavorites(settings.modelFavorites) ?? EMPTY;
      if (compareFavorites(ours, remote) <= 0) continue;
      const sent = this.#pushed.get(target);
      if (sent?.list === ours && (!sent.done || remote.at >= ours.at)) continue;
      const entry = { list: ours, done: false };
      this.#pushed.set(target, entry);
      target.write(ours).then(() => { entry.done = true; }, (error: unknown) => {
        // The next read of that machine tries again; nothing retries in a loop.
        if (this.#pushed.get(target) === entry) this.#pushed.delete(target);
        console.warn('saving the favorites on a machine failed', error);
      });
    }
  }
}

export const modelFavorites = new SharedFavorites();

/** One favorite as one machine's picker offers it. */
export interface ResolvedFavorite extends FavoriteModel {
  /** Every shared item shown as this row: unstarring it removes them all. */
  items: ModelFavorite[];
}

/** What resolving a favorite reads of one machine. */
export interface FavoriteMachine {
  providerOn(id: ProviderId): boolean;
  accountsOf(providerId: ProviderId): Account[];
  usableAccountOf(providerId: ProviderId): Account | null;
}

/**
 * The favorites one machine offers. A provider that is off or has no account
 * there offers none. Each runs on the account with the same label, else on
 * the account the picker uses for that provider; two that land on the same
 * account and model make one row, the exact label first.
 */
export function resolveFavorites(items: ModelFavorite[], machine: FavoriteMachine): ResolvedFavorite[] {
  const placed = items.flatMap(item => {
    if (!machine.providerOn(item.providerId)) return [];
    const accounts = machine.accountsOf(item.providerId);
    const exact = item.account === undefined ? undefined : accounts.find(account => account.label === item.account);
    const account = exact ?? machine.usableAccountOf(item.providerId) ?? accounts[0];
    return account ? [{ item, accountId: account.id, exact: exact !== undefined }] : [];
  });
  const rows = new Map<string, ResolvedFavorite>();
  for (const pass of [true, false]) {
    for (const { item, accountId, exact } of placed) {
      if (exact !== pass) continue;
      const key = JSON.stringify([item.providerId, accountId, item.model.id]);
      const row = rows.get(key);
      if (row) row.items.push(item);
      else rows.set(key, { providerId: item.providerId, accountId, model: item.model, items: [item] });
    }
  }
  // The shared order, not the passes' order.
  const order = new Map(items.map((item, index) => [item, index]));
  const first = (row: ResolvedFavorite) => Math.min(...row.items.map(item => order.get(item)!));
  return [...rows.values()].sort((a, b) => first(a) - first(b));
}
