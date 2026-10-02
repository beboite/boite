import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV, AGENT_HISTORY_PAGE } from '@boite/contracts';
import { runCli, splitLine } from '../src/cli.ts';
import type { CliIo } from '../src/cli.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnResult } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

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

test('agents commands discover, send and reply using the calling thread identity', async () => {
  const client = await harness.connect();
  const other = (await echoThread(harness, client, 'VM worker')).threadId;
  const config = { mode: 'brief' as const, resources: 'VM', remote: false, paused: false };
  harness.core.coordination.configure(threadId, config);
  harness.core.coordination.configure(other, config);
  const listed = await boite(['agents', 'list', '--json']);
  expect(listed.code).toBe(0);
  const contact = JSON.parse(listed.out).agents[0];
  expect(contact).toMatchObject({ status: 'idle', lastCompletedAt: null, projectArchived: false, paused: false });
  expect((await boite(['agents', 'list'])).out).toContain('contacting this inactive thread is allowed but discouraged');
  const sent = await boite(['agents', 'send', `${contact.coreId}/${other}`, 'Can I restart?', '--json']);
  expect(sent.code).toBe(0);
  const letter = JSON.parse(sent.out);
  expect(letter.from.threadId).toBe(threadId);
  const incoming = await harness.core.coordination.send({ threadId: other, to: harness.core.coordination.get(threadId).self, text: 'Wait', replyTo: letter.id, requestId: 'reply' });
  const reply = await boite(['agents', 'reply', incoming.id, 'Understood', '--json']);
  expect(reply.code).toBe(0);
  expect(JSON.parse(reply.out).replyTo).toBe(incoming.id);
  expect((await boite(['agents', 'inbox'])).out).toContain(`<- from ${other}`);
  harness.core.coordination.pause(other);
  const warned = await boite(['agents', 'send', other, 'Another question']);
  expect(warned.code).toBe(0);
  expect(warned.out).toContain('coordination paused');
  const direct = await boite(['agents', 'send', `${contact.coreId}/${other}`, 'Direct address']);
  expect(direct.code).toBe(0);
  expect(direct.out).toContain('recipient activity is unknown');
});

test('agents reach each other by a short address, find by chat, read and wait for an answer', async () => {
  const client = await harness.connect();
  const other = (await echoThread(harness, client, 'VM worker')).threadId;
  harness.core.journal.putMessage({ id: 'said', threadId: other, turnId: 'history', role: 'user', state: 'complete', createdAt: Date.now(), parts: [{ type: 'text', text: 'the staging database keeps timing out' }] });
  const listed = await boite(['agents', 'list']);
  expect(listed.out).toContain(`${other}  "VM worker"`);
  const found = await boite(['agents', 'find', 'staging', 'timing']);
  expect(found.out).toContain(other);
  expect(found.out).toContain('> the staging database keeps timing out');
  const read = await boite(['agents', 'read', other, '--last', '5']);
  expect(read.out).toContain('user:\n    the staging database keeps timing out');
  const self = harness.core.coordination.get(threadId).self;
  const answering = new Promise<void>(resolve => setTimeout(() => {
    void harness.core.coordination.send({ threadId: other, to: self, text: 'Restart it, I am done.', requestId: 'answer' }).then(() => resolve());
  }, 300));
  const sent = await boite(['agents', 'send', other, 'May I restart staging?', '--wait', '--timeout', '10']);
  await answering;
  expect(sent.code).toBe(0);
  expect(sent.out).toContain('Restart it, I am done.');
  expect((await boite(['agents', 'log', other])).out).toContain('-> to');
  expect((await boite(['agents', 'send', 'thr_nobody', 'hi'])).err).toContain('no reachable agent has this address');
});

