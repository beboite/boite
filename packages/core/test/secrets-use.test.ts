import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretMask } from '@boite/contracts';
import { parse } from '../src/cli-args.ts';
import { runCli } from '../src/cli.ts';
import type { CoreClient } from '../src/client.ts';
import { secretCommand } from '../src/secret-cli.ts';
import { encryptedLink } from '../src/server.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { holdTurn, leaks, saveSecret, secretValue } from './secret-fixture.ts';
import { rejection, thrown } from './settle.ts';

let h: TestCore;
afterEach(async () => { await h?.stop(); });

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync({
    cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@boite.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@boite.invalid' },
  });
  if (!run.success) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
}

/** A repository that ignores `.env`, tracks `config.env` and neither tracks nor ignores `notes.env`, with an echo thread in it. */
async function repoThread(): Promise<{ owner: Awaited<ReturnType<TestCore['connect']>>; root: string; threadId: string }> {
  const owner = await h.connect();
  const root = join(h.dataDir, 'repo');
  mkdirSync(root);
  git(root, 'init', '-q');
  writeFileSync(join(root, '.gitignore'), '.env\n');
  writeFileSync(join(root, 'config.env'), 'MODE=dev\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'first');
  writeFileSync(join(root, 'notes.env'), '');
  const project = await owner.call('projects.add', { path: root, name: 'repo' });
  const account = (await owner.call('accounts.list', {})).find(entry => entry.providerId === 'echo');
  const thread = await owner.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account?.id ?? '', title: 'repo' });
  await holdTurn(h, owner, thread.id);
  return { owner, root, threadId: thread.id };
}

const bun = process.execPath;

test('write puts the value in an ignored env file, keeps its other lines, and refuses a path outside, a tracked file and a file git does not ignore', async () => {
  h = await startTestCore();
  const { owner, root, threadId } = await repoThread();
  const value = secretValue();
  writeFileSync(join(root, '.env'), 'FIRST=1\r\nAPI_KEY=old\r\n# kept comment\r\n');
  if (process.platform !== 'win32') chmodSync(join(root, '.env'), 0o644);
  const write = async (path: string, extra: { allowUnignored?: boolean } = {}) => {
    const fresh = await saveSecret(h, owner, threadId, 'API_KEY', value);
    return owner.call('secrets.use', { threadId, ref: fresh, use: { action: 'write', path, key: 'API_KEY', ...extra } });
  };

  // The path given back is the real one: on macOS the temp folder is under /private.
  expect(await write(join(root, '.env'))).toEqual({ action: 'write', path: realpathSync(join(root, '.env')), replaced: true });
  // A file others could read before is narrowed to its owner once it holds the value.
  if (process.platform !== 'win32') expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600);
  // The value holds `$`, so it is quoted the way dotenv parsers read it back.
  expect(readFileSync(join(root, '.env'), 'utf8')).toBe(`FIRST=1\r\nAPI_KEY="${value.replaceAll('$', '\\$')}"\r\n# kept comment\r\n`);

  const outside = await rejection(write(join(h.dataDir, 'outside.env')));
  expect(outside.reason).toMatchObject({ message: expect.stringContaining('outside the conversation\'s folder'), rpc: { data: { field: 'path', expected: expect.stringContaining('a file inside') } } });
  expect(await thrown(write(join(root, 'config.env')))).toThrow('tracked by git');
  expect(await thrown(write(join(root, 'notes.env')))).toThrow('git does not ignore notes.env');
  expect(readFileSync(join(root, 'notes.env'), 'utf8')).toBe('');
  expect(await write(join(root, 'notes.env'), { allowUnignored: true })).toMatchObject({ replaced: false });
  expect(readFileSync(join(root, 'config.env'), 'utf8')).toBe('MODE=dev\n');
  if (process.platform !== 'win32') {
    // A dangling link inside the folder would have the write create its target outside it.
    symlinkSync(join(h.dataDir, 'created.env'), join(root, 'link.env'));
    expect(await thrown(write(join(root, 'link.env'), { allowUnignored: true }))).toThrow('a link to a missing file');
    expect(existsSync(join(h.dataDir, 'created.env'))).toBe(false);
  }
  expect(await leaks(h, value, [root])).toEqual([]);
});

