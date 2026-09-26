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
  // Drafts land in the test's own directory, never in the user's Documents.
  process.env.BOITE_DRAFTS_DIR = join(dataDir, 'Documents', 'Boite');
  // The echo provider ships only when asked for; every test drives it.
  process.env.BOITE_ECHO = '1';
  // No test runs the agents installed on this machine, unless an opt-in live
  // test asked for them: a version check or a probe would start the user's CLIs.
  const live = Object.keys(process.env).some((name) => /^BOITE_(E2E|BENCH)_/.test(name) && process.env[name] === '1');
  process.env.BOITE_HOST_AGENTS = live ? '1' : '0';
  // A shell the tests open must not write what they type into the user's own
  // PowerShell or bash history: cmd and sh keep none.
  process.env.BOITE_TERMINAL_SHELL = process.platform === 'win32' ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe') : '/bin/sh';

  const token = newToken();
  const core = new Core({ dataDir, token });
  // The scripted agents echo their prompt, and the line that teaches `boite ask`
  // would ride along in every reply: a test that wants it turns it back on.
  core.settings.set({ asyncQuestions: false, ...options.settings });

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
      // Before anything closes: a wait still polling from here on belongs to a
      // test that already ended, and it must stay silent rather than land in the next one.
      stops += 1;
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

/** How many test cores have stopped. A wait that outlives a stop was abandoned by its test. */
let stops = 0;

/**
 * Polls until `predicate` holds. A predicate that throws rejects the wait. A wait
 * whose test core stopped while it polled goes quiet instead: bun fails the
 * running test on any late rejection, so a wait left behind by a failed test
 * (its predicate now reading a closed journal) would otherwise fail the next test,
 * whose own wait then fails the one after, down the whole file.
 */
export function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  const generation = stops;
  return new Promise<void>((resolve, reject) => {
    const tick = (): void => {
      if (stops !== generation) return;
      let held: boolean;
      try {
        held = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (held) {
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
