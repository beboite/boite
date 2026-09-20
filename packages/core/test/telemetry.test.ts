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

test('fresh hosts send nothing, including before consent and on shutdown', async () => {
  const { telemetry, requests } = fixture();
  telemetry.track('project_added');
  await telemetry.flush();
  await telemetry.close();
  expect(requests).toEqual([]);
  expect(telemetry.state().mode).toBe('off');
});

test('invalid consent fails closed with repair guidance and preserves the deletion ledger', async () => {
  const f = fixture();
  await f.telemetry.close();
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
