import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV } from '@boite/contracts';
import { runCli, splitLine } from '../src/cli.ts';
import type { CliIo } from '../src/cli.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnResult } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import { makeAgent } from './agent-fixture.ts';
import type { TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore;
let threadId: string;
let cwd: string;

interface Run {
  code: number;
  out: string;
  err: string;
}

async function boite(args: string[], env: Record<string, string> = {}): Promise<Run> {
  let out = '';
  let err = '';
  const io: CliIo = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    env: {
      [AGENT_ENV.threadId]: threadId,
      [AGENT_ENV.coreUrl]: harness.url,
      [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId),
      ...env,
    },
    cwd,
  };
  const code = await runCli(args, io);
  return { code, out, err };
}

beforeEach(async () => {
  harness = await startTestCore();
  const client = await harness.connect();
  ({ threadId } = await echoThread(harness, client));
  const thread = await client.call('threads.get', { threadId });
  cwd = thread.cwd;
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
});

afterEach(async () => {
  await harness.stop();
});

test('delegate spawn --project reaches the core from a bot looking after several projects', async () => {
  const client = await harness.connect();
  const projects = await client.call('projects.list', {});
  const project = projects[0]!;
  const otherPath = join(harness.dataDir, 'other-project');
  mkdirSync(otherPath);
  const second = await client.call('projects.add', { path: otherPath, name: 'Other' });
  const bot = await makeAgent(harness, client, { projectIds: [project.id, second.id] });
  threadId = bot.threadId;
  await client.call('delegation.configure', { threadId, config: { enabled: true, paused: false, profiles: [], anyModel: true } });
  const run = await boite(['delegate', 'spawn', 'Inspect the project', '--project', project.name, '--json']);
  expect([run.err, run.code]).toEqual(['', 0]);
  expect(JSON.parse(run.out).thread).toMatchObject({ projectId: project.id, cwd: project.path, parentThreadId: threadId });
});

