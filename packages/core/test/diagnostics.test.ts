import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogAnonymizer, formatLogDuration, formatLogLine, parseLogRecord, RpcErrorCode, validateDiagnosticReport } from '@boite/contracts';
import { connect } from '../src/client.ts';
import type { Core } from '../src/core.ts';
import { Diagnostics, renderIssueBody } from '../src/diagnostics.ts';
import { echoThread, startTestCore } from './harness.ts';

test('the anonymizer replaces paths, names, addresses and private hosts and keeps ids and public services', () => {
  const anonymizer = createLogAnonymizer({
    salt: 'fixed-salt', home: '/home/meetsu', user: 'meetsu', hostname: 'nuno-x870.lan', dataDir: '/home/meetsu/.local/share/boite2',
    projects: [{ path: '/home/meetsu/projects/secret-game', name: 'secret-game' }, { path: 'D:\\Dev\\Factory', name: 'Factory' }], extra: ['Work Account'],
  });
  const text = anonymizer.text([
    'spawn failed in /home/meetsu/projects/secret-game/src/main.rs and D:\\Dev\\Factory\\Cargo.toml',
    'data at /home/meetsu/.local/share/boite2/logs, config ~/.claude and /home/other/x, C:\\Users\\nuno\\AppData',
    'secret-game crashed on nuno-x870 for meetsu@example.com via Work Account',
    'GET https://api.anthropic.com/v1/messages 529, https://git.net.tasbem.ch/nuno/brain.git refused, https://github.com/klNuno/boite/pull/3 and https://github.com/mtsu-dev/boite/issues/9',
    'peer 192.168.1.39 and 100.64.0.15:3773, loopback 127.0.0.1:3773, build 10.0.19045.4529, v1.2.3, at 14:03:22, mac aa:bb:cc:dd:ee:ff, fe80::1c2b:3a4d',
    'thread thr_yrbzgyt5xjtjbq334d7m turn trn_1f992a9ph60nzwzzp8sv',
    'opened file:///home/meetsu/projects/secret-game/index.html.',
    'loaded file:///D:/Dev/Factory/assets/logo.png',
    'GET https://api.github.com/repos/acme/hidden-repo/pulls 404',
    'kept meetsu-notes.txt and secret-game-backup',
    'profile C:\\Users\\John Doe\\AppData and /users/bobby/x',
  ].join('\n'));
  expect(text).toMatch(/kept <user>-notes\.txt and <project:[0-9a-f]{6}>-backup$/m);
  // An API path names the owner and repository one segment later.
  expect(text).toMatch(/api\.github\.com\/repos\/<owner:[0-9a-f]{6}>\/<repo:[0-9a-f]{6}>\/pulls 404/);
  expect(text).toMatch(/opened file:\/\/<project:[0-9a-f]{6}>\/index\.html\.$/m);
  // A drive path keeps all three slashes, and its prefix is still found.
  expect(text).toMatch(/loaded file:\/\/\/<project:[0-9a-f]{6}>\/assets\/logo\.png$/m);
  for (const personal of ['Doe', 'bobby', 'meetsu', 'secret-game', 'Factory', 'nuno-x870', 'example.com', 'Work Account', 'tasbem', 'klNuno', '192.168.1.39', '100.64.0.15', 'other', 'C:\\Users\\nuno', 'aa:bb:cc', 'fe80']) {
    expect(text).not.toContain(personal);
  }
  for (const kept of ['https://api.anthropic.com/v1/messages', 'mtsu-dev/boite/issues/9', '127.0.0.1:3773', '10.0.19045.4529', 'v1.2.3', '14:03:22', 'thr_yrbzgyt5xjtjbq334d7m', 'trn_1f992a9ph60nzwzzp8sv', '<data>/logs', '~/.claude', '<user>', '<host>', '<email>', '<ip>']) {
    expect(text).toContain(kept);
  }
  // A client chooses its record's source and event: they are anonymized too.
  const reported = anonymizer.record({ id: 'a', runId: 'r', at: 1, level: 'warn', origin: 'ui', source: 'meetsu', event: 'secret-game.failed', message: 'm' });
  expect(`${reported.source} ${reported.event}`).not.toMatch(/meetsu|secret-game/);
  // The core's own names and a model id keep their shape, whatever a project is called.
  const named = createLogAnonymizer({ salt: 'fixed-salt', projects: [{ path: '/srv/process', name: 'process' }, { path: '/srv/opus', name: 'opus' }] });
  expect(named.record({ id: 'a', runId: 'r', at: 1, level: 'warn', source: 'process', event: 'process.exited', model: 'claude-opus-5-5', message: 'process' })).toMatchObject({ source: 'process', event: 'process.exited', model: 'claude-opus-5-5', message: expect.stringMatching(/^<project:/) });
  // The same project gets the same placeholder everywhere, by path and by name.
  const placeholders = text.match(/<project:[0-9a-f]{6}>/g) ?? [];
  expect(new Set(placeholders).size).toBe(2);
  expect(anonymizer.project('/home/meetsu/projects/secret-game')).toBe(placeholders[0]!);
  // Stable per installation, different across installations.
  expect(createLogAnonymizer({ salt: 'fixed-salt', projects: [{ path: '/home/meetsu/projects/secret-game', name: 'x' }] }).project('/home/meetsu/projects/secret-game')).toBe(placeholders[0]!);
  expect(createLogAnonymizer({ salt: 'other-salt' }).project('/home/meetsu/projects/secret-game')).not.toBe(placeholders[0]!);
});

