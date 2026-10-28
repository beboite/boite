/**
 * The admin policy (docs/enterprise.md): one test per key, each proving the
 * flow the key forbids is refused with the key named, or never reaches the
 * network, plus the file's own failures. Every core here reads a policy file
 * in a fresh temporary directory, never a machine path.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_ENV, POLICY_KEYS, RpcErrorCode, type AdminPolicy, type PolicyKey } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { runCli } from '../src/cli.ts';
import type { Core } from '../src/core.ts';
import { Bus } from '../src/bus.ts';
import { listenHost, parseFlags, resolveHost } from '../src/main.ts';
import { parseManifest, platformKey } from '../src/plugins/manifest.ts';
import { GATED_METHODS } from '../src/policy-gate.ts';
import { PolicyStore, STRICTEST_POLICY, lockedKeys, machinePolicyFile, parsePolicy, policyFileFor, readPolicy } from '../src/policy.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { DEFAULT_SPEECH } from '../src/speech.ts';
import { Telemetry } from '../src/telemetry.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { rejection } from './settle.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A policy file in its own temporary directory; `write` replaces it as an administrator's editor would. */
function policyFile(policy?: AdminPolicy | string) {
  const dir = mkdtempSync(join(tmpdir(), 'boite-policy-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'policy.json');
  const write = (next: AdminPolicy | string): void => {
    writeFileSync(`${file}.tmp`, typeof next === 'string' ? next : JSON.stringify(next));
    renameSync(`${file}.tmp`, file);
  };
  if (policy !== undefined) write(policy);
  return { file, write, remove: () => rmSync(file, { force: true }) };
}

async function core(policy?: AdminPolicy | string): Promise<{ harness: TestCore; client: CoreClient; policy: ReturnType<typeof policyFile> }> {
  const file = policyFile(policy);
  const harness = await startTestCore({ policyFile: file.file });
  const client = await harness.connect();
  cleanups.push(async () => { client.close(); await harness.stop(); });
  return { harness, client, policy: file };
}

/** The refusal a policy key gives, as a client receives it. */
async function refusedBy(call: Promise<unknown>, key: PolicyKey): Promise<void> {
  const { reason } = await rejection(call);
  expect(reason).toMatchObject({ rpc: { code: RpcErrorCode.Refused, data: { policy: key } } });
  expect((reason as { rpc: { message: string } }).rpc.message).toContain(`key ${key} in `);
}

// ---------------------------------------------------------------------------
// The file

test('the machine location per platform, and BOITE_POLICY_FILE only when the machine has none', () => {
  expect(machinePolicyFile('linux')).toBe('/etc/boite/policy.json');
  expect(machinePolicyFile('darwin')).toBe('/Library/Application Support/Boite/policy.json');
  expect(machinePolicyFile('win32', { ProgramData: 'C:\\ProgramData' })).toBe(join('C:\\ProgramData', 'Boite', 'policy.json'));
  const named = policyFile({ analytics: 'off' });
  // A core given a file reads that one alone.
  expect(policyFileFor(named.file, {})).toBe(named.file);
  // The variable counts only while the machine location holds no file.
  const programData = join(policyFile().file, '..');
  const env = { BOITE_POLICY_FILE: named.file, ProgramData: programData };
  expect(policyFileFor(undefined, env, 'win32')).toBe(named.file);
  mkdirSync(join(programData, 'Boite'));
  writeFileSync(join(programData, 'Boite', 'policy.json'), '{}');
  expect(policyFileFor(undefined, env, 'win32')).toBe(join(programData, 'Boite', 'policy.json'));
});

test('without a file nothing is locked and every flow is the user\'s', async () => {
  const { client, policy } = await core();
  const state = await client.call('policy.get', {});
  expect(state).toMatchObject({ file: policy.file, present: false, locked: [], problems: [], failedClosed: false });
  expect(await client.call('telemetry.configure', { mode: 'enhanced' })).toMatchObject({ mode: 'enhanced' });
});

test('a file that does not parse fails closed: every key at its strictest, the core still answers', async () => {
  const { client, policy } = await core('{ "analytics": "off", ');
  const state = await client.call('policy.get', {});
  expect(state.failedClosed).toBe(true);
  expect(state.values).toEqual(STRICTEST_POLICY);
  // An empty allow list already denies every provider, so the deny list adds nothing.
  expect(state.locked).toEqual([...POLICY_KEYS].filter(key => !['providers.deny', 'gateway.allowedBaseUrls', 'agentBrowser.searchUrl'].includes(key)));
  expect(state.problems).toEqual([expect.objectContaining({ file: policy.file, field: '(file)', expected: 'a JSON object' })]);
  await refusedBy(client.call('diagnostics.issue', {} as never), 'issueReports');
  // Not JSON object at the top level is the same failure.
  expect(parsePolicy('[1, 2]', 'p.json')).toMatchObject({ failedClosed: true, problems: [{ field: '(file)' }] });
});

test('a bad value takes its key\'s strictest value, an unknown key is ignored, and every valid key applies', () => {
  const parsed = parsePolicy(JSON.stringify({ analytics: 'maybe', quotaReads: true, network: { lan: 'no', push: false, wifi: true }, colour: 'red' }), '/x/policy.json');
  expect(parsed.failedClosed).toBe(false);
  expect(parsed.values).toEqual({ analytics: 'off', quotaReads: true, network: { lan: false, push: false } });
  expect(parsed.problems.map(problem => [problem.field, problem.expected])).toEqual([
    ['analytics', '"off" or "basic"'],
    ['network.wifi', expect.stringContaining('network.lan')],
    ['network.lan', 'true or false'],
    ['colour', expect.stringContaining('analytics')],
  ]);
  for (const problem of parsed.problems) expect(problem.message).toStartWith('/x/policy.json: ');
  // A `true` that restricts nothing locks nothing.
  expect(lockedKeys(parsed.values)).toEqual(['analytics', 'network.lan', 'network.push']);
});

test('problems reach the log and the client, naming file, field and expected value', async () => {
  const { harness, client, policy } = await core({ dictation: 'cloud' } as never);
  const state = await client.call('policy.get', {});
  expect(state.problems).toEqual([expect.objectContaining({ file: policy.file, field: 'dictation', expected: '"local" or "off"' })]);
  const logged = await harness.core.logs.query({ source: 'policy' } as never) as { message: string }[];
  expect(logged.map(entry => entry.message).join('\n')).toContain(`${policy.file}: dictation is "cloud"; expected "local" or "off"`);
});

test('an edit of the file applies without a restart and is pushed as policy.changed', async () => {
  const { client, policy } = await core();
  const changed = client.next('policy.changed');
  policy.write({ issueReports: false });
  // The poll every few seconds, or a read, notices; the read is what clients do on reconnect.
  const state = await client.call('policy.get', {});
  expect(state.locked).toEqual(['issueReports']);
  expect((await changed).locked).toEqual(['issueReports']);
  await refusedBy(client.call('diagnostics.issue', {} as never), 'issueReports');
  policy.remove();
  expect((await client.call('policy.get', {})).present).toBe(false);
});

test('the poll notices an edit by itself', async () => {
  const file = policyFile();
  const host = { log: () => {}, changed: () => {} };
  const store = new PolicyStore(file.file, host);
  cleanups.push(() => store.close());
  store.start(20);
  file.write({ pullRequests: false });
  await waitFor(() => store.pullRequestsOff());
});

test('an unreadable path fails closed, a missing one is no policy', () => {
  const dir = policyFile();
  expect(readPolicy(dir.file)).toMatchObject({ present: false, failedClosed: false });
  // A directory where the file should be cannot be read as one.
  expect(readPolicy(join(dir.file, '..'))).toMatchObject({ present: true, failedClosed: true, problems: [{ field: '(file)', expected: 'a readable JSON file' }] });
});

test('every gated method is a registered one, and a paired device may read the policy', async () => {
  const { harness } = await core();
  const registered = new Set(harness.core.router.methods());
  expect(GATED_METHODS.filter(method => !registered.has(method))).toEqual([]);
  expect(registered.has('policy.get')).toBe(true);
  const { DEVICE_METHODS, DEVICE_EVENTS } = await import('@boite/contracts');
  expect(DEVICE_METHODS.has('policy.get')).toBe(true);
  expect(DEVICE_EVENTS.has('policy.changed')).toBe(true);
});

// ---------------------------------------------------------------------------
// One test per key

test('analytics: off sends nothing to the relay, consent and deletions included; basic refuses enhanced', async () => {
  const requests: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-policy-telemetry-'));
  const file = policyFile({ analytics: 'off' });
  const bus = new Bus();
  const host = { dataDir, bus, version: '2.0.0', startedAt: Date.now() } as unknown as Core;
  (host as { policy: PolicyStore }).policy = new PolicyStore(file.file, { log: () => {}, changed: () => {} });
  const telemetry = new Telemetry(host, 'https://relay.example', (async (url: string) => { requests.push(url); return Response.json({ ok: true }); }) as typeof fetch);
  cleanups.push(async () => { await telemetry.close(); bus.dispose(); rmSync(dataDir, { recursive: true, force: true }); });
  telemetry.track('project_added');
  await telemetry.flush();
  expect(telemetry.state().mode).toBe('off');
  expect(requests).toEqual([]);

  const { client } = await core({ analytics: 'basic' });
  await refusedBy(client.call('telemetry.configure', { mode: 'enhanced' }), 'analytics');
  expect(await client.call('telemetry.configure', { mode: 'off' })).toMatchObject({ mode: 'off' });
});

test('updates.app: an update of the app through the core is refused when off', async () => {
  const { client } = await core({ updates: { app: 'off' } });
  await refusedBy(client.call('core.updateEverything', { agents: [], server: null, app: '9.9.9' }), 'updates.app');
  // `check` still lets the user see an update, never install one by itself.
  const settings = await client.call('settings.get', {});
  expect(settings.autoInstallUpdates).toBe(false);
});

test('updates.app: check locks the automatic install off and auto locks it on', async () => {
  const { client, policy } = await core({ updates: { app: 'check' } });
  await refusedBy(client.call('settings.set', { autoInstallUpdates: true }), 'updates.app');
  policy.write({ updates: { app: 'auto' } });
  await client.call('policy.get', {});
  expect((await client.call('settings.get', {})).autoInstallUpdates).toBe(true);
});

test('updates.server: no release check and no install when off', async () => {
  let checks = 0;
  const file = policyFile({ updates: { server: 'off' } });
  const harness = await startTestCore({ policyFile: file.file, serverUpdates: { findOffer: async () => { checks += 1; return null; } } });
  const client = await harness.connect();
  cleanups.push(async () => { client.close(); await harness.stop(); });
  await refusedBy(client.call('core.updateStatus', { refresh: true }), 'updates.server');
  await refusedBy(client.call('core.updateInstall', { version: '9.9.9' }), 'updates.server');
  expect(checks).toBe(0);
  // Reading what is known stays allowed.
  expect(await client.call('core.updateStatus', { refresh: false })).toBeDefined();
});

test('updates.agents: no version check, no update and no automatic update when off', async () => {
  const { harness, client } = await core({ updates: { agents: 'off' } });
  let reads = 0;
  harness.core.updates.npmLatest = async () => { reads += 1; return '99.0.0'; };
  await refusedBy(client.call('providers.updates', { refresh: true }), 'updates.agents');
  await refusedBy(client.call('providers.update', { providerId: 'claude' }), 'updates.agents');
  expect(reads).toBe(0);
  expect((await client.call('settings.get', {})).autoUpdateHarnesses).toBe(false);
  await refusedBy(client.call('settings.set', { autoUpdateHarnesses: true }), 'updates.agents');
});

test('providers.allow: a provider outside the list is off, listed with the key, and runs nothing', async () => {
  const { harness, client, policy } = await core();
  const { threadId } = await echoThread(harness, client);
  policy.write({ providers: { allow: ['claude'] } });
  await client.call('policy.get', {});
  const echo = (await client.call('providers.list', {})).loaded.find(provider => provider.id === 'echo');
  expect(echo).toMatchObject({ enabled: false, policy: { policy: 'providers.allow', file: policy.file } });
  await refusedBy(client.call('providers.setEnabled', { providerId: 'echo', enabled: true }), 'providers.allow');
  const { reason } = await rejection(client.call('turns.start', { threadId, prompt: 'hello', clientRequestId: 'policy-allow' }));
  expect((reason as { rpc: { message: string; data: unknown } }).rpc).toMatchObject({ message: expect.stringContaining('key providers.allow in'), data: { policy: 'providers.allow' } });
});

test('providers.deny: a denied provider is off and its turn is refused naming the key', async () => {
  const { harness, client, policy } = await core();
  const { threadId } = await echoThread(harness, client);
  policy.write({ providers: { deny: ['echo'] } });
  await client.call('policy.get', {});
  expect(harness.core.providers.summary('echo')).toMatchObject({ enabled: false, policy: { policy: 'providers.deny' } });
  const { reason } = await rejection(client.call('turns.start', { threadId, prompt: 'hello', clientRequestId: 'policy-deny' }));
  expect((reason as { rpc: { data: unknown } }).rpc.data).toMatchObject({ policy: 'providers.deny' });
  // The provider stays listed, so the user sees why.
  expect((await client.call('providers.list', {})).loaded.some(provider => provider.id === 'echo')).toBe(true);
});

const PROXY = { enabled: true, kind: 'douane', baseUrl: 'https://douane.example/v1', dashboardUrl: 'https://douane.example/admin/#quotas' } as const;

test('gateway: false refuses the gateway and turns a saved one off without forgetting it', async () => {
  const { client, policy } = await core();
  await client.call('settings.set', { subscriptionProxy: PROXY });
  policy.write({ gateway: false });
  await client.call('policy.get', {});
  expect((await client.call('settings.get', {})).subscriptionProxy?.enabled).toBe(false);
  await refusedBy(client.call('subscriptionProxy.setEnabled', { enabled: true }), 'gateway');
  await refusedBy(client.call('subscriptionProxy.configure', { subscriptionProxy: PROXY }), 'gateway');
  await refusedBy(client.call('subscriptionProxy.movePlan', {}), 'gateway');
  policy.remove();
  await client.call('policy.get', {});
  expect((await client.call('settings.get', {})).subscriptionProxy?.enabled).toBe(true);
});

test('gateway.allowedBaseUrls: only a listed address may serve', async () => {
  const { client } = await core({ gateway: { allowedBaseUrls: ['https://douane.corp.example'] } });
  await refusedBy(client.call('settings.set', { subscriptionProxy: PROXY }), 'gateway.allowedBaseUrls');
  const allowed = { ...PROXY, baseUrl: 'https://douane.corp.example/v1', dashboardUrl: 'https://douane.corp.example/admin/' };
  expect((await client.call('settings.set', { subscriptionProxy: allowed })).subscriptionProxy?.enabled).toBe(true);
  // A prefix match is on path segments, not characters.
  await refusedBy(client.call('settings.set', { subscriptionProxy: { ...PROXY, baseUrl: 'https://douane.corp.example.evil/v1' } }), 'gateway.allowedBaseUrls');
});

test('quotaReads: false sends no account token to a quota endpoint and refuses resets', async () => {
  const { harness, client } = await core({ quotaReads: false });
  const account = harness.core.accounts.add({ providerId: 'claude', label: 'Fixture' });
  const directory = harness.core.accounts.accountEnv(account, harness.core.providers.require('claude'))['CLAUDE_CONFIG_DIR']!;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token' } }));
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({ five_hour: { utilization: 1 } })) as unknown as typeof fetch);
  cleanups.push(() => fetcher.mockRestore());
  const row = (await harness.core.quotas.list()).find(quota => quota.accountId === account.id);
  expect(row).toMatchObject({ status: 'disabled', error: expect.stringContaining('key quotaReads in') });
  expect(fetcher).not.toHaveBeenCalled();
  await refusedBy(client.call('quotas.reset', { accountId: account.id, confirmed: true }), 'quotaReads');
});