test('splits a trailing line off a path and leaves a drive letter alone', () => {
  expect(splitLine('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12 });
  expect(splitLine('C:\\x\\a.ts')).toEqual({ path: 'C:\\x\\a.ts', line: undefined });
  expect(splitLine('C:\\x\\a.ts:3')).toEqual({ path: 'C:\\x\\a.ts', line: 3 });
});

test('server checks need no thread as owner and remain forbidden to thread agents', async () => {
  writeFileSync(join(harness.dataDir, 'core.json'), JSON.stringify({ port: harness.server.port, host: '127.0.0.1', token: harness.token }), { mode: 0o600 });
  let out = '';
  let err = '';
  const code = await runCli(['server', 'check', '--data-dir', harness.dataDir, '--json'], {
    cwd, env: {}, out: text => { out += text; }, err: text => { err += text; }
  });
  expect(code).toBe(0); expect(err).toBe('');
  expect(JSON.parse(out).currentVersion).toBe(harness.core.version);
  const agent = await boite(['server', 'update']);
  expect(agent.code).toBe(1); expect(agent.err).toContain('core.updateStatus');
});

test('threads commands discover, send and reply using the calling thread identity, and the old agents spelling still answers', async () => {
  const client = await harness.connect();
  const other = (await echoThread(harness, client, 'VM worker')).threadId;
  const config = { mode: 'brief' as const, resources: 'VM', remote: false, paused: false };
  harness.core.coordination.configure(threadId, config);
  harness.core.coordination.configure(other, config);
  const listed = await boite(['threads', '--json']);
  expect(listed.code).toBe(0);
  const contact = JSON.parse(listed.out).agents[0];
  expect(contact).toMatchObject({ status: 'idle', lastCompletedAt: null, projectArchived: false, paused: false });
  expect((await boite(['threads', 'list'])).out).toContain('contacting this inactive thread is allowed but discouraged');
  // Bots' brains and the user's notes still say `boite agents list`: it answers the same, with nothing extra.
  const legacy = await boite(['agents', 'list', '--json']);
  expect([legacy.code, legacy.err, JSON.parse(legacy.out).agents]).toEqual([0, '', JSON.parse(listed.out).agents]);
  expect((await boite(['agents', 'inbox'])).code).toBe(0);
  const sent = await boite(['threads', 'send', `${contact.coreId}/${other}`, 'Can I restart?', '--json']);
  expect(sent.code).toBe(0);
  const letter = JSON.parse(sent.out);
  expect(letter.from.threadId).toBe(threadId);
  const incoming = await harness.core.coordination.send({ threadId: other, to: harness.core.coordination.get(threadId).self, text: 'Wait', replyTo: letter.id, requestId: 'reply' });
  const reply = await boite(['threads', 'reply', incoming.id, 'Understood', '--json']);
  expect(reply.code).toBe(0);
  expect(JSON.parse(reply.out).replyTo).toBe(incoming.id);
  expect((await boite(['threads', 'inbox'])).out).toContain(`<- from ${other}`);
  harness.core.coordination.pause(other);
  const warned = await boite(['threads', 'send', other, 'Another question']);
  expect(warned.code).toBe(0);
  expect(warned.out).toContain('coordination paused');
  const direct = await boite(['threads', 'send', `${contact.coreId}/${other}`, 'Direct address']);
  expect(direct.code).toBe(0);
  expect(direct.out).toContain('recipient activity is unknown');
});

test('threads reach each other by a short address, find by chat, read and wait for an answer', async () => {
  const client = await harness.connect();
  const other = (await echoThread(harness, client, 'VM worker')).threadId;
  harness.core.journal.putMessage({ id: 'said', threadId: other, turnId: 'history', role: 'user', state: 'complete', createdAt: Date.now(), parts: [{ type: 'text', text: 'the staging database keeps timing out' }] });
  const listed = await boite(['threads', 'list']);
  expect(listed.out).toContain(`${other}  "VM worker"`);
  const found = await boite(['threads', 'find', 'staging', 'timing']);
  expect(found.out).toContain(other);
  expect(found.out).toContain('> the staging database keeps timing out');
  const read = await boite(['threads', 'read', other, '--last', '5']);
  expect(read.out).toContain('user:\n    the staging database keeps timing out');
  const self = harness.core.coordination.get(threadId).self;
  // The answer goes out once the CLI waits for it: one that came first would wake this idle thread
  // with a turn instead. The CLI reaches its wait late here, as it did on a loaded macOS runner.
  const coordination = harness.core.coordination;
  const wait = coordination.wait.bind(coordination);
  let waiting = false;
  const late = spyOn(coordination, 'wait').mockImplementation(async (...args) => {
    await Bun.sleep(500);
    const result = wait(...args);
    waiting = true;
    return result;
  });
  const answering = waitFor(() => waiting, 10_000).then(() => coordination.send({ threadId: other, to: self, text: 'Restart it, I am done.', requestId: 'answer' }));
  const sent = await boite(['threads', 'send', other, 'May I restart staging?', '--wait', '--timeout', '10']);
  await answering;
  late.mockRestore();
  expect(sent.code).toBe(0);
  expect(sent.out).toContain('Restart it, I am done.');
  expect((await boite(['threads', 'log', other])).out).toContain('-> to');
  expect((await boite(['threads', 'send', 'thr_nobody', 'hi'])).err).toContain('no reachable thread has this address');
});

test('a send retried with the same --request-id is the same letter, and without it a new one', async () => {
  const client = await harness.connect();
  const other = (await echoThread(harness, client, 'VM worker')).threadId;
  const config = { mode: 'brief' as const, resources: 'VM', remote: false, paused: false };
  harness.core.coordination.configure(threadId, config);
  harness.core.coordination.configure(other, config);
  const contact = JSON.parse((await boite(['threads', '--json'])).out).agents[0];
  const args = ['threads', 'send', `${contact.coreId}/${other}`, 'Can I restart?', '--request-id', 'cli_send_retry_001', '--json'];
  const first = await boite(args);
  expect(first.code).toBe(0);
  const again = await boite(args);
  expect(again.code).toBe(0);
  expect(JSON.parse(again.out).id).toBe(JSON.parse(first.out).id);
  const fresh = await boite(['threads', 'send', `${contact.coreId}/${other}`, 'Can I restart?', '--json']);
  expect(JSON.parse(fresh.out).id).not.toBe(JSON.parse(first.out).id);
  const received = harness.core.journal.db.query('SELECT COUNT(*) AS n FROM coordination_letters WHERE thread_id = ?').get(other) as { n: number };
  expect(received.n).toBe(2);
});

test('a bot reads its memory, notes facts, keeps its routines and its desk from its own thread, under bot or the old agent', async () => {
  const client = await harness.connect();
  const worker = threadId;
  const project = harness.core.threads.require(worker).projectId!;
  const { agent, threadId: own } = await makeAgent(harness, client, { projectIds: [project] });
  threadId = own;
  cwd = harness.core.threads.require(own).cwd;
  const noted = await boite(['bot', 'remember', 'Keep', 'prototypes', 'small.', '--json']);
  expect(noted.code).toBe(0);
  expect(JSON.parse(noted.out).noted).toBe('Keep prototypes small.');
  expect(JSON.parse((await boite(['bot', 'memory', '--json'])).out).text).toContain('Keep prototypes small.');
  // The old spelling, as bots' brains still write it.
  expect(JSON.parse((await boite(['agent', 'memory', '--json'])).out).text).toContain('Keep prototypes small.');

  const scheduled = await boite(['bot', 'schedule', JSON.stringify({ name: 'Morning', prompt: 'Read the news', schedule: { kind: 'interval', everyMinutes: 60 } }), '--json']);
  expect(scheduled.code).toBe(0);
  const routine = JSON.parse(scheduled.out) as { id: string; agentId: string };
  expect(routine.agentId).toBe(agent.id);
  const renamed = await boite(['bot', 'schedule', JSON.stringify({ id: routine.id, name: 'Early', prompt: 'Read the news', schedule: { kind: 'interval', everyMinutes: 30 } }), '--json']);
  expect(JSON.parse(renamed.out)).toMatchObject({ id: routine.id, name: 'Early', schedule: { everyMinutes: 30 } });
  expect((JSON.parse((await boite(['bot', 'routines', '--json'])).out) as { id: string }[]).map(r => r.id)).toEqual([routine.id]);
  expect((await boite(['bot', 'unschedule', routine.id])).code).toBe(0);
  expect(harness.core.workforce.records.list('routine')).toEqual([]);

  expect((await boite(['bot', 'watch', worker])).code).toBe(0);
  expect((await client.call('agents.snapshot', {})).watches.map(w => w.threadId)).toEqual([worker]);
  expect((await boite(['bot', 'unwatch', worker])).code).toBe(0);
  expect((await client.call('agents.snapshot', {})).watches).toEqual([]);
  mkdirSync(join(harness.dataDir, 'elsewhere'), { recursive: true });
  const elsewhere = await client.call('projects.add', { path: join(harness.dataDir, 'elsewhere'), name: 'Elsewhere' });
  const outside = await client.call('threads.create', { projectId: elsewhere.id, providerId: 'echo', accountId: harness.core.threads.require(worker).accountId, title: 'Outside' });
  expect((await boite(['bot', 'watch', outside.id])).err).toContain('is not in a project entrusted to Ada');
  expect((await boite(['bot', 'inbox'])).err).toContain('bot expects memory, remember, routines, schedule, unschedule, watch or unwatch');
  // An ordinary thread is no agent's.
  threadId = worker;
  expect((await boite(['bot', 'routines'])).err).toContain("no bot's thread");
});

test('a bot is free to act from its own thread: it reaches threads, asks, draws, attaches, delegates and plans like any thread', async () => {
  const client = await harness.connect();
  const worker = threadId;
  const { threadId: own } = await makeAgent(harness, client, { projectIds: [harness.core.threads.require(worker).projectId!] });
  threadId = own;
  cwd = harness.core.threads.require(own).cwd;
  mkdirSync(cwd, { recursive: true });
  // Its communication starts on, so it finds and messages threads without the owner turning it on.
  expect(harness.core.coordination.config(own)).toMatchObject({ mode: 'brief', remote: true, paused: false });
  harness.core.journal.putMessage({ id: 'said-bot', threadId: worker, turnId: 'history', role: 'user', state: 'complete', createdAt: Date.now(), parts: [{ type: 'text', text: 'the nightly build is red' }] });
  const found = await boite(['threads', 'find', 'nightly']);
  expect([found.code, found.err]).toEqual([0, '']);
  expect(found.out).toContain(worker);
  const sent = await boite(['threads', 'send', worker, 'Is it fixed?', '--json']);
  expect([sent.code, sent.err]).toEqual([0, '']);
  expect(JSON.parse(sent.out).from.threadId).toBe(own);
  const asked = await boite(['ask', 'Ship it?', 'yes', 'no']);
  expect([asked.code, asked.err]).toEqual([0, '']);
  writeFileSync(join(cwd, 'note.md'), '# Note\n');
  const attached = await boite(['attach', 'note.md']);
  expect([attached.code, attached.err]).toEqual([0, '']);
  writeFileSync(join(cwd, 'page.html'), '<!doctype html><title>Page</title><p>Hello</p>');
  const drawn = await boite(['view', 'page.html']);
  expect([drawn.code, drawn.err]).toEqual([0, '']);
  for (const command of [['delegate', 'list'], ['workflow', 'check', '{"name":"x","steps":[{"id":"a","task":"t"}]}'], ['browser', 'help'], ['pr', 'list'], ['threads'], ['settings', 'bot']]) {
    const run = await boite(command);
    expect([command.join(' '), run.code, run.err]).toEqual([command.join(' '), 0, '']);
  }
});

describe('usage', () => {
  test('a bare call and a bad flag exit 2, help exits 0', async () => {
    const bare = await boite([]);
    expect(bare.code).toBe(2);
    expect(bare.err).toContain('usage: boite');
    const flag = await boite(['where', '--nope']);
    expect(flag.code).toBe(2);
    expect(flag.err).toContain('unknown flag --nope');
    const missing = await boite(['where', '--request-id', '--json']);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('--request-id needs a value');
    for (const command of ['unknown', 'constructor', 'toString', '__proto__']) {
      const unknown = await boite([command]);
      expect(unknown.code).toBe(2);
      expect(unknown.err).toContain(`unknown command ${command}`);
      expect(unknown.out).toBe('');
    }
    for (const flag of ['--timeout', '--last', '--before']) {
      const invalid = await boite(['where', flag, '-1']);
      expect(invalid.code).toBe(2);
      expect(invalid.err).toContain(`${flag} needs a number, got -1`);
    }
    const help = await boite(['help']);
    expect(help.code).toBe(0);
    expect(help.err).toContain('usage: boite');
    expect(help.out).toBe('');
    // Help names bots and threads; the old spellings still run but are not shown.
    for (const shown of ['threads find <words>', 'threads send <thread> <text>', 'bot remember <fact>', 'settings bot request', 'threads [list] [--project <p>] [--archived]']) expect(help.err).toContain(shown);
    for (const hidden of ['agents list', 'agents send', 'agent remember', 'settings agent', '--agent <name>']) expect(help.err).not.toContain(hidden);
    // A lone help after a command is the same request, never a question titled "help".
    const ask = await boite(['ask', 'help']);
    expect(ask.code).toBe(0);
    expect(ask.out).toContain('usage: boite');
    const client = await harness.connect();
    expect(await client.call('questions.list', { threadId })).toEqual([]);
  });

  test('outside a thread it says which variable is missing', async () => {
    const run = await boite(['where'], { [AGENT_ENV.threadId]: '' });
    expect(run.code).toBe(1);
    expect(run.err).toContain(AGENT_ENV.threadId);
  });
});

describe('where', () => {
  test('prints the thread in key: value lines', async () => {
    const run = await boite(['where']);
    expect(run.code).toBe(0);
    expect(run.err).toBe('');
    const lines = run.out.trimEnd().split('\n');
    expect(lines[0]).toBe(`thread: ${threadId}`);
    expect(lines).toContain(`cwd: ${cwd}`);
    expect(lines.some((line) => line.startsWith('agent: echo'))).toBe(true);
  });

  test('--json prints the raw result', async () => {
    const run = await boite(['where', '--json']);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.out)).toMatchObject({ threadId, cwd });
    const flags = await boite(['where', '--json', '--multiple', '--worktree', '--wait', '--timeout', '12', '--last', '4', '--before', '3']);
    expect(flags.code).toBe(0);
    expect(JSON.parse(flags.out)).toMatchObject({ threadId, cwd });
  });
});

