import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { parsePluginPool, verifyPluginDownload } from '../src/plugins.ts';
import { startTestCore, type TestCore } from './harness.ts';
let harness: TestCore | undefined;
afterEach(async () => { await harness?.stop(); harness = undefined; });

test('kebacc v2 JSON maps live and unknown quotas without inventing reset times', () => {
  const pool = parsePluginPool('codex', JSON.stringify({ pool: 'Codex', accounts: [
    { email: 'user@example.com', live: true, fiveHour: 0, sevenDay: null, checkedSecondsAgo: 19, readyAt: '2026-09-13T12:00:00Z', file: 'must-not-leave-core' },
  ] }));
  expect(pool.accounts[0]).toEqual({ email: 'user@example.com', active: true, checkedSecondsAgo: 19,
    windows: [{ id: 'fiveHour', label: '5 hours', usedPercent: 0, resetsAt: null }] });
  expect(() => parsePluginPool('codex', '{}')).toThrow('accounts array');
  expect(() => verifyPluginDownload(new Uint8Array([1,2,3]), 'wrong')).toThrow('sha256');
});
test('plugin RPC refuses unknown IDs and unavailable installs, uninstall keeps account pools', async () => {
  harness = await startTestCore(); const client = await harness.connect();
  await expect(client.call('plugins.install', { id: '../escape' })).rejects.toThrow('unknown plugin');
  await expect(client.call('plugins.accounts', { id: 'kebacc-switcher' })).rejects.toThrow('Install kebacc-switcher first');
  const pool = join(harness.dataDir, 'saved-logins'); mkdirSync(pool); writeFileSync(join(pool, 'keep'), 'fixture');
  const state = await client.call('plugins.uninstall', { id: 'kebacc-switcher' });
  expect(state.status).toBe('not-installed'); expect(existsSync(join(pool, 'keep'))).toBe(true);
});
test('the adapter runs the v2 pool flags through the process registry and normalizes JSON', async () => {
  harness = await startTestCore();
  const dir = join(harness.dataDir, 'plugins', 'kebacc-switcher'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'installed.json'), '{"version":"2.0.1"}');
  writeFileSync(join(dir, process.platform === 'win32' ? 'kebacc.exe' : 'kebacc'), 'fixture');
  const fixture = join(dir, 'fixture.ts');
  writeFileSync(fixture, `const args = process.argv.slice(2); if(args[0] !== 'list' || !['-claude','-codex','-antigravity'].includes(args[1]) || args[2] !== '-Json') process.exit(3); console.log(JSON.stringify({accounts:[{email:'fixture@example.com', live:true, fiveHour:12, sevenDay:65, checkedSecondsAgo:0}]}));`);
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  const replacement = spyOn(harness.core.procs, 'spawn').mockImplementation((thread, _cmd, args, options) => spawn(thread, process.execPath, [fixture, ...args], options));
  try {
    const result = await harness.core.plugins.accounts('kebacc-switcher');
    expect(result.map((pool) => pool.provider)).toEqual(['claude', 'codex', 'antigravity']);
    expect(result[0]?.accounts[0]?.windows[1]?.usedPercent).toBe(65);
    expect(replacement).toHaveBeenCalledTimes(3);
    await harness.core.plugins.accounts('kebacc-switcher'); expect(replacement).toHaveBeenCalledTimes(3);
  } finally { replacement.mockRestore(); }
});
