import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Settings } from '@boite/contracts';
import { connect } from '../src/client.ts';
import type { CoreClient } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { newToken } from '../src/ids.ts';
import { startServer } from '../src/server.ts';
import type { RunningServer } from '../src/server.ts';

export interface TestCore {
  core: Core;
  server: RunningServer;
  url: string;
  token: string;
  dataDir: string;
  connect(): Promise<CoreClient>;
  stop(): Promise<void>;
}

export interface TestCoreOptions {
  helloTimeoutMs?: number;
  settings?: Partial<Settings>;
}

/** Scripted SDK tests need an available executable, never a real CLI install. */
export function scriptedClaude(harness: TestCore): void {
  const descriptor = harness.core.providers.require('claude');
  for (const profile of Object.values(descriptor.profiles)) {
    if (profile) profile.executable = [{ kind: 'file', value: process.execPath }];
  }
}

export async function startTestCore(options: TestCoreOptions = {}): Promise<TestCore> {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-core-'));
  process.env.BOITE_DATA_DIR = dataDir;
  // The echo provider ships only when asked for; every test drives it.
  process.env.BOITE_ECHO = '1';

  const token = newToken();
  const core = new Core({ dataDir, token });
  if (options.settings !== undefined) core.settings.set(options.settings);

  const server = startServer({
    core,
    host: '127.0.0.1',
    port: 0,
    ...(options.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: options.helloTimeoutMs }),
  });

  const clients: CoreClient[] = [];
  // A test that shuts the core down itself still has `afterEach` calling this,
  // and closing a journal or a bus twice is not the thing under test.
  let stopped = false;
  return {
    core,
    server,
    url: server.url,
    token,
    dataDir,
    async connect(): Promise<CoreClient> {
      const client = await connect(server.url, token);
      clients.push(client);
      return client;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const client of clients) client.close();
      await server.stop();
      await core.close();
      delete process.env.BOITE_DATA_DIR;
      await removeDir(dataDir);
    },
  };
}

/** A project directory inside the test data directory, so nothing outside it is touched. */
export function testProject(harness: TestCore, client: CoreClient): Promise<{ id: string; path: string }> {
  return client.call('projects.add', { path: harness.dataDir, name: 'test' });
}

export async function echoThread(
  harness: TestCore,
  client: CoreClient,
  title = 'echo thread',
): Promise<{ threadId: string; accountId: string }> {
  const project = await testProject(harness, client);
  const accounts = await client.call('accounts.list', {});
  const account = accounts.find((entry) => entry.providerId === 'echo');
  if (account === undefined) throw new Error('no echo account');
  const thread = await client.call('threads.create', {
    projectId: project.id,
    providerId: 'echo',
    accountId: account.id,
    title,
  });
  return { threadId: thread.id, accountId: account.id };
}

export function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out waiting for a condition'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Windows holds the journal files a moment after close; a few retries beat a flaky teardown. */
export async function removeDir(dir: string, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}