test('a name equal to a placeholder word leaves the placeholders whole', () => {
  const anonymizer = createLogAnonymizer({ salt: 'fixed-salt', user: 'email', hostname: 'host.lan' });
  expect(anonymizer.text('mail me@example.com from host.lan')).toBe('mail <email> from <host>');
  // A user name with a space, its path cut at the end of the line: no part survives.
  expect(createLogAnonymizer({ salt: 'fixed-salt', user: 'John Doe' }).text('home C:\\Users\\John Doe')).not.toMatch(/John|Doe/);
  // An account label is a whole word too: `ann` leaves `banner` alone.
  expect(createLogAnonymizer({ salt: 'fixed-salt', extra: ['ann'] }).text('banner by ann')).toMatch(/^banner by <private:[0-9a-f]{6}>$/);
});

test('a thread folder beside a project, sharing only its name prefix, gets its own placeholder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-anon-'));
  try {
    const core = {
      dataDir: join(dir, 'data'), logs: { directory: join(dir, 'logs'), warn() {} }, accounts: { list: () => [] },
      projects: { list: () => [{ path: '/srv/proj', name: 'proj' }] }, journal: { listThreads: () => [{ cwd: '/srv/proj2/secret-client' }] },
    } as unknown as Core;
    expect(new Diagnostics(core).anonymizer().text('opened /srv/proj2/secret-client/notes.md')).not.toContain('secret-client');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stored line from any origin parses, bounds its fields and formats on one readable line', () => {
  const line = JSON.stringify({ id: 'r:1', runId: 'r', at: Date.UTC(2026, 9, 10, 14, 3, 22, 120), level: 'error', origin: 'shell', source: 'watchdog', event: 'shell.main-thread.blocked',
    message: 'The main thread has not answered for 6.2 s', threadId: 'thr_a', providerId: 'claude', model: 'claude-opus-5-5', parentThreadId: 'thr_p', durationMs: 6200,
    data: { command: 'notify', blockedMs: 6200, nested: { no: 1 }, 'bad key': 1, token: 'x' } });
  const record = parseLogRecord(line)!;
  expect(record.data).toEqual({ command: 'notify', blockedMs: 6200 });
  expect(formatLogLine(record)).toBe('2026-10-10 14:03:22.120Z ERROR shell watchdog/shell.main-thread.blocked [thr_a claude/claude-opus-5-5 <thr_p] (6.2 s) The main thread has not answered for 6.2 s {command=notify, blockedMs=6200}');
  // Seconds that round up carry into the minutes.
  expect(formatLogDuration(119_500)).toBe('2 min 0 s');
  expect(formatLogDuration(61_000)).toBe('1 min 1 s');
  // A line the shell or a client wrote is redacted on the way in, with the secrets known now.
  const leaky = parseLogRecord(JSON.stringify({ id: 'a', runId: 'r', at: 1, level: 'warn', source: 's', event: 'e', message: 'Authorization: Bearer abcdefghijklmnop123456 with hunter2-value', data: { note: 'hunter2-value' } }), 'shell', ['hunter2-value'])!;
  expect(JSON.stringify(leaky)).not.toContain('abcdefghijklmnop123456');
  expect(JSON.stringify(leaky)).not.toContain('hunter2-value');
  // A secret across the message bound is redacted before the cut, not left as a prefix.
  const long = parseLogRecord(JSON.stringify({ id: 'a', runId: 'r', at: 1, level: 'warn', source: 's', event: 'e', message: `${'x'.repeat(4090)} straddling-secret-value` }), 'shell', ['straddling-secret-value'])!;
  expect(long.message).not.toContain('stra');
  expect(parseLogRecord('{"id":1}')).toBeNull();
  // A client's own source, event and message are redacted on the way in, and when read back.
  const [named] = validateDiagnosticReport({ records: [{ level: 'warn', at: 1, source: 'tok-9f8e7d6c5b', event: 'ui.tok-9f8e7d6c5b', message: 'failed with tok-9f8e7d6c5b' }] }, ['tok-9f8e7d6c5b']);
  expect(JSON.stringify(named)).not.toContain('tok-9f8e7d6c5b');
  expect(JSON.stringify(parseLogRecord(JSON.stringify({ id: 'a', runId: 'r', at: 1, level: 'info', source: 'tok-9f8e7d6c5b', event: 'e', message: 'm' }), 'ui', ['tok-9f8e7d6c5b']))).not.toContain('tok-9f8e7d6c5b');
  expect(parseLogRecord(JSON.stringify({ id: '', runId: 'r', at: 1, level: 'info', source: 's', event: 'e', message: 'm' }))).toBeNull();
  expect(parseLogRecord(JSON.stringify({ id: 'a', runId: 'r', at: -5, level: 'info', source: 's', event: 'e', message: 'm' }))).toBeNull();
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
      // The owner naming a thread reads that thread's family, never every conversation.
      expect((await owner.call('diagnostics.summary', { threadId })).threads.map(thread => thread.threadId)).toEqual([threadId]);
      expect((await owner.call('diagnostics.logs', { threadId, minLevel: 'warn' })).map(record => record.event)).not.toContain('test.theirs');
      // The text is the agent's; the file's folder names the owner's home.
      expect(exported.path).toBeNull();
      expect((await owner.call('diagnostics.export', {})).path).not.toBeNull();
      expect(summary.environment.providers.some(provider => provider.id === 'echo')).toBe(true);
      await owner.call('settings.set', { agentLogAccess: false });
      for (const [method, params] of [['diagnostics.logs', { threadId }], ['diagnostics.summary', { threadId }], ['diagnostics.export', { threadId }], ['diagnostics.issue', { threadId, title: 'The window froze', description: 'x' }]] as const) {
        try { await agent.call(method, params as never); throw new Error(`${method} accepted while off`); }
        catch (error) { expect((error as Error).message).toContain('turned off agent access'); }
      }
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

test('a problem shows its newest message, also when two records share their millisecond', async () => {
  const harness = await startTestCore();
  try {
    const at = Date.now();
    harness.core.logs.record('warn', 'the older one', { source: 'test', event: 'test.same-instant' }, at);
    harness.core.logs.record('warn', 'the newer one', { source: 'test', event: 'test.same-instant' }, at);
    const summary = await harness.core.diagnostics.summary({});
    expect(summary.problems.find(problem => problem.event === 'test.same-instant')).toMatchObject({ count: 2, message: 'the newer one' });
  } finally { await harness.stop(); }
});

test('an issue is a draft until submitted, and without gh the user gets a prefilled link', async () => {
  const harness = await startTestCore();
  try {
    harness.core.diagnostics.ghCommand = join(harness.dataDir, 'no-such-gh');
    // A raw tail that itself prints the marker must not stand in for the timeline.
    writeFileSync(join(harness.dataDir, 'core-output.log'), 'boot\n## Timeline (fake)\n\nfake-tail-line\n');
    harness.core.logs.warn('the real timeline line', { source: 'test', event: 'test.timeline' });
    const owner = await harness.connect();
    const draft = await owner.call('diagnostics.issue', { title: `Window froze in ${harness.dataDir}`, description: 'It stopped answering after a turn.' });
    expect(draft.body).toContain('the real timeline line');
    expect(draft.body).not.toContain('fake-tail-line');
    expect(draft).toMatchObject({ repository: 'mtsu-dev/boite', url: null, gh: 'missing', error: null });
    expect(draft.title).not.toContain(harness.dataDir);
    expect(draft.body).toContain('### Environment');
    expect(new URL(draft.prefillUrl).searchParams.get('title')).toBe(draft.title);
    const submitted = await owner.call('diagnostics.issue', { title: 'Window froze', description: 'x', includeLogs: false, submit: true });
    expect(submitted.url).toBeNull();
    expect(submitted.error).toContain('not installed');
    expect(submitted.body).not.toContain('### Environment');
    // An agent drafts; it never publishes under the owner's GitHub login, even with gh ready.
    harness.core.diagnostics.ghCommand = 'gh-must-not-run';
    const { threadId } = await echoThread(harness, owner);
    const agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
    try {
      const refused = await agent.call('diagnostics.issue', { threadId, title: 'Window froze', description: 'x', includeLogs: false, submit: true });
      expect(refused).toMatchObject({ url: null, error: expect.stringContaining('an agent cannot publish') });
      expect(refused.prefillUrl).toStartWith('https://github.com/mtsu-dev/boite/issues/new?');
    } finally { agent.close(); }
    for (const params of [{ title: 'no', description: 'x' }, { title: 'Valid title', description: '' }, { title: 'two\nlines', description: 'x' }]) {
      try { await owner.call('diagnostics.issue', params); throw new Error('accepted'); }
      catch (error) { expect((error as { rpc?: { code: number } }).rpc?.code).toBe(RpcErrorCode.InvalidParams); }
    }
  } finally { await harness.stop(); }
});

test('clients report their own errors as ui records, bounded per connection, and a phone may too', async () => {
  const harness = await startTestCore();
  try {
    // The budget is per clock minute: start well inside one, or crossing it mid-test refills the budget.
    const left = 60_000 - (Date.now() % 60_000);
    if (left < 15_000) await Bun.sleep(left + 50);
    const owner = await harness.connect();
    const accepted = await owner.call('diagnostics.report', { records: [{ level: 'error', at: Date.now(), source: 'render', event: 'ui.error', message: 'TypeError: x is undefined', data: { stack: 'at App.svelte:3' } }] });
    expect(accepted).toEqual({ accepted: 1 });
    const [record] = await owner.call('core.logs', { origin: 'ui', limit: 1 });
    expect(record).toMatchObject({ origin: 'ui', source: 'render', event: 'ui.error', message: 'TypeError: x is undefined' });
    expect(record?.data?.stack).toBe('at App.svelte:3');
    let total = 0;
    const minute = Math.floor(Date.now() / 60_000);
    for (let batch = 0; batch < 8; batch += 1) {
      const records = Array.from({ length: 50 }, (_, index) => ({ level: 'warn' as const, at: Date.now(), source: 'rpc', event: 'ui.rpc-failed', message: `call ${batch}:${index} failed` }));
      total += (await owner.call('diagnostics.report', { records })).accepted;
    }
    // A runner slow enough to cross into the next minute got a refill: the bound holds per minute, not exactly 299.
    if (Math.floor(Date.now() / 60_000) === minute) expect(total).toBe(299);
    else expect(total).toBeLessThan(400);
    expect((await owner.call('core.logs', { source: 'diagnostics', limit: 5 })).map(entry => entry.event)).toContain('diagnostics.report-throttled');
    const { grant } = await owner.call('pairing.grant', {});
    const phone = await connect(harness.url, '', { grant });
    try {
      // A wrong phone clock does not sort its record ahead of every real one.
      expect(await phone.call('diagnostics.report', { records: [{ level: 'info', at: 1e15, source: 'socket', event: 'ui.reconnected', message: 'Reconnected after 4 s' }] })).toEqual({ accepted: 1 });
      const [reconnected] = await owner.call('core.logs', { origin: 'ui', search: 'ui.reconnected', limit: 1 });
      expect(reconnected!.at).toBeLessThanOrEqual(Date.now());
      // Nor can it file a record under a thread that does not exist.
      await phone.call('diagnostics.report', { records: [{ level: 'error', at: Date.now(), source: 'socket', event: 'ui.invented', message: 'blame', threadId: 'thr_invented' }] });
      const [invented] = await owner.call('core.logs', { origin: 'ui', search: 'ui.invented', limit: 1 });
      expect(invented?.threadId).toBeUndefined();
      try { await phone.call('diagnostics.summary', {}); throw new Error('accepted'); }
      catch (error) { expect((error as { rpc?: { code: number } }).rpc?.code).toBe(RpcErrorCode.Refused); }
    } finally { phone.close(); }
    try { await owner.call('diagnostics.report', { records: [] }); throw new Error('accepted'); }
    catch (error) { expect((error as { rpc?: { code: number } }).rpc?.code).toBe(RpcErrorCode.InvalidParams); }
  } finally { await harness.stop(); }
}, 30_000);

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
    // A folder an agent left where the file goes does not drop the skill from later sessions.
    rmSync(skill!.path); mkdirSync(join(skill!.path, 'inside'), { recursive: true });
    expect(builtinSkills(harness.dataDir)[0]?.name).toBe('boite-report-issue');
    expect(readFileSync(skill!.path, 'utf8')).toStartWith('---\nname: boite-report-issue\n');
    // Rewritten by an agent, same size or not, it is written back.
    const original = readFileSync(skill!.path, 'utf8');
    for (const tampered of ['x'.repeat(original.length), `${original}more`]) {
      writeFileSync(skill!.path, tampered);
      builtinSkills(harness.dataDir);
      expect(readFileSync(skill!.path, 'utf8')).toBe(original);
    }
  } finally { await harness.stop(); }
});
