/** Run the installed layout, from outside the checkout, without Bun on PATH. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { waitForCoreEndpoint } from './desktop-smoke-endpoint.ts';

const executable = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(executable)) throw new Error('Expected an installed shell executable');
const directory = mkdtempSync(join(tmpdir(), 'boite-installed-'));
const data = join(directory, 'data');
const home = join(directory, 'home');
mkdirSync(join(home, '.local', 'bin'), { recursive: true });
if (process.platform !== 'win32') {
  writeFileSync(join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}
let client: CoreClient | undefined;
let corePid: number | undefined;
const child = Bun.spawn([executable], {
  cwd: directory,
  env: { ...process.env, PATH: process.platform === 'win32' ? process.env.SystemRoot + '\\System32' : '/usr/bin:/bin',
    BOITE_CORE_COMMAND: undefined, BOITE_UI_DIR: undefined, BOITE_CLI_DIR: undefined,
    BOITE_CORE_EXECUTABLE: undefined, HOME: home,
    BOITE_DATA_DIR: data, BOITE_SHELL_HIDDEN: '1', BOITE_CORE_RESIDENT: '0', BOITE_ECHO: '1', BOITE_TELEMETRY_URL: '' },
  stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  detached: process.platform !== 'win32',
});
const stdout = new Response(child.stdout).text();
const stderr = new Response(child.stderr).text();
const failures: unknown[] = [];
try {
  const file = join(data, 'core.json');
  const deadline = Date.now() + 30_000;
  const endpoint = await waitForCoreEndpoint(file, { deadline, exitCode: () => child.exitCode });
  corePid = endpoint.pid;
  const origin = `http://127.0.0.1:${endpoint.port}`;
  const health = await (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5000) })).json() as { ok: boolean; pid: number };
  if (!health.ok || health.pid !== corePid) throw new Error('Core health did not match the launched instance');
  const page = await (await fetch(origin, { signal: AbortSignal.timeout(5000) })).text();
  if (!page.includes('<script') || page.includes('UI is not built')) throw new Error('Installed core did not serve the bundled UI');
  client = await connect(`ws://127.0.0.1:${endpoint.port}/rpc`, endpoint.token);
  const providers = await client.call('providers.list', {});
  if (providers.rejected.length) throw new Error(`Rejected bundled providers: ${JSON.stringify(providers.rejected)}`);
  if (process.platform !== 'win32' && !providers.loaded.find(value => value.id === 'claude')?.available) {
    throw new Error('Desktop launch did not discover a CLI installed in ~/.local/bin');
  }
  const project = await client.call('projects.add', { path: directory });
  const account = (await client.call('accounts.list', {})).find(value => value.providerId === 'echo');
  if (!account) throw new Error('Echo account was not initialized');
  const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Installed smoke' });
  await client.call('threads.subscribe', { threadId: thread.id });
  const finished = client.next('turn.finished', turn => turn.threadId === thread.id, 15_000);
  await client.call('turns.start', { threadId: thread.id, prompt: '[spawn:boite where]' });
  const turn = await finished;
  if (turn.status !== 'done') throw new Error(`Installed echo turn ended with ${turn.status}`);
  const conversation = await client.call('threads.get', { threadId: thread.id });
  const output = conversation.messages.filter(message => message.role === 'assistant').flatMap(message => message.parts)
    .filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (!output.includes(`thread: ${thread.id}`)) throw new Error(`The installed boite CLI did not reach its thread: ${output}`);
  console.log('Installed desktop: core startup, bundled UI, authenticated RPC and boite CLI passed');
} catch (error) {
  failures.push(error);
} finally {
  client?.close();
  if (process.platform !== 'win32') {
    // The group belongs to this spawn, including a core that failed before
    // publishing core.json. Killing only the shell would leave it orphaned.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Group already exited. */ }
  }
  child.kill();
  await child.exited;
  if (corePid) {
    try { process.kill(corePid, 'SIGTERM'); } catch { /* Already stopped with its shell. */ }
  }
  console.log(await stdout);
  console.error(await stderr);
  // The core needs a moment to flush its journal and release its files.
  for (let attempt = 0; attempt < 50; attempt++) {
    try { rmSync(directory, { recursive: true, force: true }); break; }
    catch (error) {
      if (attempt === 49) { failures.push(error); break; }
      await Bun.sleep(100);
    }
  }
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, 'Installed desktop test and cleanup failed');
