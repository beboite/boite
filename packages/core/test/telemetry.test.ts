import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bus } from '../src/bus.ts';
import type { Core } from '../src/core.ts';
import { linuxVersion, macosVersion, registerTelemetry, RELAY, relayFor, Telemetry, telemetryEvent, windowsVersion } from '../src/telemetry.ts';
import relay, { buildBatch, type Env } from '../../../telemetry/src/index.ts';
import { enhancedDetails, publicModel } from '../../contracts/src/telemetry.ts';
import { thrown } from './settle.ts';

const cleanups: (() => Promise<void>)[] = [];
test('the core test runner disables the production relay', () => {
  expect(process.env.BOITE_TELEMETRY_URL).toBe('');
});

test('only a release build defaults to the relay, and the runtime override wins', () => {
  expect(relayFor(false, undefined)).toBe('');
  expect(relayFor(true, undefined)).toBe(RELAY);
  expect(relayFor(true, '')).toBe('');
  expect(relayFor(false, 'http://127.0.0.1:9')).toBe('http://127.0.0.1:9');
});

test('every core build inlines the release flag present at build time and only then', async () => {
  const root = join(import.meta.dir, '..');
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
  expect(scripts['build:linux']).toContain('bun run bin/compile.ts ');
  for (const command of [scripts.build, readFileSync(join(root, 'bin', 'compile.ts'), 'utf8')]) {
    expect(command).toContain('--env=BOITE_RELEASE_*');
  }
  // The CLI, as the build scripts run it: Bun.build reads the environment its process started with.
  const bundle = (release: string | undefined) => {
    const { BOITE_RELEASE_TELEMETRY: _, ...env } = process.env;
    const result = Bun.spawnSync([process.execPath, 'build', join(root, 'src', 'telemetry.ts'), '--target', 'bun', '--env=BOITE_RELEASE_*'], {
      env: release === undefined ? env : { ...env, BOITE_RELEASE_TELEMETRY: release }, windowsHide: true,
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  expect(bundle(undefined)).toContain('process.env.BOITE_RELEASE_TELEMETRY');
  expect(bundle('1')).not.toContain('process.env.BOITE_RELEASE_TELEMETRY');
});

test('enhanced normalization preserves canonical defaults across host and relay', () => {
  const event = enhancedDetails({});
  expect(event).toMatchObject({ effort: 'default', speed: 'default', permission_mode: 'default' });
  expect(enhancedDetails({ permission_mode: 'private' }).permission_mode).toBe('other');
  expect(enhancedDetails(event as Record<string, unknown>)).toEqual(event);
  expect(publicModel('anthropic/claude-sonnet-4-5-20250929[1m]')).toBe('claude-sonnet-4-5');
});

test('public models follow families and Boite provider prefixes', () => {
  // Selections as Boite stores them; a frozen list reported all of these as `other`.
  for (const [selected, reported] of <[string, string][]>[
    ['claude/claude-opus-5-5', 'claude-opus-5-5'], ['claude-haiku-5-5', 'claude-haiku-5-5'],
    ['codex/gpt-6.1-sol', 'gpt-6.1-sol'], ['grok-4.7', 'grok-4.7'],
    ['opencode/openrouter/deepseek-v4', 'deepseek-v4'], ['opus', 'opus'],
    ['antigravity/gemini-3.8-flash-high', 'gemini-3.8-flash'], ['antigravity/claude-opus-4-6-thinking', 'claude-opus-4-6'],
  ]) expect(publicModel(selected)).toBe(reported);
  for (const hidden of ['ft:gpt-4o:acme:secret', 'gpt-6-acme', 'C:\\models\\gpt-5.gguf', 'claude-opus-5-internal', 'my-proxy/acme-coder'])
    expect(publicModel(hidden)).toBe('other');
});

test('the OS version comes from fixed system fields and the relay bounds its shape', () => {
  // Windows 11 keeps "Windows 10" in the registry's product name; the build decides.
  expect(windowsVersion('Windows 10 Pro', '10.0.26200')).toBe('Windows 11 Pro 26200');
  expect(windowsVersion('Windows 10 Home', '10.0.19045')).toBe('Windows 10 Home 19045');
  expect(windowsVersion('Windows 11 Pro', '10.0.26200')).toBe('Windows 11 Pro 26200');
  expect(windowsVersion('C:\\Users\\nuno', '10.0.26200')).toBe('Windows 26200');
  // PRETTY_NAME is free text a distribution writes; ID and VERSION_ID are identifiers.
  expect(linuxVersion('PRETTY_NAME="Ubuntu 24.04.3 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n')).toBe('ubuntu 24.04');
  expect(linuxVersion('NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n')).toBe('arch');
  expect(linuxVersion('ID="my secret distro"\n')).toBe('linux');
  expect(macosVersion('<key>ProductName</key>\n\t<string>macOS</string>\n\t<key>ProductVersion</key>\n\t<string>15.1</string>')).toBe('macOS 15.1');
  expect(macosVersion('')).toBe('macOS');
  expect(telemetryEvent('ping', '2.0.0').os_version).toMatch(/^[A-Za-z][\w .+()-]{0,47}$/);
  const ids = { eventIdentifier: 'daily', pingIdentifier: 'stable' };
  const sent = (os_version: unknown) => buildBatch('A', [{ ...telemetryEvent('ping', '2.0.0'), os_version } as any], ids, 'FR', new Date().toISOString())[0]!.properties.os_version;
  expect(sent('Windows 11 Pro 26200')).toBe('Windows 11 Pro 26200');
  expect(sent('/home/nuno/.secret')).toBe('other');
  expect(sent('x'.repeat(200))).toBe('other');
  // A host older than the field sends none: the property stays absent, not `other`.
  expect(sent(undefined)).toBeUndefined();
});

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture(respond: (path: string, body: any) => Promise<Response> = async () => Response.json({ ok: true })) {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-telemetry-'));
  const bus = new Bus();
  const requests: { path: string; body: any }[] = [];
  const host = { dataDir, bus, version: '2.0.0-beta.1', startedAt: Date.now() } as Core;
  const send = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    requests.push({ path, body });
    return respond(path, body);
  }) as typeof fetch;
  const telemetry = new Telemetry(host, 'https://relay.example', send);
  cleanups.push(async () => { await telemetry.close(); bus.dispose(); rmSync(dataDir, { recursive: true, force: true }); });
  return { telemetry, requests, dataDir, bus, host, send };
}

test('fresh hosts use basic counters and an explicit opt-out persists across restarts', async () => {
  const { telemetry, requests, host, send } = fixture();
  expect(telemetry.state().mode).toBe('basic');
  await telemetry.flush();
  expect(requests[0]!.body.mode).toBe('A');
  await telemetry.configure('off');
  requests.length = 0;
  telemetry.track('project_added');
  await telemetry.flush();
  await telemetry.close();
  expect(requests).toEqual([]);
  expect(telemetry.state().mode).toBe('off');
  const restarted = new Telemetry(host, 'https://relay.example', send);
  await restarted.close();
  expect(restarted.state().mode).toBe('off');
  expect(requests).toEqual([]);
});

test('invalid relay URLs name the configuration field without echoing its value', () => {
  const f = fixture();
  expect(() => new Telemetry(f.host, 'INVALID PRIVATE URL', f.send)).toThrow('BOITE_TELEMETRY_URL: expected a valid URL');
});

test('invalid consent fails closed with repair guidance and preserves the deletion ledger', async () => {
  const f = fixture();
  await f.telemetry.close();
  f.requests.length = 0;
  const file = join(f.dataDir, 'telemetry.json');
  for (const text of ['{"forget":[', JSON.stringify({ mode: 'invalid', forget: [crypto.randomUUID()] }), 'null']) {
    writeFileSync(file, text);
    expect(() => new Telemetry(f.host, 'https://relay.example', f.send)).toThrow('telemetry.json: cannot load consent');
    expect(() => new Telemetry(f.host, 'https://relay.example', f.send)).toThrow('docs/analytics.md');
    expect(readFileSync(file, 'utf8')).toBe(text);
  }
  expect(f.requests).toEqual([]);
});

test('basic counts are bounded, RAM-only, and drop arbitrary event fields', async () => {
  const { telemetry, requests, dataDir } = fixture();
  await telemetry.configure('basic');
  for (let i = 0; i < 250; i++) telemetry.track('thread_spawned', { provider: 'private-provider', prompt: 'SECRET', path: 'PRIVATE' });
  await telemetry.flush();
  expect(requests[0]!.body.events).toHaveLength(200);
  expect(requests[0]!.body.mode).toBe('A');
  expect(JSON.stringify(requests)).not.toContain('SECRET');
  expect(JSON.stringify(requests)).not.toContain('PRIVATE');
  expect(requests[0]!.body.events[0].provider).toBe('other');
  expect(readFileSync(join(dataDir, 'telemetry.json'), 'utf8')).not.toContain('thread_spawned');
});

test('retry keeps event UUIDs and opting out discards failed batches', async () => {
  let fail = true;
  const { telemetry, requests } = fixture(async () => Response.json({}, { status: fail ? 502 : 200 }));
  await telemetry.configure('basic'); await telemetry.flush();
  fail = false; await telemetry.flush();
  expect(requests[1]!.body.events).toEqual(requests[0]!.body.events);
  fail = true; telemetry.track('project_added'); await telemetry.flush();
  await telemetry.configure('off'); fail = false; await telemetry.flush();
  expect(requests).toHaveLength(3);
});

test('enhanced withdrawal persists deletion, retries after restart, and uses a new ID', async () => {
  let fail = true;
  const f = fixture(async path => Response.json({}, { status: path === '/forget' && fail ? 502 : 200 }));
  await f.telemetry.configure('enhanced'); await f.telemetry.flush();
  const oldId = f.requests[0]!.body.install_id;
  await f.telemetry.configure('off'); await f.telemetry.flush();
  expect(f.telemetry.state().pendingDeletion).toBe(true);
  await f.telemetry.configure('enhanced');
  const saved = JSON.parse(readFileSync(join(f.dataDir, 'telemetry.json'), 'utf8'));
  expect(saved.installId).not.toBe(oldId);
  expect(saved.forget).toContain(oldId);
  const uploads = f.requests.filter(r => r.path === '/track').length;
  await f.telemetry.flush();
  expect(f.requests.filter(r => r.path === '/track')).toHaveLength(uploads);
  await f.telemetry.close();
  fail = false;
  const restarted = new Telemetry(f.host, 'https://relay.example', f.send);
  try {
    expect(restarted.state().pendingDeletion).toBe(true);
    await restarted.retryForget();
    expect(restarted.state().pendingDeletion).toBe(false);
    await restarted.configure('enhanced'); await restarted.flush();
    expect(f.requests.at(-1)!.body.install_id).not.toBe(oldId);
    expect(f.requests.some(r => r.path === '/forget' && r.body.install_id === oldId)).toBe(true);
  } finally { await restarted.close(); }
});

test('consent changes discard events arriving while an aborted upload settles', async () => {
  for (const mode of ['off', 'basic', 'enhanced'] as const) {
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const settled = new Promise<void>(resolve => { release = resolve; });
    let block = true;
    const f = fixture(async path => {
      if (path === '/track' && block) { started(); await settled; }
      return Response.json({ ok: true });
    });
    if (mode !== 'enhanced') await f.telemetry.configure('enhanced');
    const upload = f.telemetry.flush();
    await waiting;
    const changed = f.telemetry.configure(mode);
    await Promise.resolve();
    f.telemetry.track('turn_finished', { model: 'gpt-6-astra' });
    block = false;
    release();
    await upload;
    await changed;
    f.requests.length = 0;
    await f.telemetry.flush();
    const uploads = f.requests.filter(request => request.path === '/track');
    expect(uploads.flatMap(request => request.body.events).some(event => event.name === 'turn_finished')).toBe(false);
    if (mode === 'off') expect(uploads).toEqual([]);
    if (mode !== 'enhanced') expect(f.requests.some(request => request.path === '/forget')).toBe(true);
  }
});

test('export needs enhanced mode and an inert build never contacts a relay', async () => {
  const f = fixture();
  await f.telemetry.configure('off');
  expect(await thrown(f.telemetry.export())).toThrow('enhanced');
  const inert = new Telemetry(f.host, '', f.send);
  await inert.configure('enhanced');
  await inert.flush();
  expect(inert.state().configured).toBe(false);
  expect(await thrown(inert.export())).toThrow('no relay');
  await inert.close();
  expect(f.requests).toEqual([]);
});

test('relay rebuilds a closed payload and separates basic ping identifiers', () => {
  const event = telemetryEvent('turn_finished', '2.0.0', { provider: 'codex', outcome: 'error', duration_ms: 12 });
  const inputs = [{ ...event, prompt: 'SECRET', model: '/private/path', error_code: 'SECRET' }, telemetryEvent('ping', '2.0.0')];
  const batch = buildBatch('A', inputs, { eventIdentifier: 'daily', pingIdentifier: 'ping-only' }, 'FR', new Date().toISOString());
  expect(batch[0]!.distinct_id).toBe('daily');
  expect(batch[1]!.distinct_id).toBe('ping-only');
  expect(batch[0]!.properties.$process_person_profile).toBe(false);
  expect(batch[0]!.properties.$geoip_disable).toBe(true);
  expect(batch[0]!.properties.$ip).toBe('0.0.0.0');
  expect(batch[0]!.properties.provider).toBe('codex');
  expect(batch[0]!.properties.outcome).toBe('error');
  expect(JSON.stringify(batch)).not.toContain('SECRET');
  expect(JSON.stringify(batch)).not.toContain('/private/path');
  expect((batch[0] as any).uuid).toBe(event.uuid);
});

test('rate-limit alerts carry a bounded abort signal', async () => {
  const background: Promise<unknown>[] = [];
  const deadline = spyOn(AbortSignal, 'timeout');
  const request = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ ok: true });
  }) as typeof fetch);
  try {
    const env: Env = {
      RL_TRACK: { limit: async () => ({ success: false }) },
      RL_NOTIFY: { limit: async () => ({ success: true }) },
      RL_RGPD: { limit: async () => ({ success: true }) },
      RL_GLOBAL: { limit: async () => ({ success: true }) },
      HASH_SECRET: 'test-only', POSTHOG_PROJECT_API_KEY: '', POSTHOG_PERSONAL_API_KEY: '',
      POSTHOG_PROJECT_ID: '', POSTHOG_INGEST_HOST: '', POSTHOG_API_HOST: '', ENVIRONMENT: 'test', BATCH_MAX_EVENTS: '200',
      RESEND_API_KEY: 'test-only', ALERT_EMAIL: 'test@example.invalid', ALERT_FROM: 'test@example.invalid',
      UA_PREFIX: 'Boite/', ALLOWED_ORIGINS: '',
    };
    const response = await relay.fetch(new Request('https://relay.example/track', {
      method: 'POST', headers: { 'User-Agent': 'Boite/test', 'CF-Connecting-IP': '192.0.2.1' },
    }), env, { waitUntil: promise => { background.push(promise); } });
    expect(response.status).toBe(429);
    await Promise.all(background);
    expect(request).toHaveBeenCalledTimes(1);
    expect(deadline).toHaveBeenCalledWith(10000);
  } finally { request.mockRestore(); deadline.mockRestore(); }
});