test('projects add names a relative folder, respects agent permissions and retries without a duplicate', async () => {
  const folder = join(cwd, 'CLI folder');
  mkdirSync(folder);
  harness.core.coordination.configure(threadId, { mode: 'off', resources: 'CLI integration', remote: false, paused: false });
  const refused = await boite(['projects', 'add', 'CLI', 'folder', '--name', 'CLI project', '--json']);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain('communication is off');
  expect(harness.core.projects.registered(folder)).toBeNull();

  harness.core.coordination.configure(threadId, { mode: 'brief', resources: 'CLI integration', remote: true, paused: false });
  const added = await boite(['projects', 'add', 'CLI', 'folder', '--name', 'CLI project', '--json']);
  expect(added.code).toBe(0);
  expect(added.err).toBe('');
  const project = JSON.parse(added.out);
  expect(project).toMatchObject({ name: 'CLI project', path: folder, added: true, current: false });
  const listed = await boite(['projects', '--json']);
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.out).filter((row: { id: string }) => row.id === project.id)).toHaveLength(1);

  harness.core.coordination.configure(threadId, { mode: 'off', resources: 'CLI integration', remote: false, paused: false });
  const again = await boite(['projects', 'add', 'CLI folder', '--name', 'A different name']);
  expect(again.code).toBe(0);
  expect(again.out).toContain('Already a project; nothing changed.');
  expect(harness.core.projects.registered(folder)).toMatchObject({ id: project.id, name: 'CLI project' });
  for (const args of [['projects', 'remove'], ['projects', 'add'], ['projects', 'add', 'CLI folder', '--name', '--json']]) {
    expect((await boite(args)).code).toBe(2);
  }
  const help = await boite(['help']);
  expect(help.err).toContain('projects add <folder>');
  expect(help.err).toContain('--name <name>');
});