test('plugins.install: false refuses installs from the catalog and from a URL', async () => {
  const { harness, client } = await core({ plugins: { install: false } });
  await refusedBy(client.call('plugins.install', { id: 'douane' }), 'plugins.install');
  await refusedBy(client.call('plugins.inspect', { url: 'https://example.test/plugin.git' }), 'plugins.install');
  expect(() => harness.core.plugins.install('douane')).toThrow('key plugins.install in');
});

test('plugins.recommended: false leaves the recommended plugins\' sources unread', async () => {
  const { harness, client } = await core({ plugins: { recommended: false } });
  const store = harness.core.plugins;
  store.recommended = [parseManifest({
    schema: 1, id: 'seat-pool', name: 'Seat pool', version: '1.0.0', executable: 'seat-pool',
    description: 'Switches logins from a saved pool.', homepage: 'https://plugins.example.invalid/seat-pool',
    artifacts: { [platformKey()]: { url: 'https://plugins.example.invalid/seat-pool-1.0.0', sha256: '0'.repeat(64) } },
    provides: { accountPools: { providers: ['opencode'] } },
  }, 'recommended.json[0]')];
  store.updateSources = { 'seat-pool': { url: 'https://updates.example.invalid/seat-pool', ref: 'main' } };
  let reads = 0;
  store.readUpdateSource = async () => { reads += 1; return { commit: 'c'.repeat(40), text: null }; };
  await client.call('plugins.checkUpdates', { id: 'seat-pool' });
  expect(reads).toBe(0);
});

