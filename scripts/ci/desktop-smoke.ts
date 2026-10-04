/** Run the installed layout, from outside the checkout, without Bun on PATH. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { waitForCoreEndpoint } from './desktop-smoke-endpoint.ts';

const executable = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(executable)) throw new Error('Expected an installed shell executable');
const directory = mkdtempSync(join(tmpdir(), 'boite-installed-'));
const xdgDataHome = join(directory, "Données d'application");
const data = process.platform === 'linux' ? join(xdgDataHome, 'boite2') : join(directory, 'data');
const home = join(directory, 'home');
const projectDirectory = join(directory, "Projet d'équipe été");
mkdirSync(projectDirectory);
const filename = "résumé de l'équipe.txt";
writeFileSync(join(projectDirectory, filename), 'Before\n');
mkdirSync(join(home, '.local', 'bin'), { recursive: true });
if (process.platform !== 'win32') {
  writeFileSync(join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}
let client: CoreClient | undefined;
let corePid: number | undefined;
// Outside Windows, HOME is this scratch directory, so discovery reaches only
// the stand-in CLI above; that discovery is what the smoke checks. Windows
// still reads the runner's own profile, so its agents stay out.
const hostAgents = process.platform === 'win32' ? '0' : undefined;
const child = Bun.spawn([executable], {
  cwd: directory,
  env: { ...process.env, PATH: process.platform === 'win32' ? process.env.SystemRoot + '\\System32' : '/usr/bin:/bin',
    BOITE_CORE_COMMAND: undefined, BOITE_UI_DIR: undefined, BOITE_CLI_DIR: undefined,
    BOITE_CORE_EXECUTABLE: undefined, HOME: home,
    XDG_DATA_HOME: process.platform === 'linux' ? xdgDataHome : process.env.XDG_DATA_HOME,
    BOITE_DATA_DIR: process.platform === 'linux' ? undefined : data,
    BOITE_SHELL_HIDDEN: '1', BOITE_CORE_RESIDENT: '0', BOITE_ECHO: '1', BOITE_HOST_AGENTS: hostAgents, BOITE_TELEMETRY_URL: '',
    BOITE_TERMINAL_SHELL: process.platform === 'win32' ? process.env.ComSpec : '/bin/sh' },
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
  const project = await client.call('projects.add', { path: projectDirectory });
  const account = (await client.call('accounts.list', {})).find(value => value.providerId === 'echo');
  if (!account) throw new Error('Echo account was not initialized');
  const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Installed smoke' });
  await client.call('threads.subscribe', { threadId: thread.id });
  const files = await client.call('files.list', { threadId: thread.id });
  if (!files.some(file => file.path === filename)) throw new Error('The installed core lost a Unicode filename');
  await client.call('files.write', { threadId: thread.id, path: filename, text: 'Après\n' });
  const written = await client.call('files.read', { threadId: thread.id, path: filename });
  if (written.kind !== 'text' || written.text !== 'Après\n') throw new Error('Installed file editing did not round-trip Unicode');
  const finished = client.next('turn.finished', turn => turn.threadId === thread.id, 15_000);
  await client.call('turns.start', { threadId: thread.id, prompt: '[spawn:boite where]' });
  const turn = await finished;
  if (turn.status !== 'done') throw new Error(`Installed echo turn ended with ${turn.status}`);
  const conversation = await client.call('threads.get', { threadId: thread.id });
  const output = conversation.messages.filter(message => message.role === 'assistant').flatMap(message => message.parts)
    .filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (!output.includes(`thread: ${thread.id}`)) throw new Error(`The installed boite CLI did not reach its thread: ${output}`);
  if (!output.includes(projectDirectory)) throw new Error(`The installed boite CLI lost its working directory: ${output}`);
  if (!(await client.call('trace.get', { threadId: thread.id })).length) throw new Error('The installed CLI process was not traced');
  if (process.platform !== 'win32') {
    const completed = client.next('turn.finished', value => value.threadId === thread.id, 15_000);
    const started = performance.now();
    await client.call('turns.start', { threadId: thread.id, prompt: '[spawn:sleep 3]' });
    if ((await completed).status !== 'done' || performance.now() - started < 2500) {
      throw new Error('The installed desktop interrupted a small idle child before it finished');
    }
    if ((await client.call('threads.get', { threadId: thread.id })).memoryEvents.some(event => event.kind === 'killed')) {
      throw new Error('The installed desktop stopped a small child under its default memory limits');
    }
  }
  let terminalOutput = '';
  const terminalId = `terminal:${thread.id}`;
  const unwatch = client.on('terminal.output', event => { if (event.id === terminalId) terminalOutput += event.data; });
  try {
    const terminal = await client.call('terminals.open', { threadId: thread.id, cols: 160, rows: 30 });
    if (terminal.cwd !== projectDirectory) throw new Error('The installed terminal opened in the wrong directory');
    const exited = client.next('terminal.exited', event => event.id === terminal.id, 15_000);
    await client.call('terminals.write', { id: terminal.id, data: process.platform === 'win32'
      ? 'echo boite-terminal-ok & cd & exit\r' : "printf 'boite-terminal-ok\\n'; pwd; exit\n" });
    await exited;
    if (!terminalOutput.includes('boite-terminal-ok') || !terminalOutput.includes(projectDirectory)) {
      throw new Error(`The installed terminal did not execute in the project: ${terminalOutput}`);
    }
  } finally {
    unwatch();
    await client.call('terminals.close', { id: terminalId });
  }
  console.log('Installed desktop: core startup, bundled UI, authenticated RPC, Unicode paths, file editing, traced CLI and terminal passed');
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
