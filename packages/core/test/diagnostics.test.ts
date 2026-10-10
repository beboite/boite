import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogAnonymizer, formatLogLine, parseLogRecord, RpcErrorCode } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { runCli } from '../src/cli.ts';
import { renderIssueBody } from '../src/diagnostics.ts';
import { echoThread, startTestCore } from './harness.ts';

test('the anonymizer replaces paths, names, addresses and private hosts and keeps ids and public services', () => {
  const anonymizer = createLogAnonymizer({
    salt: 'fixed-salt', home: '/home/meetsu', user: 'meetsu', hostname: 'nuno-x870.lan', dataDir: '/home/meetsu/.local/share/boite2',
    projects: [{ path: '/home/meetsu/projects/secret-game', name: 'secret-game' }, { path: 'D:\\Dev\\Factory', name: 'Factory' }], extra: ['Work Account'],
  });
  const text = anonymizer.text([
    'spawn failed in /home/meetsu/projects/secret-game/src/main.rs and D:\\\\Dev\\\\Factory\\\\Cargo.toml',
    'data at /home/meetsu/.local/share/boite2/logs, config ~/.claude and /home/other/x, C:\\Users\\nuno\\AppData',
    'secret-game crashed on nuno-x870 for meetsu@example.com via Work Account',
    'GET https://api.anthropic.com/v1/messages 529, https://git.net.tasbem.ch/nuno/brain.git refused, https://github.com/klNuno/boite/pull/3 and https://github.com/beboite/boite/issues/9',
    'peer 192.168.1.39 and 100.64.0.15:3773, loopback 127.0.0.1:3773, build 10.0.19045.4529, v1.2.3, at 14:03:22, mac aa:bb:cc:dd:ee:ff, fe80::1c2b:3a4d',
    'thread thr_yrbzgyt5xjtjbq334d7m turn trn_1f992a9ph60nzwzzp8sv',
    'opened file:///home/meetsu/projects/secret-game/index.html.',
  ].join('\n'));
  expect(text).toMatch(/opened file:\/\/<project:[0-9a-f]{6}>\/index\.html\.$/m);
  for (const personal of ['meetsu', 'secret-game', 'Factory', 'nuno-x870', 'example.com', 'Work Account', 'tasbem', 'klNuno', '192.168.1.39', '100.64.0.15', 'other', 'C:\\Users\\nuno', 'aa:bb:cc', 'fe80']) {
    expect(text).not.toContain(personal);
  }
  for (const kept of ['https://api.anthropic.com/v1/messages', 'beboite/boite/issues/9', '127.0.0.1:3773', '10.0.19045.4529', 'v1.2.3', '14:03:22', 'thr_yrbzgyt5xjtjbq334d7m', 'trn_1f992a9ph60nzwzzp8sv', '<data>/logs', '~/.claude', '<user>', '<host>', '<email>', '<ip>']) {
    expect(text).toContain(kept);
  }
  // The same project gets the same placeholder everywhere, by path and by name.
  const placeholders = text.match(/<project:[0-9a-f]{6}>/g) ?? [];
  expect(new Set(placeholders).size).toBe(2);
  expect(anonymizer.project('/home/meetsu/projects/secret-game')).toBe(placeholders[0]!);
  // Stable per installation, different across installations.
  expect(createLogAnonymizer({ salt: 'fixed-salt', projects: [{ path: '/home/meetsu/projects/secret-game', name: 'x' }] }).project('/home/meetsu/projects/secret-game')).toBe(placeholders[0]!);
  expect(createLogAnonymizer({ salt: 'other-salt' }).project('/home/meetsu/projects/secret-game')).not.toBe(placeholders[0]!);
});