describe('panel', () => {
  test('show reaches a subscribed client with the relative path and the line', async () => {
    const watcher = await harness.connect();
    await watcher.call('threads.subscribe', { threadId });
    const requested = watcher.next('panel.requested');
    const run = await boite(['show', 'src/a.ts:2']);
    expect(run.code).toBe(0);
    expect(run.out).toBe('shown: yes\n');
    const event = await requested;
    expect(event.threadId).toBe(threadId);
    expect(event.surface).toEqual({ kind: 'file', path: 'src/a.ts', line: 2 });
  });

  test('a file that does not exist is refused by name', async () => {
    const run = await boite(['show', 'src/missing.ts']);
    expect(run.code).toBe(1);
    expect(run.err).toContain('missing.ts');
  });

  test('nobody watching is said, not hidden', async () => {
    const run = await boite(['open', 'tasks']);
    expect(run.code).toBe(0);
    expect(run.out.startsWith('shown: no')).toBe(true);
  });

  test('browse refuses anything but http and https', async () => {
    const run = await boite(['browse', 'file:///etc/passwd']);
    expect(run.code).toBe(1);
    expect(run.err.startsWith('error: ')).toBe(true);
  });
});

describe('tasks', () => {
  test('add, start, done and list round trip through the thread activity', async () => {
    expect((await boite(['task', 'list'])).out).toBe('tasks: none\n');
    expect((await boite(['task', 'add', 'read', 'the', 'docs'])).out).toBe('t1 [ ] read the docs\n');
    await boite(['task', 'add', 'write tests']);
    expect((await boite(['task', 'start', '2'])).out).toBe('t1 [ ] read the docs\nt2 [>] write tests\n');
    expect((await boite(['task', 'done', 't2'])).out).toBe('t1 [ ] read the docs\nt2 [x] write tests\n');
    const unknown = await boite(['task', 'done', 't9']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toBe('error: no task t9\n');
    expect((await boite(['task', 'remove', '1'])).out).toBe('t2 [x] write tests\n');
    expect((await boite(['task', 'clear'])).out).toBe('tasks: none\n');
  });
});

describe('todos', () => {
  test('add, list and claim', async () => {
    const added = await boite(['todo', 'add', 'ship it']);
    expect(added.code).toBe(0);
    const [id] = added.out.split(' ');
    expect(added.out).toBe(`${id} open ship it\n`);
    expect((await boite(['todo', 'list'])).out).toBe(`${id} open ship it\n`);
    expect((await boite(['todo', 'claim', id ?? ''])).out).toBe(`${id} claimed ship it\n`);
  });
});

describe('status', () => {
  test('outside a repository the refusal names it', async () => {
    const run = await boite(['status']);
    expect(run.code).toBe(1);
    expect(run.err.startsWith('error: ')).toBe(true);
  });
});

describe('from inside a turn', () => {
  // The whole road at once: the echo driver spawns `boite where` through the
  // launcher, the core's environment and PATH lead the dev shim to `bun run
  // core.ts cli`, and the answer comes back as the turn's text.
  test('an agent process finds boite on its PATH and its own thread', async () => {
    const client = await harness.connect();
    await client.call('threads.subscribe', { threadId });
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 30000);
    await client.call('turns.start', { threadId, prompt: '[spawn:boite where]' });
    const done = await finished;
    expect(done.status).toBe('done');
    const thread = await client.call('threads.get', { threadId });
    const assistant = thread.messages[thread.messages.length - 1];
    const text = assistant?.parts.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
    expect(text).toContain(`thread: ${threadId}`);
    expect(text).toContain(`cwd: ${cwd}`);
  }, 40000);
});