test('issueReports: false refuses the report to GitHub', async () => {
  const { client } = await core({ issueReports: false });
  await refusedBy(client.call('diagnostics.issue', { title: 'Something broke', body: 'details' } as never), 'issueReports');
});

test('dictation: local refuses cloud engines; off refuses dictation and downloads', async () => {
  const cloud = { ...DEFAULT_SPEECH, engine: 'api' } as const;
  const local = await core({ dictation: 'local' });
  await refusedBy(local.client.call('speech.configure', cloud), 'dictation');
  const off = await core({ dictation: 'off' });
  await refusedBy(off.client.call('speech.transcribe', { requestId: 'r1', revision: 'x', audio: '' }), 'dictation');
  await refusedBy(off.client.call('speech.install', {}), 'dictation');
  await refusedBy(off.client.call('speech.configure', { ...cloud, engine: 'local' }), 'dictation');
});

test('previews.remoteResources: false keeps a preview to its own origin', async () => {
  const { harness, client } = await core({ previews: { remoteResources: false } });
  const { threadId } = await echoThread(harness, client);
  mkdirSync(join(harness.dataDir, 'preview'));
  writeFileSync(join(harness.dataDir, 'preview', 'index.html'), '<img src="https://tracker.example/pixel.png">');
  let output = '';
  expect(await runCli(['browse', 'preview/index.html', '--json'], {
    cwd: harness.dataDir, env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
    out: text => output += text, err: () => {},
  })).toBe(0);
  const page = await fetch(JSON.parse(output).url);
  const policy = page.headers.get('content-security-policy') ?? '';
  expect(policy).toContain("default-src 'self' data: blob:");
  expect(policy).toContain("connect-src 'self'");
  await page.arrayBuffer();
});