test('a send retried with the same --request-id is the same letter, and without it a new one', async () => {
  const client = await harness.connect();
  const other = (await echoThread(harness, client, 'VM worker')).threadId;
  const config = { mode: 'brief' as const, resources: 'VM', remote: false, paused: false };
  harness.core.coordination.configure(threadId, config);
  harness.core.coordination.configure(other, config);
  const contact = JSON.parse((await boite(['agents', 'list', '--json'])).out).agents[0];
  const args = ['agents', 'send', `${contact.coreId}/${other}`, 'Can I restart?', '--request-id', 'cli_send_retry_001', '--json'];
  const first = await boite(args);
  expect(first.code).toBe(0);
  const again = await boite(args);
  expect(again.code).toBe(0);
  expect(JSON.parse(again.out).id).toBe(JSON.parse(first.out).id);
  const fresh = await boite(['agents', 'send', `${contact.coreId}/${other}`, 'Can I restart?', '--json']);
  expect(JSON.parse(fresh.out).id).not.toBe(JSON.parse(first.out).id);
  const received = harness.core.journal.db.query('SELECT COUNT(*) AS n FROM coordination_letters WHERE thread_id = ?').get(other) as { n: number };
  expect(received.n).toBe(2);
});

test('persistent agent CLI uses its own context, durable memory and idempotent decision requests', async () => {
  const client = await harness.connect();
  const account = harness.core.accounts.list().find(a => a.providerId === 'echo')!;
  const agent = await client.call('agents.profile.save', { value: { name: 'CLI worker', domain: '', instructions: '', avatar: '', status: 'active', tools: ['memory', 'decisions', 'messages'], accountIntegration: 'provider', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' } } });
  await client.call('agents.message.send', { scope: { kind: 'agent', id: agent.id }, text: '[sleep:60000]', recipientIds: [], requestId: 'cli_agent_start_001' });
  await waitFor(() => harness.core.workforce.records.list('run').some(r => r.status === 'running'));
  threadId = harness.core.workforce.records.list('run')[0]!.threadId;
  cwd = harness.core.threads.require(threadId).cwd;
  const context = await boite(['agent', 'context', '--json']);
  expect(context.code).toBe(0);
  expect(JSON.parse(context.out).sessions[0].threadId).toBe(threadId);
  const remembered = await boite(['agent', 'remember', JSON.stringify({ title: 'A finding', text: 'Keep prototypes small.' }), '--json']);
  expect(remembered.code).toBe(0);
  // Push the finding and the first message out of the snapshot's window: search and reply page back to them.
  const scope = { kind: 'agent' as const, id: agent.id };
  const opening = harness.core.workforce.records.list('message')[0]!;
  for (let i = 0; i < AGENT_HISTORY_PAGE + 5; i++) {
    harness.core.workforce.records.create('memory', { scope, title: `Filler ${i}`, text: 'unrelated', sourceScopes: [scope], sourceRunId: null, expiresAt: null });
    harness.core.workforce.records.create('message', { scope, senderId: null, text: `filler ${i}`, recipientIds: [], replyTo: null, episodeId: 'filler', sourceRunId: null });
  }
  const bounded = JSON.parse((await boite(['agent', 'context', '--json'])).out);
  expect(bounded.memories).toHaveLength(AGENT_HISTORY_PAGE);
  expect(bounded.messages.some((m: { id: string }) => m.id === opening.id)).toBe(false);
  const found = await boite(['agent', 'memory', 'prototypes', '--json']);
  expect(JSON.parse(found.out)).toHaveLength(1);
  const replied = await boite(['agent', 'reply', opening.id, 'Noted', '--json']);
  expect(replied.code).toBe(0);
  expect(JSON.parse(replied.out).replyTo).toBe(opening.id);
  const args = ['agent', 'decide', JSON.stringify({ prompt: 'Which prototype?', options: ['Puzzle', 'Simulation'] }), '--request-id', 'cli_agent_decision_001', '--json'];
  const first = await boite(args);
  expect(first.code).toBe(0);
  await waitFor(() => harness.core.scheduler.state().running.length === 0);
  expect(await boite(args)).toEqual(first);
  expect(harness.core.workforce.records.list('decision')).toHaveLength(1);
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
      await expect(client.call('questions.skip', { threadId: other.threadId, questionId })).rejects.toThrow('another thread');
      expect(await client.call('questions.list', { threadId })).toHaveLength(1);
      const answered = client.next('question.answered', event => event.questionId === questionId);
      await client.call('questions.skip', { threadId, questionId });
      expect((await answered).answer).toBeNull();
      expect(await client.call('questions.list', { threadId })).toEqual([]);
      await expect(client.call('questions.skip', { threadId, questionId })).rejects.toThrow('unknown question');
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
