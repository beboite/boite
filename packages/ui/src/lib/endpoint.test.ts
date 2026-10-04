import { beforeEach, describe, expect, test } from 'vitest';
import {
  linkedCore,
  parsePairingLink,
  readEnvironments,
  readStoredEndpoint,
  rememberSession,
  removeBrought,
  removeEnvironment,
  resolveEndpoint,
  storeEndpoint,
  upsertEnvironment
} from './endpoint';
import { refreshLocalEnvironment } from './endpoint';

test('a restarted shell replaces generated local addresses and preserves the paired remote', () => {
  localStorage.clear();
  upsertEnvironment({ url: 'http://127.0.0.1:41001', token: 'old', paired: false, label: 'This computer' });
  upsertEnvironment({ url: 'http://localhost:41002', token: 'older', paired: false, label: 'This computer' });
  upsertEnvironment({ url: 'http://remote.test:3773', token: 'remote', paired: true, label: 'Server' });
  const entries = refreshLocalEnvironment({ url: 'http://127.0.0.1:41003', token: 'new' });
  expect(entries.map(e => e.url)).toEqual(['http://remote.test:3773']);
});

function at(path: string): void {
  window.history.replaceState(null, '', path);
}

describe('resolveEndpoint', () => {
  beforeEach(() => {
    window.localStorage.clear();
    at('/');
  });

  test('a pairing link the user accepts wins, is stored by nobody yet, and leaves the URL clean', async () => {
    at('/?core=http://192.168.1.20:8777&token=abc123&keep=1');
    const asked: string[] = [];

    const endpoint = await resolveEndpoint(false, async (url) => {
      asked.push(url);
      return true;
    });

    expect(asked).toEqual(['http://192.168.1.20:8777']);
    expect(endpoint).toEqual({ url: 'http://192.168.1.20:8777', token: 'abc123', fromLink: true });
    // The store writes it once the core has answered a hello.
    expect(readStoredEndpoint()).toBeNull();
    expect(window.location.search).toBe('?keep=1');
  });

  test('the core pairing link carries the token alone, on its own origin, and asks nothing', async () => {
    at('/?token=abc123');

    const endpoint = await resolveEndpoint();

    expect(endpoint).toEqual({ url: window.location.origin, token: 'abc123', fromLink: true });
    expect(readStoredEndpoint()).toBeNull();
    expect(window.location.search).toBe('');
  });

  test('a grant link is carried in memory, never stored, and stripped from the URL', async () => {
    at('/?grant=onetime');

    const endpoint = await resolveEndpoint();

    expect(endpoint).toEqual({ url: window.location.origin, token: '', grant: 'onetime', fromLink: true });
    expect(readStoredEndpoint()).toBeNull();
    expect(window.location.search).toBe('');
  });

  test('a core link alone to an unknown core keeps the paired core stored and in use when refused', async () => {
    storeEndpoint({ url: 'https://my-core.example', token: 'session-key', paired: true });
    at('/?core=https://other.example');

    const endpoint = await resolveEndpoint(false, async () => false);

    expect(endpoint).toEqual({ url: 'https://my-core.example', token: 'session-key', paired: true });
    expect(readStoredEndpoint()).toEqual({ url: 'https://my-core.example', token: 'session-key', paired: true });
    expect(window.location.search).toBe('');
  });

  test('with nobody to ask, a link to an unknown core is refused', async () => {
    storeEndpoint({ url: 'https://my-core.example', token: 'session-key', paired: true });
    at('/?core=https://other.example&grant=minted-there');

    await expect(resolveEndpoint()).resolves.toEqual({ url: 'https://my-core.example', token: 'session-key', paired: true });
    expect(readStoredEndpoint()).toEqual({ url: 'https://my-core.example', token: 'session-key', paired: true });
  });

  test('a grant link to an unknown core is asked about, and carries its grant once accepted', async () => {
    at('/?core=https://other.example&grant=minted-there');
    const asked: string[] = [];

    const endpoint = await resolveEndpoint(false, async (url) => {
      asked.push(url);
      return true;
    });

    expect(asked).toEqual(['https://other.example']);
    expect(endpoint).toEqual({ url: 'https://other.example', token: '', grant: 'minted-there', fromLink: true });
    expect(readStoredEndpoint()).toBeNull();
  });

  test('a core link alone to a core this device knows reopens it with its key, unasked', async () => {
    storeEndpoint({ url: 'https://my-core.example', token: 'session-key', paired: true });
    upsertEnvironment({ url: 'https://server.example', token: 'server-key', paired: true });
    const ask = async (): Promise<boolean> => {
      throw new Error('a known core is not asked about');
    };

    at('/?core=https://my-core.example/');
    await expect(resolveEndpoint(false, ask)).resolves.toEqual({
      url: 'https://my-core.example',
      token: 'session-key',
      paired: true,
      fromLink: true
    });

    at('/?core=https://server.example');
    await expect(resolveEndpoint(false, ask)).resolves.toEqual({
      url: 'https://server.example',
      token: 'server-key',
      paired: true,
      fromLink: true
    });
    // Following a link wrote nothing: the stored core is still the first one.
    expect(readStoredEndpoint()).toEqual({ url: 'https://my-core.example', token: 'session-key', paired: true });
  });

  test('what a pairing link stored is used next time', async () => {
    storeEndpoint({ url: 'http://10.0.0.5:9000/', token: 'stored' });

    await expect(resolveEndpoint()).resolves.toEqual({
      url: 'http://10.0.0.5:9000',
      token: 'stored'
    });
  });

  test('the page origin is the last resort, with no token', async () => {
    await expect(resolveEndpoint()).resolves.toEqual({
      url: window.location.origin,
      token: ''
    });
  });

  test('in the shell a paired key wins over the core the shell started, and an unpaired one does not', async () => {
    window.__TAURI_INTERNALS__ = {};
    try {
      storeEndpoint({ url: 'http://10.0.0.5:9000', token: 'key', paired: true });
      await expect(resolveEndpoint()).resolves.toEqual({ url: 'http://10.0.0.5:9000', token: 'key', paired: true });

      // No Tauri behind the stub, so the shell's own core answers nothing.
      storeEndpoint({ url: 'http://10.0.0.5:9000', token: 'typed' });
      await expect(resolveEndpoint()).resolves.toBeNull();
    } finally {
      delete window.__TAURI_INTERNALS__;
    }
  });
});

