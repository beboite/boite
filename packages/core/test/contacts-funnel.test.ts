import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ContactFunnel, funnelPort, type FunnelTiming } from '../src/contacts/funnel.ts';
import { funnelProbe, type FunnelProbe } from '../src/contacts/funnel-check.ts';
import { CONTACT_JOIN_ROUTE } from '../src/contacts/join.ts';
import { CONTACT_LINK_ROUTE } from '../src/contacts/store.ts';
import { ROUTE } from '../src/coordination-wire.ts';
import { strangerAddress } from '../src/server.ts';
import { removeDir, startTestCore, waitFor, type TestCore } from './harness.ts';
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
// Never the internet: every check finds the routes reachable unless a test says otherwise.
const funnel = (probe: FunnelProbe = async () => 'ready', timing?: FunnelTiming) => new ContactFunnel(harness.core, PATHS, () => [process.execPath, FAKE, statePath], probe, timing);
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
  expect(funnelPort({ Web: { [`${DNS}:8443`]: { Handlers: { [ROUTE]: { Proxy: `${target()}${ROUTE}` }, '/': { Proxy: 'http://127.0.0.1:3000' } } } } }, DNS, PATHS, [target()])).toEqual({ port: 10000, missing: PATHS });
  // Nor is one forwarding raw TCP: Tailscale refuses web mounts there.
  expect(funnelPort({ TCP: { '8443': { TCPForward: '127.0.0.1:3000' } } }, DNS, PATHS, [target()])).toEqual({ port: 10000, missing: PATHS });
});

