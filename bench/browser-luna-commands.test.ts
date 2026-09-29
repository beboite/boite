import { expect, test } from 'bun:test';
import { LunaCommandGate } from './browser-luna-commands.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('foreground waits for a pending heartbeat without an artificial action failure', async () => {
  const gate = new LunaCommandGate();
  const release = deferred();
  const calls: string[] = [];
  const heartbeat = gate.heartbeat(async () => { calls.push('heartbeat'); await release.promise; });
  const foreground = gate.command(async () => { calls.push('click'); return 'clicked'; }).catch(error => error);
  expect(await gate.heartbeat(async () => { calls.push('second heartbeat'); })).toBe(false);
  await Bun.sleep(0);
  expect(calls).toEqual(['heartbeat']);
  release.resolve();
  expect(await heartbeat).toBe(true);
  expect(await foreground).toBe('clicked');
  expect(calls).toEqual(['heartbeat', 'click']);
});

test('heartbeats are skipped while a foreground command owns or waits for the connection', async () => {
  const gate = new LunaCommandGate();
  const release = deferred();
  const foreground = gate.command(() => release.promise);
  let heartbeatCalls = 0;
  expect(await gate.heartbeat(async () => { heartbeatCalls++; })).toBe(false);
  release.resolve(); await foreground;
  expect(heartbeatCalls).toBe(0);
});

test('a failed heartbeat does not poison the next foreground command', async () => {
  const gate = new LunaCommandGate();
  const release = deferred();
  const heartbeat = gate.heartbeat(async () => { await release.promise; throw new Error('heartbeat failed'); });
  const failure = heartbeat.catch(error => error.message);
  const foreground = gate.command(async () => 'observed').catch(error => error);
  release.resolve();
  expect(await failure).toBe('heartbeat failed');
  expect(await foreground).toBe('observed');
});

test('foreground concurrency is still rejected', async () => {
  const gate = new LunaCommandGate();
  const release = deferred();
  const first = gate.command(() => release.promise);
  await expect(gate.command(async () => {})).rejects.toThrow('Concurrent browser command');
  release.resolve(); await first;
});