test('one host bus emits one count, never the prompt or error from a turn', async () => {
  const f = fixture();
  await f.telemetry.configure('basic'); await f.telemetry.flush();
  f.bus.emit('turn.finished', { id: 'private', threadId: 'private', status: 'error', queuedAt: 10, startedAt: 11, finishedAt: 21, usage: null, error: 'SECRET', execution: { providerId: 'codex' } } as any);
  await f.telemetry.flush();
  const events = f.requests.at(-1)!.body.events;
  expect(events).toHaveLength(1);
  expect(events[0].duration_ms).toBe(10);
  expect(JSON.stringify(events)).not.toContain('SECRET');
  expect(JSON.stringify(events)).not.toContain('private');
});

test('model and token details require opt-in at both the host and relay', async () => {
  const f = fixture();
  const fields = { provider: 'codex', model: 'openai/gpt-6-astra', effort: 'high', permission_mode: 'plan', operation: 'prompt', input_tokens: 1234, output_tokens: 567, queue_ms: 150 };
  await f.telemetry.flush();
  f.telemetry.track('turn_finished', fields); await f.telemetry.flush();
  expect(f.requests.at(-1)!.body.events[0].model).toBeUndefined();
  expect(f.requests.at(-1)!.body.events[0].input_tokens).toBeUndefined();
  await f.telemetry.configure('enhanced'); await f.telemetry.flush();
  f.telemetry.track('turn_finished', fields); await f.telemetry.flush();
  const event = f.requests.at(-1)!.body.events[0];
  expect(event.model).toBe('gpt-6-astra'); expect(event.input_tokens).toBe(1200);
  const ids = { eventIdentifier: 'daily', pingIdentifier: 'stable' };
  const basic = buildBatch('A', [event], ids, 'FR', new Date().toISOString())[0]!.properties;
  expect(basic.model).toBeUndefined(); expect(basic.input_tokens).toBeUndefined();
  const enhanced = buildBatch('B', [event], ids, 'FR', new Date().toISOString())[0]!.properties;
  expect(enhanced.model).toBe('gpt-6-astra'); expect(enhanced.effort).toBe('high');
  f.telemetry.track('turn_finished', { ...fields, model: 'private-client/model-secret', effort: 'SECRET', prompt: 'SECRET' });
  await f.telemetry.flush();
  expect(f.requests.at(-1)!.body.events[0].model).toBe('other');
  expect(JSON.stringify(f.requests.at(-1))).not.toContain('SECRET');
  const hostile = buildBatch('B', [{ ...event, model: '/private/path', effort: 'SECRET', input_tokens: Infinity }], ids, 'FR', new Date().toISOString())[0]!.properties;
  expect(hostile.model).toBe('other'); expect(hostile.effort).toBe('other'); expect(hostile.input_tokens).toBeUndefined();
  await f.telemetry.configure('basic');
  expect(f.telemetry.state().pendingDeletion).toBe(true);
});

