import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { RPC_PATH, RpcCloseCode } from '../../packages/contracts/src/index.ts';
import type {
  Account,
  MessagePart,
  ProcessRecord,
  Project,
  ThreadSummary,
  Turn,
  Usage,
} from '../../packages/contracts/src/index.ts';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { removeDirectory, startCore, type RunningCore } from './lib/core.ts';

const TIMEOUT = 60_000;

let core: RunningCore;
let client: CoreClient;
let projectDir: string;
let project: Project;
let thread: ThreadSummary;
let firstTurnUsage: Usage | null = null;

beforeAll(async () => {
  core = await startCore();
  client = await connect(core.url, core.token);
  projectDir = mkdtempSync(join(tmpdir(), 'boite-e2e-project-'));
});

afterAll(async () => {
  client?.close();
  await core?.stop();
  if (projectDir !== undefined) await removeDirectory(projectDir);
});

test(
  'hello answers with a core that can trace',
  () => {
    expect(client.core.protocolVersion).toBe(1);
    expect(client.core.channel).toBe('stable');
    expect(client.core.pid).toBeGreaterThan(0);
    expect(client.core.endpoint.port).toBe(core.port);
    expect(client.core.dataDir).toBe(core.dataDir);
    expect(['events', 'poll', 'none']).toContain(client.core.trace.mode);
    expect(client.core.trace.note.length).toBeGreaterThan(0);
    expect(client.core.trace.os).toBe(process.platform === 'win32' ? 'windows' : client.core.trace.os);
  },
  TIMEOUT,
);

// The dev channel proved where it is cheap: a second `tauri build` for a dev
// shell executable costs minutes, while the flag, the `CoreInfo` it fills and
// the `core.json` a dev shell then reads all live in the core. The rest of the
// channel, an identifier mapped to a directory name, is `cargo test --lib` in
// `apps/shell/src-tauri`.
test(
  'a core started with --channel dev says so and writes its core.json where a dev shell looks',
  async () => {
    const dev = await startCore({ args: ['--channel', 'dev'] });
    const devClient = await connect(dev.url, dev.token);
    try {
      expect(devClient.core.channel).toBe('dev');
      expect(devClient.core.dataDir).toBe(dev.dataDir);

      const file = join(dev.dataDir, 'core.json');
      expect(existsSync(file)).toBe(true);
      const written = JSON.parse(readFileSync(file, 'utf8')) as { port: number; token: string };
      expect(written.port).toBe(dev.port);
      expect(written.token).toBe(dev.token);
    } finally {
      devClient.close();
      await dev.stop();
    }
  },
  TIMEOUT,
);

test(
  'a project is added from a real directory',
  async () => {
    project = await client.call('projects.add', { path: projectDir, name: 'e2e' });
    expect(project.path).toBe(projectDir);
    const projects = await client.call('projects.list', {});
    expect(projects.map((entry) => entry.id)).toContain(project.id);
  },
  TIMEOUT,
);

test(
  'the shipped providers are echo, runnable, and claude',
  async () => {
    const providers = await client.call('providers.list', {});
    expect(providers.rejected).toEqual([]);
    const echo = providers.loaded.find((provider) => provider.id === 'echo');
    const claude = providers.loaded.find((provider) => provider.id === 'claude');
    expect(echo?.available).toBe(true);
    expect(echo?.protocol).toBe('echo');
    expect(claude).toBeDefined();
    expect(claude?.protocol).toBe('claude-sdk');
  },
  TIMEOUT,
);

test(
  'the echo provider has its Default account',
  async () => {
    const accounts = await client.call('accounts.list', {});
    const echoAccount = accounts.find((account: Account) => account.providerId === 'echo');
    expect(echoAccount?.label).toBe('Default');
    expect(echoAccount?.isolationDir).toBeNull();
  },
  TIMEOUT,
);

test(
  'a thread is created and subscribed',
  async () => {
    const accounts = await client.call('accounts.list', {});
    const echoAccount = accounts.find((account) => account.providerId === 'echo');
    expect(echoAccount).toBeDefined();
    thread = await client.call('threads.create', {
      projectId: project.id,
      providerId: 'echo',
      accountId: echoAccount?.id ?? '',
      title: 'e2e thread',
    });
    expect(thread.status).toBe('idle');
    expect(thread.cwd).toBe(projectDir);
    const subscribed = await client.call('threads.subscribe', { threadId: thread.id });
    expect(subscribed.ok).toBe(true);
  },
  TIMEOUT,
);

