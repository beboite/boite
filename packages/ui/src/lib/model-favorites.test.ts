import { afterEach, expect, test } from 'vitest';
import { checkSettingsPatch, keepLaterFavorites, type Account, type ModelFavorites, type Settings } from '@boite/contracts';
import { FAVORITES_CACHE_KEY, SharedFavorites, resolveFavorites, type FavoritesTarget } from './model-favorites.svelte';
import { FAVORITES_KEY } from './model-order';

afterEach(() => localStorage.clear());

const opus = { id: 'claude-opus-5-5', name: 'Opus 5.5' };
const astra = { id: 'gpt-6-astra', name: 'Astra' };

/** A core as `settings.set` keeps it, counting the writes that reach it. */
function machine(options: { favorites?: ModelFavorites; writable?: boolean; accounts?: Account[]; late?: boolean } = {}) {
  let settings = { warmProcessMinutes: 0, ...(options.favorites ? { modelFavorites: options.favorites } : {}) } as Settings;
  /** A `late` core has not answered `settings.get` yet. */
  let answered = !options.late;
  const writes: ModelFavorites[] = [];
  let shared: SharedFavorites | null = null;
  const target: FavoritesTarget = {
    settings: () => answered ? settings : null,
    writable: () => options.writable !== false,
    write: async (favorites) => {
      writes.push(favorites);
      const checked = checkSettingsPatch({ modelFavorites: favorites });
      if (!checked.ok) throw new Error(checked.message);
      settings = { ...settings, ...keepLaterFavorites(settings, checked.patch) };
      // The core answers, then tells every client: both reach the Store.
      shared?.sync(target);
      shared?.sync(target);
    },
    accountsReady: () => (options.accounts ?? []).length > 0,
    accountLabel: (id, providerId) => options.accounts?.find(a => a.id === id && a.providerId === providerId)?.label ?? null,
  };
  return {
    target, writes,
    get favorites() { return settings.modelFavorites; },
    /** Another client wrote this list: the core's event reaches this one. */
    receive(favorites: ModelFavorites) { settings = { ...settings, modelFavorites: favorites }; shared?.sync(target); },
    /** Its first `settings.get` answers. */
    answer() { answered = true; shared?.sync(target); },
    join(into: SharedFavorites) { shared = into; return into.register(target); },
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the later list wins on every machine, and a list already there is never written again', async () => {
  const shared = new SharedFavorites();
  const behind = machine({ favorites: { at: 10, items: [{ providerId: 'codex', model: astra }] } });
  const ahead = machine({ favorites: { at: 20, items: [{ providerId: 'claude', model: opus, account: 'Pro' }] } });
  const phone = machine({ favorites: { at: 5, items: [] }, writable: false });
  behind.join(shared); ahead.join(shared); phone.join(shared);
  await settle();
  expect(shared.current.at).toBe(20);
  expect(behind.favorites).toEqual(ahead.favorites);
  expect(behind.writes).toHaveLength(1);
  expect(ahead.writes).toHaveLength(0);
  // A paired device reads the list and is never written to.
  expect(phone.writes).toHaveLength(0);

  // A star bumps the time past the newest list seen, even with a clock behind it.
  ahead.receive({ at: Date.now() + 60_000, items: [] });
  await settle();
  const before = shared.current.at;
  shared.toggle({ providerId: 'codex', model: astra });
  await settle();
  expect(shared.current.at).toBeGreaterThan(before);
  expect(ahead.favorites?.items).toEqual([{ providerId: 'codex', model: astra }]);
  expect(behind.favorites).toEqual(ahead.favorites);

  // Echoes of our own write and a stale list arriving late change nothing and write nothing.
  const writes = behind.writes.length + ahead.writes.length;
  behind.receive(shared.current);
  ahead.receive({ at: 1, items: [{ providerId: 'claude', model: opus }] });
  await settle();
  expect(shared.current.items).toEqual([{ providerId: 'codex', model: astra }]);
  expect(ahead.favorites?.at).toBe(shared.current.at);
  // The stale machine gets the later list back once, and only once.
  expect(behind.writes.length + ahead.writes.length).toBe(writes + 1);

  // The same time with other content: both sides settle on the greater one.
  const tie = { at: shared.current.at, items: [{ providerId: 'zzz', model: astra }] };
  behind.receive(tie);
  await settle();
  expect(shared.current).toEqual(tie);
  expect(ahead.favorites).toEqual(tie);
  expect(localStorage.getItem(FAVORITES_CACHE_KEY)).toBe(JSON.stringify(tie));
});