describe('access', () => {
  test('another thread id is refused', async () => {
    // Inside a thread `--thread` is no way out to the owner's token in core.json.
    const run = await boite(['where', '--thread', 'thread_other']);
    expect(run.code).toBe(1);
    expect(run.err).toBe(`error: this CLI speaks for thread ${threadId}, not thread thread_other\n`);
  });

  test('its own thread id named out loud is the same call', async () => {
    const run = await boite(['where', '--thread', threadId]);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`thread: ${threadId}`);
  });
});

test('ask draws a card that does not stop the agent, and the answer comes back as the next prompt', async () => {
  const none = await boite(['ask', 'Deploy now?']);
  expect(none.code).toBe(1);
  expect(none.err).toContain('no turn to ask in');

  const client = await harness.connect();
  const first = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
  await client.call('turns.start', { threadId, prompt: 'hello' });
  expect((await first).status).toBe('done');

  const asked = await boite(['ask', 'Deploy now?', 'yes', 'later', '--json']);
  expect(asked.code).toBe(0);
  const { questionId } = JSON.parse(asked.out) as { questionId: string };
  const [question] = await client.call('questions.list', { threadId });
  expect(question).toMatchObject({ id: questionId, text: 'Deploy now?', async: true, allowText: true, multiple: false });
  expect(question?.options.map((option) => option.label)).toEqual(['yes', 'later']);
  // Nobody waits on it: the thread stays idle.
  expect((await client.call('threads.get', { threadId })).status).toBe('idle');

  const next = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
  await client.call('questions.answer', { threadId, questionId, optionIds: ['2'], text: 'after lunch' });
  expect((await next).status).toBe('done');
  const prompts = harness.core.journal.listMessages(threadId).filter((m) => m.role === 'user').map((m) => (m.parts[0]?.type === 'text' ? m.parts[0].text : ''));
  expect(prompts).toEqual(['hello', '> Deploy now?\n\nlater\nafter lunch']);
  const card = harness.core.journal.listMessages(threadId).flatMap((m) => m.parts).find((p) => p.type === 'question');
  expect(card).toMatchObject({ async: true, answer: { optionIds: ['2'], text: 'after lunch' } });
});