test('run and pipe hand the value to the command and give back its exit code and output masked, URL-encoded form included', async () => {
  h = await startTestCore();
  const { owner, root, threadId } = await repoThread();
  const value = secretValue();
  const ref = await saveSecret(h, owner, threadId, 'API_KEY', value);
  const mask = secretMask('API_KEY');

  const ran = await owner.call('secrets.use', { threadId, ref, use: {
    action: 'run', as: 'API_KEY', command: bun, cwd: root,
    args: ['-e', 'process.stdout.write(`k=${process.env.API_KEY} u=${encodeURIComponent(process.env.API_KEY)}`); process.exit(3)'],
  } });
  expect(ran).toMatchObject({ action: 'run', exitCode: 3, timedOut: false, stdout: `k=${mask} u=${mask}`, truncated: false });

  const pipeRef = await saveSecret(h, owner, threadId, 'API_KEY', value);
  const piped = await owner.call('secrets.use', { threadId, ref: pipeRef, use: {
    action: 'pipe', command: bun, cwd: root, args: ['-e', 'console.error("got " + (await Bun.stdin.text()))'],
  } });
  expect(piped).toMatchObject({ action: 'pipe', exitCode: 0, stderr: `got ${mask}\n` });
  const outsideRef = await saveSecret(h, owner, threadId, 'API_KEY', value);
  expect(await thrown(owner.call('secrets.use', { threadId, ref: outsideRef, use: { action: 'run', as: 'API_KEY', command: bun, args: [], cwd: h.dataDir } }))).toThrow('outside the conversation\'s folder');

  // A shell handed the value can expand it into a grandchild's command line, which the trace keeps and sends.
  const traced: string[] = [];
  const stop = h.core.bus.onAny((name, payload) => {
    const record = payload as { threadId?: string; commandLine?: string | null };
    if (name === 'process.started' && record.threadId === threadId) traced.push(record.commandLine ?? '');
  });
  await h.core.procs.spawnPiped(threadId, bun, ['-e', '0', value], { cwd: root }).exited;
  stop();
  expect(traced.some(line => line.endsWith(`-e 0 ${mask}`))).toBe(true);
  expect(await leaks(h, value)).toEqual([]);
});