test('enhanced turn metrics use the frozen execution and keep missing usage absent', async () => {
  const f = fixture();
  await f.telemetry.configure('enhanced'); await f.telemetry.flush();
  f.bus.emit('turn.finished', {
    id: 'private', threadId: 'private', status: 'done', queuedAt: 100, startedAt: 250, finishedAt: 1250,
    usage: { inputTokens: 1234, outputTokens: 456, cacheReadTokens: 2789 },
    execution: { providerId: 'claude', model: 'claude-sonnet-4-5', effort: 'high', speed: 'fast', permissionMode: 'plan', operation: 'compact' },
  } as any);
  await f.telemetry.flush();
  const event = f.requests.at(-1)!.body.events[0];
  expect(event).toMatchObject({ model: 'claude-sonnet-4-5', effort: 'high', speed: 'fast', permission_mode: 'plan', operation: 'compact', queue_ms: 150, duration_ms: 1000, input_tokens: 1200, output_tokens: 500, cache_read_tokens: 2800 });
  expect(event.cache_write_tokens).toBeUndefined();
  expect(JSON.stringify(event)).not.toContain('private');
});

test('subagent calls count started child turns with the frozen model and effort, only after opt-in', async () => {
  const f = fixture();
  Object.assign(f.host, { journal: { getThread: (id: string) => id === 'child' ? { parentThreadId: 'private-parent', model: 'private/new-selection', effort: 'low' } : { parentThreadId: null } } });
  const turn = {
    id: 'private-turn', threadId: 'child', status: 'running', queuedAt: 100, startedAt: 250,
    execution: { providerId: 'codex', model: 'codex/gpt-6.1-sol', effort: 'high', speed: 'standard', operation: 'delegation' },
  } as any;
  await f.telemetry.flush();
  f.bus.emit('turn.started', turn);
  await f.telemetry.flush();
  expect(f.requests.at(-1)!.body.events.some((event: any) => event.name === 'subagent_started')).toBe(false);
  await f.telemetry.configure('enhanced'); await f.telemetry.flush();
  f.bus.emit('turn.started', { ...turn, threadId: 'parent' });
  f.bus.emit('turn.started', { ...turn, execution: { ...turn.execution, operation: 'compact' } });
  f.bus.emit('turn.started', { ...turn, execution: { ...turn.execution, operation: 'keepalive' } });
  f.bus.emit('turn.started', turn);
  // Follow-up and workflow retry turns are calls too, without waiting for completion.
  f.bus.emit('turn.started', { ...turn, id: 'private-followup', execution: { ...turn.execution, effort: 'xhigh' } });
  await f.telemetry.flush();
  const events = f.requests.at(-1)!.body.events;
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ name: 'subagent_started', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', speed: 'standard' });
  expect(events[1].effort).toBe('xhigh');
  expect(events[0].operation).toBeUndefined();
  expect(JSON.stringify(events)).not.toContain('private');
});