test('ask list reads its own pending questions without publishing a question named list', async () => {
  const client = await harness.connect();
  const empty = await boite(['ask', 'list', '--json']);
  expect(empty).toEqual({ code: 0, out: '[]\n', err: '' });
  const finished = client.next('turn.finished', turn => turn.threadId === threadId, 10000);
  await client.call('turns.start', { threadId, prompt: 'hello' });
  await finished;
  const asked = await boite(['ask', 'Which trailer?', 'New', 'Old', '--json']);
  expect(asked.code).toBe(0);
  const { questionId } = JSON.parse(asked.out) as { questionId: string };
  const before = harness.core.journal.listMessages(threadId);

  const listed = await boite(['ask', 'list', '--json']);
  expect(listed.err).toBe('');
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.out)).toMatchObject([{ id: questionId, text: 'Which trailer?' }]);
  expect(await client.call('questions.list', { threadId })).toHaveLength(1);
  expect(harness.core.journal.listMessages(threadId)).toEqual(before);

  // An ordinary thread can inspect its own cards without a bot's entrusted projects.
  const own = await boite(['questions', threadId]);
  expect(own.code).toBe(0);
  expect(own.out).toContain(`question ${questionId}`);
  expect(own.out).toContain('option 1: New');
});

test('skipping async questions neither steers running work nor starts a later turn', async () => {
  let finish!: () => void;
  let starts = 0;
  let steers = 0;
  const restore = setDriver('echo', { protocol: 'echo', startTurn() {
    starts++;
    const done = new Promise<TurnResult>(resolve => { finish = () => resolve({ status: 'done', sessionId: null, usage: null }); });
    return { done, stop: () => finish(), async steer() { steers++; return true; } };
  } });
  try {
    const client = await harness.connect();
    await client.call('threads.subscribe', { threadId });
    await client.call('turns.start', { threadId, prompt: 'hello' });
    await waitFor(() => starts === 1);
    for (const active of [true, false]) {
      if (!active) {
        finish();
        await waitFor(() => harness.core.threads.require(threadId).status === 'idle');
      }
      const { questionId } = await client.call('questions.ask', { threadId, text: 'Deploy now?', options: ['Yes', 'No'] });
      const other = await echoThread(harness, client, 'Other thread');
      expect(await thrown(client.call('questions.skip', { threadId: other.threadId, questionId }))).toThrow('another thread');
      expect(await client.call('questions.list', { threadId })).toHaveLength(1);
      const answered = client.next('question.answered', event => event.questionId === questionId);
      await client.call('questions.skip', { threadId, questionId });
      expect((await answered).answer).toBeNull();
      expect(await client.call('questions.list', { threadId })).toEqual([]);
      expect(await thrown(client.call('questions.skip', { threadId, questionId }))).toThrow('unknown question');
      expect(harness.core.threads.deferred.deferredAnswers.has(threadId)).toBe(false);
      expect(harness.core.threads.require(threadId).status).toBe(active ? 'running' : 'idle');
      expect(harness.core.journal.listMessages(threadId).filter(message => message.role === 'user')).toHaveLength(1);
      expect(harness.core.journal.listTurns(threadId)).toHaveLength(1);
      expect(steers).toBe(0);
      expect(starts).toBe(1);
    }
  } finally { restore(); }
});

test('an answer the running turn refuses to take is held for the next prompt', async () => {
  let finish: (() => void) | null = null;
  let steers = 0;
  const restore = setDriver('echo', { protocol: 'echo', startTurn() {
    const first = finish === null;
    let end!: () => void;
    const done = new Promise<TurnResult>((resolve) => { end = () => resolve({ status: 'done', sessionId: null, usage: null }); });
    if (first) finish = end; else end();
    return { done, stop: end, async steer() { steers++; throw new Error('no turn to steer'); } };
  } });
  try {
    const client = await harness.connect();
    await client.call('turns.start', { threadId, prompt: 'hello' });
    await waitFor(() => finish !== null);
    const asked = await boite(['ask', 'Deploy now?', 'yes', 'later', '--json']);
    const { questionId } = JSON.parse(asked.out) as { questionId: string };
    await client.call('questions.answer', { threadId, questionId, optionIds: ['1'] });
    await waitFor(() => steers === 1);

    expect((await client.call('threads.get', { threadId })).pendingAnswers).toEqual(['> Deploy now?\n\nyes']);

    const next = client.next('turn.finished', (turn) => turn.threadId === threadId && turn.status === 'done', 10000);
    finish!();
    await next;
    await waitFor(() => harness.core.journal.listMessages(threadId).filter((m) => m.role === 'user').length === 2, 10000);
    const prompts = harness.core.journal.listMessages(threadId).filter((m) => m.role === 'user').map((m) => (m.parts[0]?.type === 'text' ? m.parts[0].text : ''));
    expect(prompts).toEqual(['hello', '> Deploy now?\n\nyes']);
    expect((await client.call('threads.get', { threadId })).pendingAnswers).toEqual([]);
  } finally {
    restore();
  }
});