test('a tailnet outside tailscale.com, a node without Funnel or without HTTPS is refused with what to do, and the CLI text never shows', async () => {
  writeState({ status: running('boite.net.example.com') });
  expect(await thrown(funnel().open())).toThrow('needs a tailscale.com tailnet');
  // No name at all is MagicDNS off, not another tailnet.
  writeState({ status: { ...running(), Self: {} } });
  expect(await thrown(funnel().open())).toThrow('turn MagicDNS on');
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

/** The mounts up as an invitation leaves them: recorded, then held no more. */
async function mounted(subject: ContactFunnel): Promise<void> {
  const unhold = subject.hold();
  try { await subject.mount(() => subject.open()); } finally { unhold(); }
}

const recorded = () => harness.core.journal.getSetting('contacts:funnel');
const proxies = () => Object.values(readServe().Web?.[`${DNS}:8443`]?.Handlers ?? {}).map(handler => handler.Proxy).sort();

test('a removal that fails keeps the record, and the next release takes the mounts down', async () => {
  writeState({});
  const subject = funnel();
  await mounted(subject);
  expect(recorded()).toEqual({ targets: [target()] });
  writeState({ serve: readServe(), serveStatusFails: true });
  subject.release();
  await subject.settled();
  expect(recorded()).toEqual({ targets: [target()] });
  expect(proxies()).toHaveLength(PATHS.length);
  writeState({ serve: readServe() });
  subject.release();
  await subject.settled();
  expect(recorded()).toBeNull();
  expect(readServe().Web?.[`${DNS}:8443`]).toBeUndefined();
});

test('a core back on another port moves the mounts a contact dials, and takes down the ones nothing needs', async () => {
  const old = 'http://127.0.0.1:3773';
  const stale = { TCP: { '8443': { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: Object.fromEntries(PATHS.map(path => [path, { Proxy: `${old}${path}` }])) } }, AllowFunnel: { [`${DNS}:8443`]: true } };
  writeState({ serve: stale });
  harness.core.journal.setSetting('contacts:funnel', { targets: [old] });
  const subject = funnel();
  // A contact still hosted: same public port, new target.
  subject.start(true);
  await subject.settled();
  expect(proxies()).toEqual(PATHS.map(path => `${target()}${path}`).sort());
  expect(recorded()).toEqual({ targets: [target()] });
  // Nothing hosted: the old target's mounts come down too.
  writeState({ serve: stale });
  harness.core.journal.setSetting('contacts:funnel', { targets: [old] });
  subject.start(false);
  await subject.settled();
  expect(readServe().Web?.[`${DNS}:8443`]).toBeUndefined();
  expect(recorded()).toBeNull();
});

test('mounts to an older target left on a port this core no longer uses come down once the routes are up elsewhere', async () => {
  const old = 'http://127.0.0.1:3773';
  const foreign = { Proxy: 'http://127.0.0.1:3000' };
  // 8443 now also serves something else: the routes go to 10000 and the old ones must not stay on 8443.
  const handlers = { ...Object.fromEntries(PATHS.map(path => [path, { Proxy: `${old}${path}` }])), '/other': foreign };
  writeState({ serve: { TCP: { '8443': { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: handlers } }, AllowFunnel: { [`${DNS}:8443`]: true } } });
  harness.core.journal.setSetting('contacts:funnel', { targets: [old] });
  const subject = funnel();
  subject.start(true);
  await subject.settled();
  expect(Object.values(readServe().Web![`${DNS}:10000`]!.Handlers).map(handler => handler.Proxy).sort()).toEqual(PATHS.map(path => `${target()}${path}`).sort());
  expect(readServe().Web![`${DNS}:8443`]!.Handlers).toEqual({ '/other': foreign });
  expect(recorded()).toEqual({ targets: [target()] });
});

test('mounts public DNS does not learn go off and on again once, are checked until the internet reaches them, and leave with their state', async () => {
  writeState({});
  const url = `https://${DNS}:8443`;
  const asked: string[] = [];
  // Tailscale publishes the name only once the mounts were turned off and on again.
  const turnedOff = () => calls().some(call => call.startsWith('serve') && call.endsWith('off'));
  const subject = funnel(async (origin, path) => { asked.push(`${origin}${path}`); return turnedOff() ? 'ready' : 'unpublished'; }, { checkMs: 10, repairAfterMs: 60, giveUpMs: 60_000 });
  let changes = 0;
  subject.changed = () => { changes += 1; };
  await mounted(subject);
  subject.watch(url);
  expect(subject.state()).toMatchObject({ url, status: 'checking', checkedAt: null, repaired: false });
  await waitFor(() => subject.state()?.status === 'unpublished');
  await waitFor(() => subject.state()?.status === 'ready');
  expect(subject.state()).toMatchObject({ url, repaired: true });
  expect(calls().filter(call => call.endsWith('off'))).toHaveLength(PATHS.length);
  // The routes came back on the same port, to this core.
  expect(proxies()).toEqual(PATHS.map(path => `${target()}${path}`).sort());
  expect(readServe().AllowFunnel).toEqual({ [`${DNS}:8443`]: true });
  expect(new Set(asked)).toEqual(new Set([`${url}${CONTACT_JOIN_ROUTE}`]));
  // checking, unpublished, checking again after the repair, ready: no event for a check that changed nothing.
  expect(changes).toBe(4);
  const checks = asked.length;
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(asked).toHaveLength(checks);
  subject.release();
  await subject.settled();
  expect(subject.state()).toBeNull();
  // A loopback origin, a test's, is never checked.
  subject.watch('http://127.0.0.1:4000');
  expect(subject.state()).toBeNull();
});

test('a repair that cannot put the mounts back is not reported as one, and the next window tries again on the port it gets', async () => {
  writeState({});
  const edit = (change: (state: Record<string, unknown>) => void) => {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    change(state);
    writeFileSync(statePath, JSON.stringify(state));
  };
  // Mounts that are down are unreachable; once turned off and on again, public DNS knows them, on the port they are on.
  const turnedOff = () => calls().some(call => call.startsWith('serve') && call.endsWith('off'));
  const port = () => Object.keys(readServe().AllowFunnel ?? {})[0]?.split(':')[1];
  const asked: string[] = [];
  const subject = funnel(async origin => {
    asked.push(origin);
    if (!port()) return 'unreachable';
    return turnedOff() && origin.endsWith(`:${port()}`) ? 'ready' : 'unpublished';
  }, { checkMs: 10, repairAfterMs: 300, giveUpMs: 60_000 });
  await mounted(subject);
  edit(state => { state.funnelError = 'Funnel is not available right now'; });
  subject.watch(`https://${DNS}:8443`);
  // The routes came off and could not go back: not repaired, and the probe says so.
  await waitFor(() => subject.state()?.status === 'unreachable');
  expect(subject.state()).toMatchObject({ repaired: false });
  expect(proxies()).toEqual([]);
  // Something else took 8443 meanwhile: the routes come back on 10000, and the checks follow them there.
  edit(state => {
    delete state.funnelError;
    state.serve = { TCP: { '8443': { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
  });
  await waitFor(() => subject.state()?.status === 'ready');
  expect(subject.state()).toMatchObject({ url: `https://${DNS}:10000`, repaired: true });
  expect(asked.at(-1)).toBe(`https://${DNS}:10000`);
  subject.release();
  await subject.settled();
});

test('the internet check reads public DNS, then needs the join route\'s own refusal from a public address', async () => {
  const answers = new Map<string, { status: number; body: string } | null>([
    ['192.0.2.1', null],
    ['192.0.2.2', { status: 403, body: 'x-boite-peer: expected a core id' }],
  ]);
  const asked: string[] = [];
  const probe = (addresses: string[] | null) => funnelProbe(async () => addresses, async (address, host, port, path) => {
    asked.push(`${address} ${host}:${port}${path}`);
    return answers.get(address) ?? { status: 404, body: 'not found' };
  });
  const origin = `https://${DNS}:8443`;
  expect(await probe(null)(origin, CONTACT_JOIN_ROUTE)).toBe('unknown');
  expect(await probe([])(origin, CONTACT_JOIN_ROUTE)).toBe('unpublished');
  expect(await probe(['192.0.2.1', '192.0.2.2'])(origin, CONTACT_JOIN_ROUTE)).toBe('ready');
  expect(asked).toEqual([`192.0.2.1 ${DNS}:8443${CONTACT_JOIN_ROUTE}`, `192.0.2.2 ${DNS}:8443${CONTACT_JOIN_ROUTE}`]);
  // Another server answering on the address is not this core.
  expect(await probe(['192.0.2.3'])(origin, CONTACT_JOIN_ROUTE)).toBe('unreachable');
});