test('the relay drops basic subagent calls and rebuilds enhanced calls from closed fields', () => {
  const ids = { eventIdentifier: 'daily', pingIdentifier: 'stable' };
  const event = { ...telemetryEvent('turn_finished', '2.0.0'), name: 'subagent_started', provider: 'codex', model: 'codex/gpt-6.1-sol', effort: 'high', speed: 'fast', task: 'PRIVATE', parentThreadId: 'PRIVATE', input_tokens: 100, permission_mode: 'plan' };
  expect(buildBatch('A', [event], ids, 'FR', new Date().toISOString())).toEqual([]);
  const batch = buildBatch('B', [event], ids, 'FR', new Date().toISOString());
  expect(batch).toHaveLength(1);
  expect(batch[0]!.properties).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', speed: 'fast' });
  expect(batch[0]!.properties.input_tokens).toBeUndefined();
  expect(batch[0]!.properties.permission_mode).toBeUndefined();
  expect(JSON.stringify(batch)).not.toContain('PRIVATE');
  const hostile = buildBatch('B', [{ ...event, model: '/PRIVATE/model', effort: 'PRIVATE', speed: 'PRIVATE' }], ids, 'FR', new Date().toISOString())[0]!.properties;
  expect(hostile).toMatchObject({ model: 'other', effort: 'other', speed: 'other' });
  expect(JSON.stringify(hostile)).not.toContain('PRIVATE');
});