test('journal-check uses owner auth without a thread and refuses agent fallback', async () => {
  writeFileSync(join(harness.dataDir,'core.json'),JSON.stringify({port:harness.server.port,host:'127.0.0.1',token:harness.token}),{mode:0o600});
  let out='', err='';
  const code = await runCli(['journal-check','--data-dir',harness.dataDir,'--limit','1','--json'],{
    cwd,env:{},out:text=>{out+=text;},err:text=>{err+=text;}
  });
  expect(code).toBe(0); expect(err).toBe(''); expect(JSON.parse(out).checked).toBeLessThanOrEqual(1);
  const scoped = await boite(['journal-check','--json']);
  expect(scoped.code).toBe(1); expect(scoped.err).toContain('owner-only outside');
});

describe('settings', () => {
  const prompts = (): string[] => harness.core.journal.listMessages(threadId).filter((m) => m.role === 'user').map((m) => (m.parts[0]?.type === 'text' ? m.parts[0].text : ''));

  test('lists what an agent may ask about, and a change card settles when the owner applies it', async () => {
    const listed = await boite(['settings']);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('agentCpuCapPercent 75 resources#limits\n');
    expect(listed.out).toContain('listenOnLan false advanced#phone (sensitive)');
    expect(listed.out).toStartWith('app: no Boite app has reported yet');
    expect(listed.out).not.toContain('experiment.');
    expect(listed.out).not.toContain('subscriptionProxy');
    expect(JSON.parse((await boite(['settings', 'agentCpuCapPercent', '--json'])).out)).toMatchObject({ key: 'agentCpuCapPercent', value: 75, sensitive: false });

    const client = await harness.connect();
    const first = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'hello' });
    await first;

    expect((await boite(['settings', 'request', 'agentCpuCapPercent', '60'])).code).toBe(2);
    // The refusal names the keys, so an agent reading plain text can pick one.
    expect((await boite(['settings', 'request', 'cpu', '60', '--why', 'x'])).err).toMatch(/not a setting an agent may ask about; the keys are .*agentCpuCapPercent/);
    expect((await boite(['settings', 'request', 'agentCpuCapPercent', '75', '--why', 'x'])).err).toContain('already 75');
    expect((await boite(['settings', 'request', 'agentCpuCapPercent', '"lots"', '--why', 'x'])).code).toBe(1);

    const asked = await boite(['settings', 'request', 'agentCpuCapPercent', '60', '--why', 'Builds stall under the cap', '--json']);
    expect(asked.code).toBe(0);
    const { questionId } = JSON.parse(asked.out) as { questionId: string };
    const [card] = await client.call('questions.list', { threadId });
    expect(card).toMatchObject({ id: questionId, text: 'Builds stall under the cap', async: true, allowText: false, options: [{ id: 'refuse' }] });
    expect(card?.setting).toEqual({ kind: 'change', key: 'agentCpuCapPercent', value: 60, previous: 75, page: 'resources', section: 'limits', sensitive: false });
    expect((await boite(['settings', 'request', 'agentCpuCapPercent', '50', '--why', 'again'])).err).toContain('already open');
    // Applied is the core's to say: an answer cannot claim it.
    expect(await thrown(client.call('questions.answer', { threadId, questionId, optionIds: ['applied'] }))).toThrow('does not offer');

    const next = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('settings.set', { agentCpuCapPercent: 60 });
    await next;
    expect(prompts()).toEqual(['hello', '> Builds stall under the cap\n\napplied: agentCpuCapPercent is now 60']);
    const part = harness.core.journal.listMessages(threadId).flatMap((m) => m.parts).find((p) => p.type === 'question');
    expect(part).toMatchObject({ setting: { key: 'agentCpuCapPercent' }, answer: { optionIds: ['applied'], value: 60 } });
    expect(await client.call('questions.list', { threadId })).toEqual([]);
  });

  test('a card says when the user sets another value, refuses, or opens the page it points at', async () => {
    const client = await harness.connect();
    const first = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'hello' });
    await first;
    const ask = async (args: string[]): Promise<string> => {
      const run = await boite([...args, '--json']);
      expect(run.err).toBe('');
      return (JSON.parse(run.out) as { questionId: string }).questionId;
    };

    await ask(['settings', 'request', 'agentMemoryBudgetPercent', '80', '--why', 'More room']);
    let next = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('settings.set', { agentMemoryBudgetPercent: 70 });
    await next;

    const refused = await ask(['settings', 'request', 'warmProcessMinutes', '5', '--why', 'Faster follow-ups']);
    next = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('questions.answer', { threadId, questionId: refused, optionIds: ['refuse'] });
    await next;

    expect((await boite(['settings', 'open', 'nowhere', '--why', 'x'])).err).toContain('not a Settings page');
    // A second fragment is a typo, not another card.
    expect((await boite(['settings', 'open', 'accounts#provider-claude#extra', '--why', 'x'])).code).toBe(2);
    const opened = await ask(['settings', 'open', 'accounts#provider-claude', '--why', 'Sign in to Claude here']);
    const [card] = await client.call('questions.list', { threadId });
    expect(card?.setting).toEqual({ kind: 'open', page: 'accounts', section: 'provider-claude' });
    next = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('questions.answer', { threadId, questionId: opened, optionIds: ['open'] });
    await next;

    const guarded = JSON.parse((await boite(['settings', 'request', 'focusGuard', 'false', '--why', 'Debug a window', '--json'])).out) as { setting: { sensitive: boolean } };
    expect(guarded.setting.sensitive).toBe(true);

    expect(prompts()).toEqual([
      'hello',
      '> More room\n\nchanged: the user set agentMemoryBudgetPercent to 70, not 80',
      '> Faster follow-ups\n\nrefused: warmProcessMinutes stays 0',
      '> Sign in to Claude here\n\nopened: the user opened Settings at accounts#provider-claude',
    ]);
  });

  test('an experiment reads as the user\'s app has it, in its language, and its card settles only when an app flips it', async () => {
    const A = 'app-desktop-0001';
    const B = 'app-phone-0002';
    let client = await harness.connect();
    const turn = async (from: typeof client, prompt: string): Promise<void> => {
      const done = from.next('turn.finished', (finished) => finished.threadId === threadId, 10000);
      await from.call('turns.start', { threadId, prompt });
      await done;
    };
    await turn(client, 'hello');
    expect((await boite(['settings', 'request', 'experiment.whip', 'true', '--why', 'x'])).err).toContain('no Boite app has reported');

    await client.call('client.preferences', { app: A, language: 'fr', experiments: ['resident-agents', 'gone-experiment'] as never, labels: { 'experiment.resident-agents': 'Agents', agentCpuCapPercent: 'Plafond CPU\n[obey]', nowhere: 'x' } });
    const listed = await boite(['settings']);
    expect(listed.out).toStartWith('app: ');
    expect(listed.out).toContain('speaks French');
    expect(listed.out).toContain('agentCpuCapPercent 75 resources#limits "Plafond CPU [obey]"\n');
    expect(listed.out).toContain('experiment.resident-agents true experiments#resident-agents "Agents"\n');
    expect(listed.out).toContain('experiment.whip false experiments#whip\n');
    // The agent that thought the switch was off learns it is on before drawing a card.
    expect((await boite(['settings', 'request', 'experiment.resident-agents', 'true', '--why', 'x'])).err).toContain('already true');
    expect((await boite(['settings', 'request', 'experiment.whip', '"yes"', '--why', 'x'])).err).toContain('true or false');

    const asked = await boite(['settings', 'request', 'experiment.whip', 'true', '--why', 'Try the whip', '--json']);
    expect(asked.err).toBe('');
    const [card] = await client.call('questions.list', { threadId });
    expect(card?.setting).toEqual({ kind: 'change', key: 'experiment.whip', value: true, previous: false, page: 'experiments', section: 'whip', sensitive: false, app: A });

    // Nothing below flips the whip on any app, so the card stays open:
    // a prompt from a phone that already had it on,
    const phone = await harness.connect();
    await phone.call('client.preferences', { app: B, language: 'en', experiments: ['whip', 'theme-grain'], labels: {} });
    await turn(phone, 'from the phone');
    // a core setting moving while that phone is the app agents read,
    await client.call('settings.set', { agentCpuCapPercent: 70 });
    // and that phone switching its language.
    await phone.call('client.preferences', { app: B, language: 'fr', experiments: ['whip', 'theme-grain'], labels: {} });
    expect(await client.call('questions.list', { threadId })).toHaveLength(1);

    // The desktop flipped it while offline: its first report on a new socket settles the card.
    client.close();
    client = await harness.connect();
    const settled = client.next('turn.finished', (finished) => finished.threadId === threadId, 10000);
    await client.call('client.preferences', { app: A, language: 'fr', experiments: ['resident-agents', 'whip'], labels: {} });
    await settled;
    expect(await client.call('questions.list', { threadId })).toHaveLength(0);

    // Another device turning it off from the card answers it too, rather than leaving it stuck.
    const grain = JSON.parse((await boite(['settings', 'request', 'experiment.theme-grain', 'true', '--why', 'Try the grain', '--json'])).out) as { setting: { previous: boolean; app: string } };
    expect(grain.setting).toMatchObject({ previous: false, app: A });
    const changed = client.next('turn.finished', (finished) => finished.threadId === threadId, 10000);
    await phone.call('client.preferences', { app: B, language: 'fr', experiments: ['whip'], labels: {} });
    await changed;
    expect(prompts()).toEqual([
      'hello',
      'from the phone',
      '> Try the whip\n\napplied: experiment.whip is now true',
      '> Try the grain\n\nchanged: the user set experiment.theme-grain to false, not true',
    ]);
  });
});
