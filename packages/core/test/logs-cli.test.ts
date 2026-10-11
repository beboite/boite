import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RpcErrorCode } from '@boite/contracts';
import { parse } from '../src/cli-args.ts';
import { runCli } from '../src/cli.ts';
import { echoThread, startTestCore } from './harness.ts';

// Its own file, so its own process: on Windows, Bun 1.4.2 corrupted its heap here after the
// sockets of the other diagnostics tests and crashed in malloc creating the CLI's WebSocket.
test('the CLI prints records oldest first, filters by time and level, and exports to a file', async () => {
  const harness = await startTestCore();
  try {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    harness.core.logs.warn('first warning', { source: 'test', event: 'test.first', threadId });
    harness.core.logs.error('then an error', { source: 'test', event: 'test.second' });
    writeFileSync(join(harness.dataDir, 'core.json'), JSON.stringify({ port: harness.server.port, host: '127.0.0.1', token: harness.token }), { mode: 0o600 });
    const run = async (args: string[], env: Record<string, string> = {}): Promise<string> => {
      let output = '', errors = '';
      const code = await runCli(args, { env, cwd: harness.dataDir, out: value => { output += value; }, err: value => { errors += value; } });
      expect({ code, errors }).toEqual({ code: 0, errors: '' });
      return output;
    };
    // A global flag right after one of the logs filters stays global.
    expect(parse(['logs', '--since', '--json'])).toMatchObject({ positional: ['logs', '--since'], json: true });
    expect(parse(['logs', '--search', 'timeout', '--json'])).toMatchObject({ positional: ['logs', '--search', 'timeout'], json: true });
    const owned = (await run(['logs', '--data-dir', harness.dataDir, '--min-level', 'warn', '--since', '10m'])).trim().split('\n');
    // A global `--limit` before the command still bounds it.
    expect((await run(['--limit', '1', 'logs', '--data-dir', harness.dataDir, '--min-level', 'warn'])).trim().split('\n')).toHaveLength(1);
    expect(owned.at(-2)).toContain('test/test.first');
    expect(owned.at(-1)).toContain('ERROR core  test/test.second');
    // `--mine` is the agent's: the owner is told so rather than handed every thread.
    let refusedMine = '';
    expect(await runCli(['logs', '--data-dir', harness.dataDir, '--mine'], { env: {}, cwd: harness.dataDir, out: () => undefined, err: value => { refusedMine += value; } })).not.toBe(0);
    expect(refusedMine).toContain('--mine is the agent');
    // A value that starts with dashes goes after an equals sign; a switch takes none.
    expect(await run(['logs', '--data-dir', harness.dataDir, '--min-level=warn', '--search=--no-such-text'])).toContain('no records match');
    let refusedSwitch = '';
    expect(await runCli(['logs', '--data-dir', harness.dataDir, '--mine=yes'], { env: {}, cwd: harness.dataDir, out: () => undefined, err: value => { refusedSwitch += value; } })).not.toBe(0);
    expect(refusedSwitch).toContain('--mine takes no value');
    // Every subcommand refuses an extra word, and an unreadable description file is a usage error.
    for (const [args, expected] of [[['logs', 'problems', 'extra'], 'logs problems takes flags only'], [['logs', 'problems', '--search', 'timeout'], '--search does not apply to it'], [['logs', '--out', 'x.txt'], '--out does not apply to it'], [['logs', '--level', 'warn', '--min-level', 'info'], '--level and --min-level filter the same field'], [['issue', 'draft', 'extra', '--title', 'The window froze', '--description', 'x'], 'issue draft takes flags only'], [['issue', 'draft', '--title', 'The window froze', '--description', 'x', '--description-file', 'a.md'], 'not both'], [['issue', 'draft', '--title', 'The window froze', '--description', 'x', '--since', '1h'], '--since does not apply to it'], [['issue', 'draft', '--title', 'The window froze', '--description-file', 'missing.md'], '--description-file missing.md cannot be read: ENOENT']] as const) {
      let refused = '';
      expect(await runCli(['--data-dir', harness.dataDir, ...args], { env: {}, cwd: harness.dataDir, out: () => undefined, err: value => { refused += value; } })).not.toBe(0);
      expect(refused).toContain(expected);
    }
    const agentEnv = { BOITE_CORE_URL: harness.url, BOITE_AGENT_TOKEN: harness.core.agents.tokenFor(threadId), BOITE_THREAD_ID: threadId };
    expect(await run(['logs', '--mine', '--min-level', 'warn'], agentEnv)).toContain('first warning');
    expect(await run(['logs', 'problems'], agentEnv)).toContain('1x error core/test/test.second');
    mkdirSync(join(harness.dataDir, 'out'));
    // A folder given as --out fails to open and keeps its permissions.
    if (process.platform !== 'win32') {
      const before = statSync(join(harness.dataDir, 'out')).mode & 0o777;
      expect(await runCli(['logs', 'export', '--out', 'out'], { env: agentEnv, cwd: harness.dataDir, out: () => undefined, err: () => undefined })).not.toBe(0);
      expect(statSync(join(harness.dataDir, 'out')).mode & 0o777).toBe(before);
    }
    // The core refuses a field the method does not take, by name.
    await expect(owner.call('diagnostics.summary', { thread: 'x' } as never)).rejects.toMatchObject({ rpc: { code: RpcErrorCode.InvalidParams } });
    const exported = await run(['logs', 'export', '--out', 'out/report.txt'], agentEnv);
    expect(exported).toContain(`written: ${join(harness.dataDir, 'out', 'report.txt')}`);
    expect(readFileSync(join(harness.dataDir, 'out', 'report.txt'), 'utf8')).toContain('## Timeline');
    expect(await run(['logs', 'help'], agentEnv)).toContain('boite logs: Boite\'s own diagnostics');
  } finally { await harness.stop(); }
});