test('explicit choices count all modes once, including unchanged basic, without identifying a refusal', async () => {
  const f = fixture();
  for (const mode of ['basic', 'enhanced', 'off'] as const) {
    await f.telemetry.configure(mode, true);
    await f.telemetry.flush();
    const choices = f.requests.filter(r => r.path === '/consent');
    expect(choices).toHaveLength(mode === 'basic' ? 1 : mode === 'enhanced' ? 2 : 3);
    expect(choices.at(-1)!.body).toEqual({ mode, receipt_id: expect.any(String) });
    expect(choices.at(-1)!.body.receipt_id).toMatch(/^[0-9a-f-]{36}$/);
    await f.telemetry.configure(mode, true);
    await f.telemetry.flush();
    expect(f.requests.filter(r => r.path === '/consent')).toHaveLength(choices.length);
  }
  f.requests.length = 0;
  f.telemetry.track('project_added');
  await f.telemetry.flush();
  await f.telemetry.close();
  expect(f.requests).toEqual([]);
});

test('startup, legacy callers, saved off and inert builds never invent a choice', async () => {
  const f = fixture();
  await f.telemetry.flush();
  await f.telemetry.configure('enhanced');
  await f.telemetry.configure('off');
  await f.telemetry.close();
  const restarted = new Telemetry(f.host, 'https://relay.example', f.send);
  await restarted.close();
  expect(f.requests.filter(r => r.path === '/consent')).toEqual([]);
  f.requests.length = 0;
  const inert = new Telemetry(f.host, '', f.send);
  try {
    for (const mode of ['basic', 'enhanced', 'off'] as const) {
      await inert.configure(mode, true);
      expect(JSON.parse(readFileSync(join(f.dataDir, 'telemetry.json'), 'utf8')).choice).toBeUndefined();
    }
  } finally { await inert.close(); }
  expect(f.requests).toEqual([]);
  const enabled = new Telemetry(f.host, 'https://relay.example', f.send);
  try {
    await enabled.flush();
    // A deletion queued by Enhanced -> Off still retries, independently of choices.
    expect(f.requests.filter(r => r.path !== '/forget')).toEqual([]);
    f.requests.length = 0;
    // Reporting starts only after a new explicit selection with an available relay.
    await enabled.configure('off', true);
    await enabled.flush();
    expect(f.requests).toEqual([{ path: '/consent', body: { mode: 'off', receipt_id: expect.any(String) } }]);
  } finally { await enabled.close(); }
});