test('agentBrowser: false refuses the agent browser, CLI included; searchUrl reaches the clients', async () => {
  const { harness, client } = await core({ agentBrowser: false });
  await refusedBy(client.call('browser.command', {} as never), 'agentBrowser');
  const { threadId } = await echoThread(harness, client);
  let error = '';
  const code = await runCli(['browser', 'open', 'https://example.test'], {
    cwd: harness.dataDir, env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
    out: () => {}, err: text => error += text,
  });
  expect(code).not.toBe(0);
  expect(error).toContain('key agentBrowser in');

  const search = await core({ agentBrowser: { searchUrl: 'https://search.corp.example/?q={query}' } });
  expect((await search.client.call('policy.get', {})).values.agentBrowser).toEqual({ searchUrl: 'https://search.corp.example/?q={query}' });
  expect(parsePolicy(JSON.stringify({ agentBrowser: { searchUrl: 'http://plain.example/?q={query}' } }), 'p.json')).toMatchObject({ values: { agentBrowser: false }, problems: [{ field: 'agentBrowser.searchUrl' }] });
});

test('network.lan: false keeps the core on loopback whatever the setting or the command line', async () => {
  expect(resolveHost(parseFlags(['--lan']), { ...DEFAULT_SETTINGS, listenOnLan: true }, true)).toBe('127.0.0.1');
  expect(resolveHost(parseFlags(['--host', '0.0.0.0']), DEFAULT_SETTINGS, true)).toBe('127.0.0.1');
  expect(resolveHost(parseFlags(['--host', '127.0.0.2']), DEFAULT_SETTINGS, true)).toBe('127.0.0.2');
  const { harness, client, policy } = await core();
  await client.call('settings.set', { listenOnLan: true });
  expect(listenHost(harness.core, parseFlags([]))).toBe('0.0.0.0');
  policy.write({ network: { lan: false } });
  await client.call('policy.get', {});
  expect((await client.call('settings.get', {})).listenOnLan).toBe(false);
  // At startup the core reads the file before it picks an address.
  expect(listenHost(harness.core, parseFlags(['--host', '0.0.0.0']))).toBe('127.0.0.1');
  await refusedBy(client.call('settings.set', { listenOnLan: true }), 'network.lan');
  // The user's own choice comes back with the file gone.
  policy.remove();
  await client.call('policy.get', {});
  expect((await client.call('settings.get', {})).listenOnLan).toBe(true);
});