test(
  'one turn streams text, a tool, a permission and a process',
  async () => {
    const deltas: string[] = [];
    const parts: MessagePart[] = [];
    const started: ProcessRecord[] = [];
    const exited: ProcessRecord[] = [];
    const offDelta = client.on('message.delta', (event) => deltas.push(event.text));
    const offPart = client.on('message.part', (event) => parts.push(event.part));
    const offStarted = client.on('process.started', (record) => started.push(record));
    const offExited = client.on('process.exited', (record) => exited.push(record));

    const finished = client.next<'turn.finished'>(
      'turn.finished',
      (turn) => turn.threadId === thread.id,
      TIMEOUT,
    );
    const requested = client.next<'permission.requested'>(
      'permission.requested',
      (request) => request.threadId === thread.id,
      TIMEOUT,
    );

    const turn = await client.call('turns.start', {
      threadId: thread.id,
      prompt: 'e2e [tool] [permission] [spawn:echo traced]',
    });
    expect(['queued', 'running']).toContain(turn.status);

    const permission = await requested;
    expect(permission.toolName).toBe('fake_tool');
    expect(permission.input).toEqual({ echo: true });
    const resolved = client.next<'permission.resolved'>(
      'permission.resolved',
      (event) => event.requestId === permission.id,
      TIMEOUT,
    );
    await client.call('permissions.answer', { requestId: permission.id, decision: 'allow' });
    expect((await resolved).decision).toBe('allow');

    const done = await finished;
    offDelta();
    offPart();
    offStarted();
    offExited();

    expect(done.status).toBe('done');
    expect(done.usage).not.toBeNull();
    expect(done.usage?.outputTokens).toBeGreaterThan(0);
    firstTurnUsage = done.usage;

    const text = deltas.join('');
    expect(text).toContain('e2e');
    expect(text).toContain('allowed');
    expect(text).toContain('traced');

    const tool = parts.find((part) => part.type === 'tool' && part.status === 'done');
    expect(tool).toBeDefined();
    const permissionPart = parts.find((part) => part.type === 'permission' && part.decision === 'allow');
    expect(permissionPart).toBeDefined();

    expect(started.length).toBeGreaterThan(0);
    expect(exited.length).toBeGreaterThan(0);
    expect(started[0]?.threadId).toBe(thread.id);
    expect(exited[0]?.exitedAt).not.toBeNull();
  },
  TIMEOUT,
);

test(
  'the trace and the resources carry that process',
  async () => {
    const records = await client.call('trace.get', { threadId: thread.id });
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]?.threadId).toBe(thread.id);
    expect(records[0]?.exitedAt).not.toBeNull();

    const resources = await client.call('resources.list', {});
    const mine = resources.find((entry) => entry.threadId === thread.id);
    expect(mine?.title).toBe('e2e thread');
    expect(mine?.totals.processes).toBeGreaterThan(0);
  },
  TIMEOUT,
);

test(
  'usage totals what the turn reported',
  async () => {
    const usage = await client.call('usage.get', {});
    expect(usage.byThread[thread.id]).toEqual(firstTurnUsage as Usage);
    expect(usage.total).toEqual(firstTurnUsage as Usage);
  },
  TIMEOUT,
);

test(
  'a cap of one leaves two turns queued, and a queued turn can be stopped',
  async () => {
    const settings = await client.call('settings.set', { maxConcurrentTurns: 1 });
    expect(settings.maxConcurrentTurns).toBe(1);

    const accounts = await client.call('accounts.list', {});
    const echoAccount = accounts.find((account) => account.providerId === 'echo');
    const three: ThreadSummary[] = [];
    for (let index = 0; index < 3; index += 1) {
      three.push(
        await client.call('threads.create', {
          projectId: project.id,
          providerId: 'echo',
          accountId: echoAccount?.id ?? '',
          title: `queued ${index}`,
        }),
      );
    }

    const turns: Turn[] = [];
    for (const queued of three) {
      turns.push(await client.call('turns.start', { threadId: queued.id, prompt: 'wait [sleep:400]' }));
    }

    const state = await client.call('scheduler.get', {});
    const ours = new Set(three.map((entry) => entry.id));
    expect(state.running.filter((entry) => ours.has(entry.threadId)).length).toBe(1);
    expect(state.queued.filter((entry) => ours.has(entry.threadId)).length).toBe(2);

    const queuedEntry = state.queued.find((entry) => ours.has(entry.threadId));
    expect(queuedEntry).toBeDefined();
    const stopped = await client.call('turns.stop', { threadId: queuedEntry?.threadId ?? '' });
    expect(stopped.stopped).toBe(true);

    const after = await client.call('scheduler.get', {});
    expect(after.queued.some((entry) => entry.turnId === queuedEntry?.turnId)).toBe(false);

    for (const queued of three) await client.call('turns.stop', { threadId: queued.id }).catch(() => undefined);
    await client.call('settings.set', { maxConcurrentTurns: 6 });
    expect(turns.length).toBe(3);
  },
  TIMEOUT,
);

test(
  'a thread archives',
  async () => {
    const archived = await client.call('threads.archive', { threadId: thread.id });
    expect(archived.archived).toBe(true);
    const visible = await client.call('threads.list', {});
    expect(visible.some((entry) => entry.id === thread.id)).toBe(false);
    const all = await client.call('threads.list', { includeArchived: true });
    expect(all.some((entry) => entry.id === thread.id)).toBe(true);
  },
  TIMEOUT,
);

test(
  'a wrong token closes the socket with 4001',
  async () => {
    const socket = new WebSocket(`${core.url.replace(/^http/, 'ws')}${RPC_PATH}`);
    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the socket never closed')), TIMEOUT / 2);
      socket.addEventListener('close', (event: CloseEvent) => {
        clearTimeout(timer);
        resolve(event.code);
      });
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('the socket failed to open')));
    });
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'hello',
        params: { token: 'not the token', client: { name: 'test', version: '0' } },
      }),
    );
    expect(await closed).toBe(RpcCloseCode.Unauthorized);
  },
  TIMEOUT,
);
