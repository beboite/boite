import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ContactFunnel, funnelPort } from '../src/contacts/funnel.ts';
import { CONTACT_JOIN_ROUTE } from '../src/contacts/join.ts';
import { CONTACT_LINK_ROUTE } from '../src/contacts/store.ts';
import { ROUTE } from '../src/coordination-wire.ts';
import { strangerAddress } from '../src/server.ts';
import { removeDir, startTestCore, type TestCore } from './harness.ts';
import { rejection, thrown } from './settle.ts';

const FAKE = join(import.meta.dir, 'fixtures', 'fake-tailscale.ts');
const DNS = 'desk.tail0000.ts.net';
const PATHS = [CONTACT_JOIN_ROUTE, CONTACT_LINK_ROUTE, ROUTE];

let harness: TestCore;
let dir: string;
let statePath: string;

const running = (name = DNS) => ({ BackendState: 'Running', Self: { DNSName: `${name}.` }, CertDomains: [name], CurrentTailnet: { MagicDNSEnabled: true } });
const writeState = (state: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ serve: {}, status: running(), ...state }));
const readServe = () => (JSON.parse(readFileSync(statePath, 'utf8')) as { serve: { Web?: Record<string, { Handlers: Record<string, { Proxy: string }> }>; AllowFunnel?: Record<string, boolean>; TCP?: Record<string, unknown> } }).serve;
const calls = () => existsSync(`${statePath}.log`) ? readFileSync(`${statePath}.log`, 'utf8').trim().split('\n').filter(Boolean) : [];
const funnel = () => new ContactFunnel(harness.core, PATHS, () => [process.execPath, FAKE, statePath]);
const target = () => `http://127.0.0.1:${new URL(harness.url).port}`;

beforeEach(async () => {
  harness = await startTestCore();
  dir = mkdtempSync(join(tmpdir(), 'boite-funnel-'));
  statePath = join(dir, 'state.json');
});

afterEach(async () => {
  await harness.stop();
  await removeDir(dir);
});

test('the contact routes, and no other, go on Funnel at 8443; a second open changes nothing and close takes only them down', async () => {
  writeState({ serve: { TCP: { '443': { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: target() } } } } } });
  expect(await funnel().open()).toBe(`https://${DNS}:8443`);
  const serve = readServe();
  expect(Object.keys(serve.Web![`${DNS}:8443`]!.Handlers).sort()).toEqual([...PATHS].sort());
  for (const path of PATHS) expect(serve.Web![`${DNS}:8443`]!.Handlers[path]!.Proxy).toBe(`${target()}${path}`);
  expect(serve.AllowFunnel).toEqual({ [`${DNS}:8443`]: true });
  // The phone's serve on 443 stays as it was, never on the internet.
  expect(serve.Web![`${DNS}:443`]!.Handlers['/']!.Proxy).toBe(target());
  const made = calls().length;
  expect(await funnel().open()).toBe(`https://${DNS}:8443`);
  expect(calls().filter(call => call.startsWith('funnel'))).toHaveLength(PATHS.length);
  expect(calls().length - made).toBe(2);
  await funnel().close();
  expect(readServe().Web?.[`${DNS}:8443`]).toBeUndefined();
  expect(readServe().AllowFunnel?.[`${DNS}:8443`]).toBeUndefined();
  expect(readServe().Web![`${DNS}:443`]!.Handlers['/']!.Proxy).toBe(target());
});

test('a port serving something else is left alone: the mounts take 10000, and with both taken nothing is opened', async () => {
  const other = { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } };
  writeState({ serve: { TCP: { '8443': { HTTPS: true } }, Web: { [`${DNS}:8443`]: other } } });
  expect(await funnel().open()).toBe(`https://${DNS}:10000`);
  expect(readServe().Web![`${DNS}:8443`]).toEqual(other);
  writeState({ serve: { TCP: { '8443': { HTTPS: true }, '10000': { HTTPS: true } }, Web: { [`${DNS}:8443`]: other, [`${DNS}:10000`]: other } } });
  const before = calls().filter(call => call.startsWith('funnel')).length;
  expect(await thrown(funnel().open())).toThrow('already serves something else on ports 8443 and 10000');
  expect(calls().filter(call => call.startsWith('funnel'))).toHaveLength(before);
  // A port carrying these mounts and something else is not this module's either.
  expect(funnelPort({ Web: { [`${DNS}:8443`]: { Handlers: { [ROUTE]: { Proxy: `${target()}${ROUTE}` }, '/': { Proxy: 'http://127.0.0.1:3000' } } } } }, DNS, PATHS, target())).toEqual({ port: 10000, missing: PATHS });
});

test('a tailnet outside tailscale.com, a node without Funnel or without HTTPS is refused with what to do, and the CLI text never shows', async () => {
  writeState({ status: running('boite.net.example.com') });
  expect(await thrown(funnel().open())).toThrow('needs a tailscale.com tailnet');
  writeState({ funnelConsent: 'https://login.tailscale.com/f/funnel?node=abc' });
  const { reason } = await rejection(funnel().open());
  expect(reason).toMatchObject({ data: { actionUrl: 'https://login.tailscale.com/f/funnel?node=abc' } });
  expect(String((reason as Error).message)).toContain('allow it at https://login.tailscale.com/f/funnel?node=abc');
  writeState({ funnelError: 'Funnel not available; "funnel" node attribute not set. See https://tailscale.com/s/no-funnel. auth key tskey-auth-SECRET' });
  const attribute = await thrown(funnel().open());
  expect(attribute).toThrow('"funnel" node attribute');
  expect(String(attribute)).not.toContain('tskey');
  writeState({ status: { ...running(), CertDomains: [] } });
  expect(await thrown(funnel().open())).toThrow('needs HTTPS certificates');
  writeState({ status: null });
  expect(await thrown(funnel().open())).toThrow('Tailscale is not running');
  expect(await thrown(new ContactFunnel(harness.core, PATHS, () => null).open())).toThrow('tailscale command was not found');
});

test('a request Funnel hands over counts under its sender; any other loopback request is this machine\'s own', () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);
  expect(strangerAddress('127.0.0.1', headers({ 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
  expect(strangerAddress('::ffff:127.0.0.1', headers({ 'tailscale-funnel-request': '?1' }))).toBe('funnel');
  expect(strangerAddress('127.0.0.1', headers({ 'x-forwarded-for': '203.0.113.9' }))).toBeNull();
  // A remote peer cannot pick its own address by writing the headers.
  expect(strangerAddress('100.64.0.9', headers({ 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.9' }))).toBe('100.64.0.9');
  expect(strangerAddress(null, headers({}))).toBeNull();
});