test('network.tailscaleServe: false refuses serving over Tailscale HTTPS', async () => {
  const { client } = await core({ network: { tailscaleServe: false } });
  await refusedBy(client.call('tailscale.enable', {} as never), 'network.tailscaleServe');
});

test('network.groups: false refuses groups and turns the group settings off', async () => {
  const { client } = await core({ network: { groups: false } });
  await refusedBy(client.call('group.create', {} as never), 'network.groups');
  await refusedBy(client.call('group.join', {} as never), 'network.groups');
  expect(await client.call('settings.get', {})).toMatchObject({ groupThreads: false, groupBots: false });
  await refusedBy(client.call('settings.set', { groupThreads: true }), 'network.groups');
});

test('network.contacts: false refuses contacts and the Tailscale API', async () => {
  const { harness, client } = await core({ network: { contacts: false } });
  await refusedBy(client.call('contacts.invite', {} as never), 'network.contacts');
  await refusedBy(client.call('contacts.join', {} as never), 'network.contacts');
  await refusedBy(client.call('contacts.tailscaleKey', { key: 'tskey-api-0123456789abcdef' }), 'network.contacts');
  // A key kept from before reaches no Tailscale API.
  const tailscale = (harness.core.contacts as unknown as { tailscale: { fetcher: typeof fetch } }).tailscale;
  expect(() => tailscale.fetcher('https://api.tailscale.com/api/v2/tailnet/-/keys')).toThrow('key network.contacts in');
});

