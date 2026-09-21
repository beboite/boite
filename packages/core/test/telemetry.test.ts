import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bus } from '../src/bus.ts';
import type { Core } from '../src/core.ts';
import { Telemetry, telemetryEvent } from '../src/telemetry.ts';
import { buildBatch } from '../../../telemetry/src/index.ts';

const cleanups: (() => Promise<void>)[] = [];
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
  await expect(f.telemetry.configure('enhanced')).rejects.toThrow('pending deletion');
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

test('export needs enhanced mode and an inert build never contacts a relay', async () => {
  const f = fixture();
  await f.telemetry.configure('off');
  await expect(f.telemetry.export()).rejects.toThrow('enhanced');
  const inert = new Telemetry(f.host, '', f.send);
  await inert.configure('enhanced');
  await inert.flush();
  expect(inert.state().configured).toBe(false);
  await expect(inert.export()).rejects.toThrow('no relay');
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