test('inert mode changes discard superseded pending choices while retaining the deletion ledger', async () => {
  for (const countChoice of [true, false]) {
    const f = fixture(async path => Response.json({}, { status: path === '/consent' || path === '/forget' ? 502 : 200 }));
    await f.telemetry.configure('enhanced', true);
    await f.telemetry.flush();
    const oldId = f.requests.find(r => r.path === '/track')!.body.install_id;
    await f.telemetry.close();
    f.requests.length = 0;
    const inert = new Telemetry(f.host, '', f.send);
    try { await inert.configure('off', countChoice); } finally { await inert.close(); }
    const saved = JSON.parse(readFileSync(join(f.dataDir, 'telemetry.json'), 'utf8'));
    expect(saved.choice).toBeUndefined();
    expect(saved.forget).toEqual([oldId]);
    expect(f.requests).toEqual([]);
    const enabled = new Telemetry(f.host, 'https://relay.example', f.send);
    try { await enabled.flush(); } finally { await enabled.close(); }
    expect(f.requests.filter(r => r.path === '/consent')).toEqual([]);
    expect(f.requests.some(r => r.path === '/forget' && r.body.install_id === oldId)).toBe(true);
  }
});

test('choice retries survive restart with one receipt and acknowledgement survives another restart', async () => {
  let fail = true;
  const f = fixture(async path => Response.json({}, { status: path === '/consent' && fail ? 502 : 200 }));
  await f.telemetry.configure('off', true);
  await f.telemetry.flush();
  await f.telemetry.close();
  const first = f.requests.find(r => r.path === '/consent')!.body;
  expect(JSON.parse(readFileSync(join(f.dataDir, 'telemetry.json'), 'utf8')).choice).toMatchObject({ mode: 'off', pending: true });
  fail = false;
  const restarted = new Telemetry(f.host, 'https://relay.example', f.send);
  try { await restarted.flush(); } finally { await restarted.close(); }
  expect(f.requests.filter(r => r.path === '/consent').every(r => JSON.stringify(r.body) === JSON.stringify(first))).toBe(true);
  expect(JSON.parse(readFileSync(join(f.dataDir, 'telemetry.json'), 'utf8')).choice.pending).toBe(false);
  f.requests.length = 0;
  const acknowledged = new Telemetry(f.host, 'https://relay.example', f.send);
  try { await acknowledged.configure('off', true); await acknowledged.flush(); } finally { await acknowledged.close(); }
  expect(f.requests).toEqual([]);
});

test('latest choice replaces unsent receipt and stale responses cannot acknowledge a newer choice', async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const settled = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async path => {
    if (path === '/consent' && !releaseOld) { started(); await settled; }
    return Response.json({ ok: true });
  });
  let releaseOld = false;
  await f.telemetry.configure('basic', true);
  await f.telemetry.configure('off', true);
  const upload = f.telemetry.flush();
  await waiting;
  // Saving another choice must finish even when the fetch ignores abort.
  const changed = f.telemetry.configure('enhanced', true);
  try {
    const result = await Promise.race([changed.then(() => 'saved'), Bun.sleep(100).then(() => 'blocked')]);
    expect(result).toBe('saved');
  } finally { releaseOld = true; release(); await upload; await changed; }
  expect(f.requests.filter(r => r.path === '/consent').map(r => r.body.mode)).toEqual(['off']);
  expect(JSON.parse(readFileSync(join(f.dataDir, 'telemetry.json'), 'utf8')).choice).toMatchObject({ mode: 'enhanced', pending: true });
  await f.telemetry.flush();
  const receipts = f.requests.filter(r => r.path === '/consent');
  expect(receipts.map(r => r.body.mode)).toEqual(['off', 'enhanced']);
  expect(receipts[0]!.body.receipt_id).not.toBe(receipts[1]!.body.receipt_id);
  await f.telemetry.configure('off', true); await f.telemetry.flush();
  expect(f.requests.filter(r => r.path === '/consent')).toHaveLength(3);
});