test('network.push: false refuses subscriptions and sends nothing to those kept', async () => {
  const { harness, client } = await core({ network: { push: false } });
  await refusedBy(client.call('push.subscribe', { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } }), 'network.push');
  await refusedBy(client.call('push.test', {}), 'network.push');
  // A subscription kept from before: delivery stops before the push keys are even read.
  const push = harness.core.push as unknown as { keys: () => Promise<unknown>; deliver: (sessionId: string, payload: object) => Promise<void> };
  const keys = spyOn(push, 'keys');
  await push.deliver('session', { title: 'Turn finished', body: 'done' });
  expect(keys).not.toHaveBeenCalled();
});

test('pullRequests: false runs no gh, links and watches included', async () => {
  const { harness, client, policy } = await core();
  const { threadId } = await echoThread(harness, client);
  policy.write({ pullRequests: false });
  await client.call('policy.get', {});
  await refusedBy(client.call('threads.linkPullRequest', { threadId, url: 'https://github.com/o/r/pull/1' }), 'pullRequests');
  await refusedBy(client.call('threads.watchPullRequest', { threadId }), 'pullRequests');
  // The background discovery and the archive go through the same spawn.
  expect(await rejection(harness.core.pullRequests.gh(threadId, ['pr', 'list']))).toMatchObject({ reason: { message: expect.stringContaining('key pullRequests in') } });
});