test('a stored line from any origin parses, bounds its fields and formats on one readable line', () => {
  const line = JSON.stringify({ id: 'r:1', runId: 'r', at: Date.UTC(2026, 9, 10, 14, 3, 22, 120), level: 'error', origin: 'shell', source: 'watchdog', event: 'shell.main-thread.blocked',
    message: 'The main thread has not answered for 6.2 s', threadId: 'thr_a', providerId: 'claude', model: 'claude-opus-5-5', parentThreadId: 'thr_p', durationMs: 6200,
    data: { command: 'notify', blockedMs: 6200, nested: { no: 1 }, 'bad key': 1, token: 'x' } });
  const record = parseLogRecord(line)!;
  expect(record.data).toEqual({ command: 'notify', blockedMs: 6200 });
  expect(formatLogLine(record)).toBe('2026-10-10 14:03:22.120Z ERROR shell watchdog/shell.main-thread.blocked [thr_a claude/claude-opus-5-5 <thr_p] (6.2 s) The main thread has not answered for 6.2 s {command=notify, blockedMs=6200}');
  expect(parseLogRecord('{"id":1}')).toBeNull();
  expect(parseLogRecord('{"broken')).toBeNull();
  expect(parseLogRecord(JSON.stringify({ id: 'a', runId: 'r', at: 1, level: 'info', source: 's', event: 'e', message: 'm' }))!.origin).toBe('core');
});

test('agents read anonymized diagnostics of the app and their own family, until the owner turns access off', async () => {
  const harness = await startTestCore();
  try {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    const { threadId: other } = await echoThread(harness, owner, 'other thread');
    harness.core.logs.error(`spawn failed in ${join(harness.dataDir, 'deep', 'file.ts')} for ${homedir()}`, { source: 'test', event: 'test.app' });
    harness.core.logs.warn('mine', { source: 'test', event: 'test.mine', threadId, data: { where: join(harness.dataDir, 'x') } });
    harness.core.logs.warn('theirs', { source: 'test', event: 'test.theirs', threadId: other });
    const agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
    try {
      // The records about no thread and its own, never another conversation's.
      const app = await agent.call('diagnostics.logs', { threadId, minLevel: 'warn' });
      expect(app.map(record => record.event)).toEqual(expect.arrayContaining(['test.app', 'test.mine']));
      expect(app.map(record => record.event)).not.toContain('test.theirs');
      expect(JSON.stringify(app)).not.toContain(harness.dataDir);
      const mineRecord = app.find(record => record.event === 'test.mine')!;
      expect(mineRecord).toMatchObject({ providerId: 'echo', threadId });
      expect(String(mineRecord.data?.where)).toMatch(/^<project:[0-9a-f]{6}>/);
      const family = await agent.call('diagnostics.logs', { threadId, scope: 'thread', minLevel: 'warn' });
      expect(family.map(record => record.event)).toEqual(['test.mine']);
      // An agent speaks for its own thread only, and core.logs stays the owner's.
      for (const [method, params] of [['diagnostics.logs', { threadId: other }], ['diagnostics.logs', {}], ['core.logs', { threadId }]] as const) {
        try { await agent.call(method, params as never); throw new Error(`${method} accepted`); }
        catch (error) { expect((error as { rpc?: { code: number } }).rpc?.code).toBe(RpcErrorCode.Refused); }
      }
      const summary = await agent.call('diagnostics.summary', { threadId });
      expect(summary.problems.find(problem => problem.event === 'test.app')).toMatchObject({ level: 'error', count: 1 });
      expect(summary.threads.map(thread => thread.threadId)).toEqual([threadId]);
      expect(JSON.stringify(summary)).not.toContain(other);
      const exported = await agent.call('diagnostics.export', { threadId });
      // Its own refused call may name the other thread; that thread's records and listing stay out.
      expect(exported.text).not.toContain('test.theirs');
      expect(exported.text).not.toMatch(new RegExp(`^${other} `, 'm'));
      expect(exported.text).not.toContain('## core-output.log');
      expect((await owner.call('diagnostics.summary', {})).threads.map(thread => thread.threadId)).toEqual(expect.arrayContaining([threadId, other]));
      expect(summary.environment.providers.some(provider => provider.id === 'echo')).toBe(true);
      await owner.call('settings.set', { agentLogAccess: false });
      try { await agent.call('diagnostics.logs', { threadId }); throw new Error('accepted while off'); }
      catch (error) { expect((error as Error).message).toContain('turned off agent access'); }
    } finally { agent.close(); }
  } finally { await harness.stop(); }
});