test('a failed deletion cannot suppress the anonymous refusal or lose its deletion ledger', async () => {
  const f = fixture(async path => Response.json({}, { status: path === '/forget' ? 502 : 200 }));
  await f.telemetry.configure('enhanced');
  await f.telemetry.flush();
  const oldId = f.requests.find(r => r.path === '/track')!.body.install_id;
  await f.telemetry.configure('off', true);
  await f.telemetry.flush();
  expect(f.requests.filter(r => r.path === '/consent').map(r => r.body)).toEqual([{ mode: 'off', receipt_id: expect.any(String) }]);
  const saved = JSON.parse(readFileSync(join(f.dataDir, 'telemetry.json'), 'utf8'));
  expect(saved.forget).toEqual([oldId]);
  expect(saved.choice.pending).toBe(false);
  expect(f.telemetry.state().pendingDeletion).toBe(true);
});

test('configure validates countChoice and the real RPC forwards explicit reporting', async () => {
  const f = fixture();
  expect(await thrown(f.telemetry.configure('off', 'yes' as any))).toThrow('countChoice: expected a boolean');
  const handlers: Record<string, (params: any) => any> = {};
  Object.assign(f.host, { telemetry: f.telemetry, router: { register: (name: string, handler: any) => { handlers[name] = handler; } } });
  registerTelemetry(f.host);
  await handlers['telemetry.configure']!({ mode: 'off', countChoice: true });
  await f.telemetry.flush();
  expect(f.requests.filter(r => r.path === '/consent')).toHaveLength(1);
});

function consentRelayEnv(): Env {
  return {
    RL_TRACK: { limit: async () => ({ success: true }) }, RL_RGPD: { limit: async () => ({ success: true }) },
    RL_GLOBAL: { limit: async () => ({ success: true }) }, RL_NOTIFY: { limit: async () => ({ success: false }) },
    HASH_SECRET: 'test-only', POSTHOG_PROJECT_API_KEY: 'test-only', POSTHOG_PERSONAL_API_KEY: '', POSTHOG_PROJECT_ID: '',
    POSTHOG_INGEST_HOST: 'https://posthog.example', POSTHOG_API_HOST: '', ENVIRONMENT: 'test', BATCH_MAX_EVENTS: '200',
    RESEND_API_KEY: '', ALERT_EMAIL: '', ALERT_FROM: '', UA_PREFIX: 'Boite/', ALLOWED_ORIGINS: 'https://app.example',
  };
}

test('relay consent rebuilds anonymous events, preserves receipt UUIDs on retries and drops every extra field', async () => {
  const uploaded: any[] = [];
  const request = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    uploaded.push(...JSON.parse(String(init?.body)).batch);
    return Response.json({ ok: true });
  }) as typeof fetch);
  try {
    for (const mode of ['off', 'basic', 'enhanced']) {
      const receipt_id = crypto.randomUUID();
      for (let retry = 0; retry < 2; retry++) {
        const req = new Request('https://relay.example/consent', {
          method: 'POST', headers: { 'User-Agent': 'Boite/test', 'CF-Connecting-IP': '192.0.2.1', Origin: 'https://app.example' },
          body: JSON.stringify({ mode, receipt_id, anonymous_id: 'PRIVATE', install_id: 'PRIVATE', os: 'PRIVATE', country: 'PRIVATE', app_version: 'PRIVATE', account: 'PRIVATE', events: ['PRIVATE'] }),
        });
        Object.assign(req, { cf: { country: 'FR' } });
        const res = await relay.fetch(req, consentRelayEnv(), { waitUntil: () => {} });
        expect(res.status).toBe(200);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
      }
      const events = uploaded.slice(-2);
      for (const event of events) expect(event).toEqual({
        event: 'consent_choice', distinct_id: 'anonymous-consent', uuid: receipt_id, timestamp: expect.any(String),
        properties: { distinct_id: 'anonymous-consent', $process_person_profile: false, $ip: '0.0.0.0', $geoip_disable: true, choice: mode, receipt_id },
      });
    }
    expect(uploaded).toHaveLength(6);
    expect(JSON.stringify(uploaded)).not.toContain('PRIVATE');
    expect(JSON.stringify(uploaded)).not.toContain('192.0.2.1');
  } finally { request.mockRestore(); }
});

