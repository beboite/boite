import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV } from '@boite/contracts';
import { runCli, splitLine } from '../src/cli.ts';
import type { CliIo } from '../src/cli.ts';
import { echoThread, startTestCore } from './harness.ts';
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
    const run = await boite(['where', '--thread', 'thread_other'], {
      // `--thread` switches to the owner path and needs a core.json; here it
      // must not even get there with the agent token in hand.
      [AGENT_ENV.threadId]: threadId,
    });
    expect(run.code).toBe(1);
  });
});