test('the export is one readable anonymized file with environment, problems, threads, raw tails and the timeline', async () => {
  const harness = await startTestCore();
  try {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    writeFileSync(join(harness.dataDir, 'core-output.log'), `boot line\nfailed reading ${join(harness.dataDir, 'journal.db')}\n`);
    harness.core.logs.error('provider exited with code 3', { source: 'echo', event: 'provider.exited', threadId, durationMs: 1500, data: { exitCode: 3 } });
    harness.core.logs.error('provider exited with code 3', { source: 'echo', event: 'provider.exited', threadId, data: { exitCode: 3 } });
    const result = await owner.call('diagnostics.export', {});
    expect(result.name).toMatch(/^boite-diagnostics-\d{8}-\d{6}-\d{3}\.txt$/);
    expect(result.path).not.toBeNull();
    expect(readFileSync(result.path!, 'utf8')).toBe(result.text);
    for (const section of ['## Environment', '## Agents', '## Settings', '## Problems', '## Threads', '## Log files', '## core-output.log', '## Timeline']) expect(result.text).toContain(section);
    expect(result.text).toContain('2x ERROR core/echo/provider.exited');
    expect(result.text).toMatch(new RegExp(`${threadId} echo/echo .*errors=2`));
    expect(result.text).toContain('(1.5 s) provider exited with code 3 {exitCode=3}');
    expect(result.text).toContain('failed reading <project:');
    expect(result.text).not.toContain(harness.dataDir);
    // Oldest first in the timeline.
    const timeline = result.text.split('## Timeline')[1]!;
    expect(timeline.indexOf('Core started')).toBeLessThan(timeline.indexOf('provider exited'));
    const body = renderIssueBody('It froze', result, 2000);
    expect(body.length).toBeLessThanOrEqual(2000);
    expect(body).toStartWith('### What happened\n\nIt froze');
    expect(body).toContain('provider.exited');
  } finally { await harness.stop(); }
});

test('an issue is a draft until submitted, and without gh the user gets a prefilled link', async () => {
  const harness = await startTestCore();
  try {
    harness.core.diagnostics.ghCommand = join(harness.dataDir, 'no-such-gh');
    const owner = await harness.connect();
    const draft = await owner.call('diagnostics.issue', { title: `Window froze in ${harness.dataDir}`, description: 'It stopped answering after a turn.' });
    expect(draft).toMatchObject({ repository: 'beboite/boite', url: null, gh: 'missing', error: null });
    expect(draft.title).not.toContain(harness.dataDir);
    expect(draft.body).toContain('### Environment');
    expect(new URL(draft.prefillUrl).searchParams.get('title')).toBe(draft.title);
    const submitted = await owner.call('diagnostics.issue', { title: 'Window froze', description: 'x', includeLogs: false, submit: true });
    expect(submitted.url).toBeNull();
    expect(submitted.error).toContain('not installed');
    expect(submitted.body).not.toContain('### Environment');
    for (const params of [{ title: 'no', description: 'x' }, { title: 'Valid title', description: '' }, { title: 'two\nlines', description: 'x' }]) {
      try { await owner.call('diagnostics.issue', params); throw new Error('accepted'); }
      catch (error) { expect((error as { rpc?: { code: number } }).rpc?.code).toBe(RpcErrorCode.InvalidParams); }
    }
  } finally { await harness.stop(); }
});