test('relay consent validates inputs and uses existing body, UA, per-IP and global limits', async () => {
  const env = consentRelayEnv();
  const request = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));
  const globalLimit = spyOn(env.RL_GLOBAL, 'limit');
  const perIp = spyOn(env.RL_TRACK, 'limit');
  const receipt_id = crypto.randomUUID();
  const invoke = (body: unknown, headers: Record<string, string> = {}, method = 'POST') => relay.fetch(new Request('https://relay.example/consent', {
    method, headers: { 'User-Agent': 'Boite/test', 'CF-Connecting-IP': '192.0.2.1', ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  }), env, { waitUntil: () => {} });
  try {
    expect((await invoke(null, {}, 'GET')).status).toBe(405);
    expect((await invoke({ mode: 'off', receipt_id }, { 'User-Agent': 'other' })).status).toBe(400);
    for (const body of [null, [], '{', { mode: 'other', receipt_id }, { mode: ['off'], receipt_id }, { mode: 'off', receipt_id: 'bad' }, { mode: 'off' }])
      expect((await invoke(body)).status).toBe(400);
    expect((await invoke(' '.repeat(65537))).status).toBe(413);
    expect(globalLimit).not.toHaveBeenCalled();
    perIp.mockResolvedValue({ success: false });
    expect((await invoke({ mode: 'off', receipt_id })).status).toBe(429);
    expect(perIp).toHaveBeenCalledWith({ key: '192.0.2.1' });
    perIp.mockResolvedValue({ success: true });
    globalLimit.mockResolvedValue({ success: false });
    expect((await invoke({ mode: 'off', receipt_id })).status).toBe(503);
    expect(globalLimit).toHaveBeenCalledWith({ key: 'global' });
    expect(request).not.toHaveBeenCalled();
  } finally { request.mockRestore(); }
});


test('failed consent and acknowledgement writes preserve both the choice receipt and deletion ledger', async () => {
  let obstructAck = false;
  const f = fixture(async path => {
    if (path === '/consent' && obstructAck) mkdirSync(join(f.dataDir, 'telemetry.json.tmp'));
    return Response.json({ ok: true });
  });
  await f.telemetry.configure('enhanced');
  await f.telemetry.flush();
  const oldId = f.requests.find(r => r.path === '/track')!.body.install_id;
  const file = join(f.dataDir, 'telemetry.json');
  const before = readFileSync(file, 'utf8');
  const temporary = `${file}.tmp`;
  mkdirSync(temporary);
  try {
    expect(await thrown(f.telemetry.configure('off', true))).toThrow();
    expect(f.telemetry.state().mode).toBe('enhanced');
    expect(readFileSync(file, 'utf8')).toBe(before);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  await f.telemetry.configure('off', true);
  obstructAck = true;
  try {
    await f.telemetry.flush();
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.forget).toEqual([oldId]);
    expect(saved.choice.pending).toBe(true);
    expect(f.telemetry.state().pendingDeletion).toBe(true);
  } finally { obstructAck = false; rmSync(temporary, { recursive: true, force: true }); }
  await f.telemetry.flush();
  const receipts = f.requests.filter(r => r.path === '/consent');
  expect(receipts).toHaveLength(2);
  expect(receipts[0]!.body).toEqual(receipts[1]!.body);
  expect(f.requests.filter(r => r.path === '/forget').map(r => r.body.install_id)).toEqual([oldId, oldId]);
  expect(f.telemetry.state().pendingDeletion).toBe(false);
});


test('a responsive mode change defers launch counters until an aborted upload settles', async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const settled = new Promise<void>(resolve => { release = resolve; });
  let blocked = true;
  const f = fixture(async path => {
    if (path === '/consent' && blocked) { started(); await settled; }
    return Response.json({ ok: true });
  });
  await f.telemetry.configure('off', true);
  const file = join(f.dataDir, 'telemetry.json');
  // A fresh saved Off state has never emitted usage counters.
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.firstRun = false; saved.pingDay = '';
  writeFileSync(file, JSON.stringify(saved));
  // Close the original without sending its receipt through the gated transport.
  blocked = false;
  await f.telemetry.close();
  writeFileSync(file, JSON.stringify(saved));
  blocked = true;
  f.requests.length = 0;
  const telemetry = new Telemetry(f.host, 'https://relay.example', f.send);
  cleanups.unshift(async () => { await telemetry.close(); });
  const upload = telemetry.flush();
  await waiting;
  const changed = telemetry.configure('basic', true);
  try {
    expect(await Promise.race([changed.then(() => 'saved'), Bun.sleep(100).then(() => 'blocked')])).toBe('saved');
    const during = JSON.parse(readFileSync(file, 'utf8'));
    expect(during.firstRun).toBe(false);
    expect(during.pingDay).toBe('');
  } finally { blocked = false; release(); await upload; await changed; }
  try {
    await telemetry.flush();
    const events = f.requests.filter(r => r.path === '/track').flatMap(r => r.body.events).map(event => event.name);
    expect(events.filter(name => name === 'first_run')).toHaveLength(1);
    expect(events.filter(name => name === 'app_launched')).toHaveLength(1);
    expect(events.filter(name => name === 'ping')).toHaveLength(1);
  } finally { await telemetry.close(); }
});