test('a favorite lands on the account with its label on each machine, else the one the picker uses', () => {
  const account = (id: string, providerId: string, label: string, status: Account['status'] = 'ok') => ({ id, providerId, label, status }) as Account;
  const pc = [account('pc-pro', 'claude', 'Pro'), account('pc-perso', 'claude', 'Perso'), account('pc-codex', 'codex', 'Work')];
  const server = [account('srv-out', 'claude', 'Old', 'unauthenticated'), account('srv-perso', 'claude', 'Perso')];
  const on = (accounts: Account[], off: string[] = []) => ({
    providerOn: (id: string) => !off.includes(id),
    accountsOf: (id: string) => accounts.filter(a => a.providerId === id),
    usableAccountOf: (id: string) => accounts.find(a => a.providerId === id && a.status !== 'unauthenticated') ?? null,
  });
  const items = [
    { providerId: 'claude', model: opus, account: 'Pro' },
    { providerId: 'claude', model: opus, account: 'Perso' },
    { providerId: 'codex', model: astra, account: 'Work' },
    { providerId: 'grok', model: { id: 'grok-5', name: 'Grok 5' } },
  ];
  // The PC has both Claude accounts: the same model shows twice, once per account.
  expect(resolveFavorites(items, on(pc)).map(f => [f.providerId, f.accountId, f.model.id])).toEqual([
    ['claude', 'pc-pro', opus.id], ['claude', 'pc-perso', opus.id], ['codex', 'pc-codex', astra.id],
  ]);
  // The server has only Perso: both stars land there as one row, which unstarring removes whole.
  const resolved = resolveFavorites(items, on(server));
  expect(resolved.map(f => [f.providerId, f.accountId, f.model.id])).toEqual([['claude', 'srv-perso', opus.id]]);
  expect(resolved[0]!.items.map(item => item.account)).toEqual(['Perso', 'Pro']);
  // A provider turned off offers none of its favorites.
  expect(resolveFavorites(items, on(pc, ['codex'])).some(f => f.providerId === 'codex')).toBe(false);
});

test('old per-device favorites join the machine lists once, named by their account label, and none is lost', async () => {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([
    { providerId: 'claude', accountId: 'pc-pro', model: opus },
    { providerId: 'codex', accountId: 'gone', model: astra },
  ]));
  const shared = new SharedFavorites();
  // Kept until every old favorite has joined: a window closed before then reads them again.
  expect(localStorage.getItem(FAVORITES_KEY)).not.toBeNull();
  const pc = machine({
    favorites: { at: 50, items: [{ providerId: 'codex', model: astra, account: 'Work' }] },
    accounts: [{ id: 'pc-pro', providerId: 'claude', label: 'Pro', status: 'ok' } as Account],
  });
  pc.join(shared);
  await settle();
  // The account no answering machine names keeps its model, on the account the picker uses.
  expect(shared.current.items).toEqual([
    { providerId: 'codex', model: astra, account: 'Work' },
    { providerId: 'claude', model: opus, account: 'Pro' },
    { providerId: 'codex', model: astra },
  ]);
  expect(localStorage.getItem(FAVORITES_KEY)).toBeNull();
  expect(pc.favorites).toEqual(shared.current);
  expect(pc.writes).toHaveLength(1);
});

test('a star during the first start keeps what a machine answering later adds, and what was unstarred stays off', async () => {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([{ providerId: 'claude', accountId: 'pc-pro', model: opus }]));
  const luna = { id: 'gpt-6-luna', name: 'Luna' };
  const shared = new SharedFavorites();
  const accounts = [{ id: 'pc-pro', providerId: 'claude', label: 'Pro', status: 'ok' } as Account];
  const pc = machine({ favorites: { at: 50, items: [{ providerId: 'codex', model: astra }] }, accounts });
  const server = machine({ favorites: { at: 40, items: [{ providerId: 'codex', model: astra }, { providerId: 'codex', model: luna }] }, accounts, late: true });
  pc.join(shared); server.join(shared);
  await settle();
  // The owner unstars Astra before the server's settings arrive.
  shared.toggle(null, [{ providerId: 'codex', model: astra }]);
  server.answer();
  await settle();
  expect(shared.current.items).toEqual([{ providerId: 'claude', model: opus, account: 'Pro' }, { providerId: 'codex', model: luna }]);
  expect(server.favorites).toEqual(shared.current);
  expect(pc.favorites).toEqual(shared.current);
});