test('clients report their own errors as ui records, bounded per connection, and a phone may too', async () => {
  const harness = await startTestCore();
  try {
    const owner = await harness.connect();
    const accepted = await owner.call('diagnostics.report', { records: [{ level: 'error', at: Date.now(), source: 'render', event: 'ui.error', message: 'TypeError: x is undefined', data: { stack: 'at App.svelte:3' } }] });
    expect(accepted).toEqual({ accepted: 1 });
    const [record] = await owner.call('core.logs', { origin: 'ui', limit: 1 });
    expect(record).toMatchObject({ origin: 'ui', source: 'render', event: 'ui.error', message: 'TypeError: x is undefined' });
    expect(record?.data?.stack).toBe('at App.svelte:3');
    let total = 0;
    for (let batch = 0; batch < 8; batch += 1) {
      const records = Array.from({ length: 50 }, (_, index) => ({ level: 'warn' as const, at: Date.now(), source: 'rpc', event: 'ui.rpc-failed', message: `call ${batch}:${index} failed` }));
      total += (await owner.call('diagnostics.report', { records })).accepted;
    }
    expect(total).toBe(299);
    expect((await owner.call('core.logs', { source: 'diagnostics', limit: 5 })).map(entry => entry.event)).toContain('diagnostics.report-throttled');
    const { grant } = await owner.call('pairing.grant', {});
    const phone = await connect(harness.url, '', { grant });
    try {
      expect(await phone.call('diagnostics.report', { records: [{ level: 'info', at: Date.now(), source: 'socket', event: 'ui.reconnected', message: 'Reconnected after 4 s' }] })).toEqual({ accepted: 1 });
      try { await phone.call('diagnostics.summary', {}); throw new Error('accepted'); }
      catch (error) { expect((error as { rpc?: { code: number } }).rpc?.code).toBe(RpcErrorCode.Refused); }
    } finally { phone.close(); }
    try { await owner.call('diagnostics.report', { records: [] }); throw new Error('accepted'); }
    catch (error) { expect((error as { rpc?: { code: number } }).rpc?.code).toBe(RpcErrorCode.InvalidParams); }
  } finally { await harness.stop(); }
});

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
    const owned = (await run(['logs', '--data-dir', harness.dataDir, '--min-level', 'warn', '--since', '10m'])).trim().split('\n');
    expect(owned.at(-2)).toContain('test/test.first');
    expect(owned.at(-1)).toContain('ERROR core  test/test.second');
    const agentEnv = { BOITE_CORE_URL: harness.url, BOITE_AGENT_TOKEN: harness.core.agents.tokenFor(threadId), BOITE_THREAD_ID: threadId };
    expect(await run(['logs', '--mine', '--min-level', 'warn'], agentEnv)).toContain('first warning');
    expect(await run(['logs', 'problems'], agentEnv)).toContain('1x error core/test/test.second');
    mkdirSync(join(harness.dataDir, 'out'));
    const exported = await run(['logs', 'export', '--out', 'out/report.txt'], agentEnv);
    expect(exported).toContain(`written: ${join(harness.dataDir, 'out', 'report.txt')}`);
    expect(readFileSync(join(harness.dataDir, 'out', 'report.txt'), 'utf8')).toContain('## Timeline');
    expect(await run(['logs', 'help'], agentEnv)).toContain('boite logs: Boite\'s own diagnostics');
  } finally { await harness.stop(); }
});

test('records about a thread name its agent, and a guide session lists the built-in skill', async () => {
  const harness = await startTestCore();
  try {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    harness.core.logs.info('about the thread', { source: 'test', event: 'test.identity', threadId });
    const [record] = await owner.call('core.logs', { source: 'test', limit: 1 });
    expect(record).toMatchObject({ threadId, providerId: 'echo' });
    const { builtinSkills } = await import('../src/builtin-skills.ts');
    const [skill] = builtinSkills(harness.dataDir);
    expect(skill?.name).toBe('boite-report-issue');
    expect(readFileSync(skill!.path, 'utf8')).toStartWith('---\nname: boite-report-issue\n');
  } finally { await harness.stop(); }
});
