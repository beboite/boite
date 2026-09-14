import { beforeEach, describe, expect, test } from 'vitest';
import { parsePairingLink, readStoredEndpoint, resolveEndpoint, storeEndpoint } from './endpoint';

function at(path: string): void {
  window.history.replaceState(null, '', path);
}

describe('resolveEndpoint', () => {
  beforeEach(() => {
    window.localStorage.clear();
    at('/');
  });

  test('a pairing link wins, is stored, and leaves the URL clean', async () => {
    at('/?core=http://192.168.1.20:8777&token=abc123&keep=1');

    const endpoint = await resolveEndpoint();

    expect(endpoint).toEqual({ url: 'http://192.168.1.20:8777', token: 'abc123' });
    expect(readStoredEndpoint()).toEqual({ url: 'http://192.168.1.20:8777', token: 'abc123' });
    expect(window.location.search).toBe('?keep=1');
  });

  test('the core pairing link carries the token alone, on its own origin', async () => {
    at('/?token=abc123');

    const endpoint = await resolveEndpoint();

    expect(endpoint).toEqual({ url: window.location.origin, token: 'abc123' });
    expect(readStoredEndpoint()).toEqual({ url: window.location.origin, token: 'abc123' });
    expect(window.location.search).toBe('');
  });

  test('a grant link is carried in memory, stored without the grant, and stripped from the URL', async () => {
    at('/?grant=onetime');

    const endpoint = await resolveEndpoint();

    expect(endpoint).toEqual({ url: window.location.origin, token: '', grant: 'onetime' });
    expect(readStoredEndpoint()).toEqual({ url: window.location.origin, token: '' });
    expect(window.location.search).toBe('');
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
