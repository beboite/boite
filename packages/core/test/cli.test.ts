import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV } from '@boite/contracts';
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

test('agents commands discover, send and reply using the calling thread identity', async () => {
  const client = await harness.connect();
  const other = (await echoThread(harness, client, 'VM worker')).threadId;
  const config = { mode: 'brief' as const, resources: 'VM', remote: false, paused: false };
  harness.core.coordination.configure(threadId, config);
  harness.core.coordination.configure(other, config);
  const listed = await boite(['agents', 'list', '--json']);
  expect(listed.code).toBe(0);
  const contact = JSON.parse(listed.out).agents[0];
  const sent = await boite(['agents', 'send', `${contact.coreId}/${other}`, 'Can I restart?', '--json']);
  expect(sent.code).toBe(0);
  const letter = JSON.parse(sent.out);
  expect(letter.from.threadId).toBe(threadId);
  const incoming = await harness.core.coordination.send({ threadId: other, to: harness.core.coordination.get(threadId).self, text: 'Wait', replyTo: letter.id, requestId: 'reply' });
  const reply = await boite(['agents', 'reply', incoming.id, 'Understood', '--json']);
  expect(reply.code).toBe(0);
  expect(JSON.parse(reply.out).replyTo).toBe(incoming.id);
  expect((await boite(['agents', 'inbox'])).out).toContain('from=');
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
  const found = await boite(['agent', 'memory', 'prototypes', '--json']);
  expect(JSON.parse(found.out)).toHaveLength(1);
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
  });
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

    const next = client.next('turn.finished', (turn) => turn.threadId === threadId && turn.status === 'done', 10000);
    finish!();
    await next;
    await waitFor(() => harness.core.journal.listMessages(threadId).filter((m) => m.role === 'user').length === 2, 10000);
    const prompts = harness.core.journal.listMessages(threadId).filter((m) => m.role === 'user').map((m) => (m.parts[0]?.type === 'text' ? m.parts[0].text : ''));
    expect(prompts).toEqual(['hello', '> Deploy now?\n\nyes']);
  } finally {
    restore();
  }
});