test('run stops the command and what it started at the deadline: a child of its own holds the output open and the value in its env', async () => {
  h = await startTestCore();
  const { owner, root, threadId } = await repoThread();
  const ref = await saveSecret(h, owner, threadId, 'API_KEY', secretValue());
  const started = Date.now();
  const ran = await owner.call('secrets.use', { threadId, ref, use: {
    action: 'run', as: 'API_KEY', command: bun, cwd: root, timeoutMs: 1000,
    args: ['-e', "const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'inherit', stderr: 'inherit' }); require('node:fs').writeFileSync('grandchild.pid', String(child.pid)); setInterval(() => {}, 1000);"],
  } });
  expect(ran).toMatchObject({ action: 'run', timedOut: true });
  expect(Date.now() - started).toBeLessThan(15_000);
  // Signal 0 only asks whether the pid the command wrote is still running.
  const pid = Number(readFileSync(join(root, 'grandchild.pid'), 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await waitFor(() => !alive(), 10_000);
  // `boite secret run` exits 124 for it, like timeout(1), whatever code the stop left.
  const client = { call: () => Promise.resolve({ ...ran, exitCode: 143 }) } as unknown as CoreClient;
  const cli = await secretCommand(['run', ref, '--as', 'API_KEY', '--', bun], { out: () => undefined, err: () => undefined, env: {}, cwd: root }, client, threadId);
  expect(cli.output).toMatchObject({ exitCode: 124, stderr: expect.stringContaining('stopped at its deadline') });
}, 30_000);

test('an agent that reads the env file back gets the value masked in its conversation, though it reached its provider', async () => {
  h = await startTestCore();
  const { owner, root, threadId } = await repoThread();
  const value = `sk-plain-${crypto.randomUUID().replaceAll('-', '')}`;
  const ref = await saveSecret(h, owner, threadId, 'API_KEY', value);
  writeFileSync(join(root, '.env'), '');
  await owner.call('secrets.use', { threadId, ref, use: { action: 'write', path: join(root, '.env'), key: 'API_KEY' } });
  // A later turn in the same conversation still masks output using hashes, without the value.
  await owner.call('turns.stop', { threadId });
  await waitFor(() => h.core.journal.runningTurn(threadId) === null);
  await owner.call('threads.subscribe', { threadId });
  const finished = owner.next('turn.finished', turn => turn.threadId === threadId, 15000);
  await owner.call('turns.start', { threadId, prompt: `[spawn:${process.platform === 'win32' ? 'type' : 'cat'} ${join(root, '.env')}]` });
  expect((await finished).status).toBe('done');
  const text = (await owner.call('threads.get', { threadId })).messages.flatMap(message => message.parts).map(part => part.type === 'text' ? part.text : '').join('\n');
  expect(text).toContain(`API_KEY=${secretMask('API_KEY')}`);
  expect(text).not.toContain(value);
  expect(await leaks(h, value, [root])).toEqual([]);
});

test('boite secret: an agent asks, lists and runs by ref from the command line, and its flags after -- are the command\'s', async () => {
  h = await startTestCore();
  const { owner, root, threadId } = await repoThread();
  const env = { BOITE_THREAD_ID: threadId, BOITE_CORE_URL: h.url, BOITE_AGENT_TOKEN: h.core.agents.tokenFor(threadId) };
  const cli = async (args: string[]) => {
    let out = '', err = '';
    const code = await runCli(args, { out: s => { out += s; }, err: s => { err += s; }, env, cwd: root });
    await Bun.sleep(5);
    return { code, out, err };
  };
  expect((await cli(['secret', 'list'])).out).toContain('stores no project keys');

  const asked = cli(['secret', 'ask', 'API_KEY', '--why', 'to call the API']);
  let requestId = '';
  await waitFor(() => {
    const part = h.core.journal.listMessages(threadId).flatMap(message => message.parts).find(item => item.type === 'secret_request' && item.status === 'pending');
    if (part?.type === 'secret_request') requestId = part.requestId;
    return requestId !== '';
  });
  const value = secretValue();
  await owner.call('secrets.answer', { threadId, requestId, value });
  const answer = await asked;
  expect(answer).toMatchObject({ code: 0 });
  const ref = /saved (secret:sec_[a-z0-9]+)/.exec(answer.out)?.[1];
  expect(ref).toBeString();
  expect((await cli(['secret', 'list'])).out).toContain('stores no project keys');

  writeFileSync(join(root, 'echo-args.js'), 'console.log(process.argv.slice(2).join(" ") + " " + process.env.API_KEY); process.exit(4);\n');
  const ran = await cli(['secret', 'run', ref!, '--as', 'API_KEY', '--', bun, 'echo-args.js', '--json']);
  expect(ran.code).toBe(4);
  expect(ran.out).toBe(`--json ${secretMask('API_KEY')}\n`);
  expect(ran.out + ran.err).not.toContain(value);
  expect((await cli(['secret', 'delete'])).code).not.toBe(0);
  expect(await leaks(h, value)).toEqual([]);
});

test('a socket counts as encrypted on loopback both ways, from the tailnet or behind an HTTPS page, never over plain HTTP', () => {
  expect(encryptedLink('127.0.0.1', '127.0.0.1:7000', null)).toBe(true);
  expect(encryptedLink('::1', 'localhost:7000', 'http://localhost:7000')).toBe(true);
  // A tunnel on this machine: loopback socket, someone else's Host.
  expect(encryptedLink('127.0.0.1', 'phone.example', 'http://phone.example')).toBe(false);
  expect(encryptedLink('127.0.0.1', 'phone.example', 'https://phone.example')).toBe(true);
  expect(encryptedLink('100.101.102.103', '100.64.0.1:7000', 'http://100.64.0.1:7000')).toBe(true);
  expect(encryptedLink('fd7a:115c:a1e0::1', 'box.tail.ts.net', null)).toBe(true);
  expect(encryptedLink('192.168.1.20', '192.168.1.5:7000', 'http://192.168.1.5:7000')).toBe(false);
  expect(encryptedLink('::ffff:192.168.1.20', '192.168.1.5:7000', null)).toBe(false);
  expect(encryptedLink(null, null, null)).toBe(false);
  // Another member carrying a phone's socket says whether the phone's hop to it was encrypted.
  expect(encryptedLink('100.101.102.103', '100.64.0.1:7000', null, 'plain')).toBe(false);
  expect(encryptedLink('100.101.102.103', '100.64.0.1:7000', null, 'encrypted')).toBe(true);
  expect(encryptedLink('192.168.1.20', '192.168.1.5:7000', null, 'encrypted')).toBe(false);
  // Off a tailnet, 100.64.0.0/10 is a carrier's range.
  expect(encryptedLink('100.101.102.103', '100.64.0.1:7000', null, null, false)).toBe(false);

  expect(parse(['secret', 'list', '--json']).json).toBe(true);
  const run = parse(['secret', 'run', 'secret:project/K', '--as', 'K', '--', 'tool', '--json', '--thread', 'x']);
  expect(run.json).toBe(false);
  expect(run.thread).toBeUndefined();
  expect(run.positional).toEqual(['secret', 'run', 'secret:project/K', '--as', 'K', '--', 'tool', '--json', '--thread', 'x']);
});
