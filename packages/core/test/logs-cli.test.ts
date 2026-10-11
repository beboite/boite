import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RpcErrorCode } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { parse } from '../src/cli-args.ts';
import { runCli } from '../src/cli.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

// Its own file, so its own process, and one step per test so a CI log names the step a
// crash interrupts: on Windows, Bun 1.4.2 crashed in its socket code during these commands.
describe('the CLI prints records oldest first, filters by time and level, and exports to a file', () => {
  let harness: TestCore;
  let owner: CoreClient;
  let threadId: string;
  let agentEnv: Record<string, string>;

  beforeAll(async () => {
    harness = await startTestCore();
    owner = await harness.connect();
    ({ threadId } = await echoThread(harness, owner));
    harness.core.logs.warn('first warning', { source: 'test', event: 'test.first', threadId });
    harness.core.logs.error('then an error', { source: 'test', event: 'test.second' });
    writeFileSync(join(harness.dataDir, 'core.json'), JSON.stringify({ port: harness.server.port, host: '127.0.0.1', token: harness.token }), { mode: 0o600 });
    agentEnv = { BOITE_CORE_URL: harness.url, BOITE_AGENT_TOKEN: harness.core.agents.tokenFor(threadId), BOITE_THREAD_ID: threadId };
  });
  afterAll(async () => { await harness?.stop(); });

  const run = async (args: string[], env: Record<string, string> = {}): Promise<string> => {
    let output = '', errors = '';
    const code = await runCli(args, { env, cwd: harness.dataDir, out: value => { output += value; }, err: value => { errors += value; } });
    expect({ code, errors }).toEqual({ code: 0, errors: '' });
    return output;
  };
  const refusal = async (args: string[], env: Record<string, string> = {}): Promise<string> => {
    let errors = '';
    expect(await runCli(args, { env, cwd: harness.dataDir, out: () => undefined, err: value => { errors += value; } })).not.toBe(0);
    return errors;
  };

  test('the owner reads records oldest first, bounded by a global --limit', async () => {
    // A global flag right after one of the logs filters stays global.
    expect(parse(['logs', '--since', '--json'])).toMatchObject({ positional: ['logs', '--since'], json: true });
    expect(parse(['logs', '--search', 'timeout', '--json'])).toMatchObject({ positional: ['logs', '--search', 'timeout'], json: true });
    const owned = (await run(['logs', '--data-dir', harness.dataDir, '--min-level', 'warn', '--since', '10m'])).trim().split('\n');
    expect((await run(['--limit', '1', 'logs', '--data-dir', harness.dataDir, '--min-level', 'warn'])).trim().split('\n')).toHaveLength(1);
    expect(owned.at(-2)).toContain('test/test.first');
    expect(owned.at(-1)).toContain('ERROR core  test/test.second');
  });

  test('--mine is the agent\'s, and a value that starts with dashes goes after an equals sign', async () => {
    expect(await refusal(['logs', '--data-dir', harness.dataDir, '--mine'])).toContain('--mine is the agent');
    expect(await run(['logs', '--data-dir', harness.dataDir, '--min-level=warn', '--search=--no-such-text'])).toContain('no records match');
    expect(await refusal(['logs', '--data-dir', harness.dataDir, '--mine=yes'])).toContain('--mine takes no value');
  });

  test('every subcommand refuses an extra word, and an unreadable description file is a usage error', async () => {
    for (const [args, expected] of [[['logs', 'problems', 'extra'], 'logs problems takes flags only'], [['logs', 'problems', '--search', 'timeout'], '--search does not apply to it'], [['logs', '--out', 'x.txt'], '--out does not apply to it'], [['logs', '--level', 'warn', '--min-level', 'info'], '--level and --min-level filter the same field'], [['issue', 'draft', 'extra', '--title', 'The window froze', '--description', 'x'], 'issue draft takes flags only'], [['issue', 'draft', '--title', 'The window froze', '--description', 'x', '--description-file', 'a.md'], 'not both'], [['issue', 'draft', '--title', 'The window froze', '--description', 'x', '--since', '1h'], '--since does not apply to it'], [['issue', 'draft', '--title', 'The window froze', '--description-file', 'missing.md'], '--description-file missing.md cannot be read: ENOENT']] as const) {
      expect(await refusal(['--data-dir', harness.dataDir, ...args])).toContain(expected);
    }
  });

  test('an agent reads its own family and the grouped problems', async () => {
    expect(await run(['logs', '--mine', '--min-level', 'warn'], agentEnv)).toContain('first warning');
    expect(await run(['logs', 'problems'], agentEnv)).toContain('1x error core/test/test.second');
    // Past what an agent may read, it is told so rather than handed the newest 500.
    expect(await refusal(['logs', '--limit', '1000'], agentEnv)).toContain('an agent reads up to 500 records');
    expect(await refusal(['issue', 'draft', '--title', 'The window froze', '--description', 'x'.repeat(20_001)], agentEnv)).toContain('at most 20000');
  });

  test('a folder given as --out fails to open and keeps its permissions; the core refuses an unknown field', async () => {
    mkdirSync(join(harness.dataDir, 'out'));
    if (process.platform !== 'win32') {
      const before = statSync(join(harness.dataDir, 'out')).mode & 0o777;
      expect(await runCli(['logs', 'export', '--out', 'out'], { env: agentEnv, cwd: harness.dataDir, out: () => undefined, err: () => undefined })).not.toBe(0);
      expect(statSync(join(harness.dataDir, 'out')).mode & 0o777).toBe(before);
    }
    await expect(owner.call('diagnostics.summary', { thread: 'x' } as never)).rejects.toMatchObject({ rpc: { code: RpcErrorCode.InvalidParams } });
  });

  test('the export lands in the named file, and help names the command', async () => {
    const exported = await run(['logs', 'export', '--out', 'out/report.txt'], agentEnv);
    expect(exported).toContain(`written: ${join(harness.dataDir, 'out', 'report.txt')}`);
    expect(readFileSync(join(harness.dataDir, 'out', 'report.txt'), 'utf8')).toContain('## Timeline');
    expect(await run(['logs', 'help'], agentEnv)).toContain('boite logs: Boite\'s own diagnostics');
  });
});