describe('environments', () => {
  beforeEach(() => {
    window.localStorage.clear();
    at('/');
  });

  test('empty when nothing was ever paired or connected', () => {
    expect(readEnvironments()).toEqual([]);
  });

  test('upsert adds with the host as label, keyed by normalised URL', () => {
    upsertEnvironment({ url: 'http://100.64.0.15:3773/', token: 'abc', paired: true });

    expect(readEnvironments()).toEqual([
      { url: 'http://100.64.0.15:3773', label: '100.64.0.15:3773', token: 'abc', paired: true }
    ]);
  });

  test('a second upsert refreshes the key and keeps the label unless renamed', () => {
    upsertEnvironment({ url: 'http://10.0.0.5:9000', token: 'old', paired: true });
    upsertEnvironment({ url: 'http://10.0.0.5:9000/', token: 'new', paired: true });

    expect(readEnvironments()).toEqual([
      { url: 'http://10.0.0.5:9000', label: '10.0.0.5:9000', token: 'new', paired: true }
    ]);

    upsertEnvironment({ url: 'http://10.0.0.5:9000', token: 'new', paired: true, label: 'serveur' });
    expect(readEnvironments()[0]?.label).toBe('serveur');
  });

  test('remove forgets one core and keeps the others', () => {
    upsertEnvironment({ url: 'http://10.0.0.5:9000', token: 'a', paired: true });
    upsertEnvironment({ url: 'http://10.0.0.6:9000', token: 'b', paired: false });

    removeEnvironment('http://10.0.0.5:9000/');

    expect(readEnvironments()).toEqual([
      { url: 'http://10.0.0.6:9000', label: '10.0.0.6:9000', token: 'b', paired: false }
    ]);
  });

  test('a key the group brought keeps its mark, and a pairing link opened on that machine takes the mark away', () => {
    const url = 'http://10.0.0.5:9000';
    rememberSession({ url, token: '', ticket: 't', coreId: 'b', groupId: 'grp' }, 'from-ticket');
    expect(readEnvironments()).toEqual([{ url, label: '10.0.0.5:9000', token: 'from-ticket', paired: true, coreId: 'b', groupId: 'grp' }]);
    // Paired by hand since: the group can no longer drop it.
    rememberSession({ url, token: '', grant: 'g' }, 'from-grant');
    expect(readEnvironments()).toEqual([{ url, label: '10.0.0.5:9000', token: 'from-grant', paired: true }]);
  });

  test('a paired endpoint stored before this list existed seeds one entry', () => {
    storeEndpoint({ url: 'http://10.0.0.5:9000', token: 'key', paired: true });

    expect(readEnvironments()).toEqual([
      { url: 'http://10.0.0.5:9000', label: '10.0.0.5:9000', token: 'key', paired: true }
    ]);
  });

  test('an entry taken out of the list does not come back from the stored endpoint, stripped of where it came from', () => {
    const url = 'http://10.0.0.5:9000';
    storeEndpoint({ url, token: 'key', paired: true });
    rememberSession({ url, token: '', ticket: 't', coreId: 'b', groupId: 'grp' }, 'key');
    removeEnvironment(url);
    expect(readEnvironments()).toEqual([]);
  });

  test('the key the window would open on goes with its entry, unless a newer pairing replaced it', () => {
    const url = 'http://10.0.0.5:9000';
    upsertEnvironment({ url, token: 'old', paired: true });
    upsertEnvironment({ url: 'https://other.test', token: 'kept', paired: true });
    storeEndpoint({ url, token: 'old', paired: true });
    removeEnvironment(url);
    expect(readStoredEndpoint()).toBeNull();
    // Paired anew in another window meanwhile: the stored key is not the one that was forgotten.
    upsertEnvironment({ url, token: 'old', paired: true });
    storeEndpoint({ url, token: 'new', paired: true });
    removeEnvironment(url);
    expect(readStoredEndpoint()).toMatchObject({ url, token: 'new' });
  });

  test('a pairing link on a machine the group brought asks the owner, one on a machine paired by hand does not', async () => {
    const url = 'https://b.example';
    rememberSession({ url, token: '', ticket: 't', coreId: 'b', groupId: 'grp' }, 'from-ticket');
    const asked: string[] = [];
    const approve = async (target: string) => { asked.push(target); return false; };
    // The group brought it: a link, which a removed machine can mint for itself, does not make it the owner's without a yes.
    at('/?core=https%3A%2F%2Fb.example&grant=g');
    expect((await resolveEndpoint(false, approve))?.url).not.toBe(url);
    expect(asked).toEqual([url]);
    expect(readEnvironments()[0]).toMatchObject({ coreId: 'b', groupId: 'grp' });
    // The same for a link that brings a key of its own.
    at('/?core=https%3A%2F%2Fb.example&token=its-own');
    expect((await resolveEndpoint(false, approve))?.url).not.toBe(url);
    expect(asked).toEqual([url, url]);
    // Reopened with the key it holds, no grant: nothing changes hands and nobody is asked.
    at('/?core=https%3A%2F%2Fb.example');
    expect(await resolveEndpoint(false, approve)).toMatchObject({ url, token: 'from-ticket' });
    // Reopened with the very key it holds, written in the link: still the group's machine, marks and all.
    at('/?core=https%3A%2F%2Fb.example&token=from-ticket');
    expect(await resolveEndpoint(false, approve)).toMatchObject({ url, token: 'from-ticket', coreId: 'b', groupId: 'grp' });
    expect(asked).toEqual([url, url]);
    // The marks may sit only with the core the window opens on, the list entry gone: a pairing link asks all the same.
    removeEnvironment(url);
    storeEndpoint({ url, token: 'other-key', paired: true, coreId: 'b', groupId: 'grp' });
    at('/?core=https%3A%2F%2Fb.example&grant=g');
    expect((await resolveEndpoint(false, approve))?.grant).toBeUndefined();
    expect(asked).toEqual([url, url, url]);
    window.localStorage.removeItem('boite.core');
    asked.length = 2;
    // Paired by hand: its own link goes through as before.
    upsertEnvironment({ url: 'https://hand.example', token: 'hand', paired: true });
    at('/?core=https%3A%2F%2Fhand.example&grant=g');
    expect(await resolveEndpoint(false, approve)).toMatchObject({ url: 'https://hand.example', grant: 'g' });
    expect(asked).toEqual([url, url]);
    at('/');
  });

  test('the group\'s mark stays with the core the window opens on, and that core goes with its machine whatever key it holds', () => {
    const url = 'http://10.0.0.5:9000';
    // Two windows each got a key for the same machine of the group: one is the stored core, the other the saved entry.
    storeEndpoint({ url, token: 'first', paired: true, coreId: 'b', groupId: 'grp' });
    expect(readStoredEndpoint()).toEqual({ url, token: 'first', paired: true, coreId: 'b', groupId: 'grp' });
    rememberSession({ url, token: '', ticket: 't', coreId: 'b', groupId: 'grp' }, 'second');
    removeBrought(url, 'b');
    expect(readEnvironments()).toEqual([]);
    expect(readStoredEndpoint()).toBeNull();
    // From then on nothing saved for that address is read, whichever window left it and however it looks.
    storeEndpoint({ url, token: 'left-behind', paired: true });
    upsertEnvironment({ url, token: 'left-behind', paired: true });
    expect(readStoredEndpoint()).toBeNull();
    expect(readEnvironments()).toEqual([]);
    // A new key issued for it ends that: here a pairing made by hand, which is not the group's to take.
    rememberSession({ url, token: '', grant: 'g' }, 'hand');
    storeEndpoint({ url, token: 'hand', paired: true });
    removeBrought(url, 'b');
    expect(readEnvironments()).toEqual([{ url, label: '10.0.0.5:9000', token: 'hand', paired: true }]);
    expect(readStoredEndpoint()).toMatchObject({ token: 'hand' });
    // And so does the group bringing the machine back at that address.
    rememberSession({ url: 'http://10.0.0.6:9000', token: '', ticket: 't', coreId: 'c', groupId: 'grp' }, 'one');
    removeBrought('http://10.0.0.6:9000', 'c');
    rememberSession({ url: 'http://10.0.0.6:9000', token: '', ticket: 't', coreId: 'c', groupId: 'grp' }, 'two');
    expect(readEnvironments().find((env) => env.url === 'http://10.0.0.6:9000')).toMatchObject({ token: 'two', coreId: 'c' });
  });

  test('the core a link names is read before the link is taken, whatever key the link brings', () => {
    at('/?core=http%3A%2F%2F10.0.0.5%3A9000%2F');
    expect(linkedCore()).toBe('http://10.0.0.5:9000');
    at('/?core=http%3A%2F%2F10.0.0.5%3A9000&grant=g');
    expect(linkedCore()).toBe('http://10.0.0.5:9000');
    at('/?core=http%3A%2F%2F10.0.0.5%3A9000&token=t');
    expect(linkedCore()).toBe('http://10.0.0.5:9000');
    at('/?grant=g');
    expect(linkedCore()).toBeNull();
    at('/');
    expect(linkedCore()).toBeNull();
  });

  test('an unpaired stored endpoint and a broken list seed nothing', () => {
    storeEndpoint({ url: 'http://10.0.0.5:9000', token: 'typed' });
    expect(readEnvironments()).toEqual([]);

    window.localStorage.setItem('boite.envs', 'not json');
    expect(readEnvironments()).toEqual([]);
  });
});

describe('parsePairingLink', () => {
  test("a core's own link gives its origin and the grant", () => {
    expect(parsePairingLink('  http://192.168.1.20:8777/?grant=abc  ')).toEqual({
      url: 'http://192.168.1.20:8777',
      grant: 'abc'
    });
  });

  test('a core parameter names the core, whatever served the link', () => {
    expect(parsePairingLink('https://ui.example/app/?core=https://core.example:9000/&grant=abc')).toEqual({
      url: 'https://core.example:9000',
      grant: 'abc'
    });
  });

  test('no grant, no http, or no URL at all is not a pairing link', () => {
    expect(parsePairingLink('http://192.168.1.20:8777/')).toBeNull();
    expect(parsePairingLink('ftp://192.168.1.20/?grant=abc')).toBeNull();
    expect(parsePairingLink('abc')).toBeNull();
  });
});
