import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretMask } from '@boite/contracts';
import { parse } from '../src/cli-args.ts';
import { runCli } from '../src/cli.ts';
import { openSecretVault } from '../src/platform/secret-vault.ts';
import { encryptedLink } from '../src/server.ts';
import { removeDir, startTestCore, waitFor, type TestCore } from './harness.ts';
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
  const ref = await saveSecret(h, owner, threadId, 'API_KEY', value);
  writeFileSync(join(root, '.env'), 'FIRST=1\r\nAPI_KEY=old\r\n# kept comment\r\n');
  if (process.platform !== 'win32') chmodSync(join(root, '.env'), 0o644);
  const write = (path: string, extra: { allowUnignored?: boolean } = {}) => owner.call('secrets.use', { threadId, ref, use: { action: 'write', path, key: 'API_KEY', ...extra } });

  expect(await write(join(root, '.env'))).toEqual({ action: 'write', path: join(root, '.env'), replaced: true });
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

  const piped = await owner.call('secrets.use', { threadId, ref, use: {
    action: 'pipe', command: bun, cwd: root, args: ['-e', 'console.error("got " + (await Bun.stdin.text()))'],
  } });
  expect(piped).toMatchObject({ action: 'pipe', exitCode: 0, stderr: `got ${mask}\n` });
  expect(await thrown(owner.call('secrets.use', { threadId, ref, use: { action: 'run', as: 'API_KEY', command: bun, args: [], cwd: h.dataDir } }))).toThrow('outside the conversation\'s folder');

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

test('an agent that reads the env file back gets the value masked in its conversation, though it reached its provider', async () => {
  h = await startTestCore();
  const { owner, root, threadId } = await repoThread();
  const value = `sk-plain-${crypto.randomUUID().replaceAll('-', '')}`;
  const ref = await saveSecret(h, owner, threadId, 'API_KEY', value, true);
  writeFileSync(join(root, '.env'), '');
  await owner.call('secrets.use', { threadId, ref, use: { action: 'write', path: join(root, '.env'), key: 'API_KEY' } });
  // Another conversation of the project, masked by the kept key's scope.
  const thread = h.core.threads.get(threadId);
  const reader = (await owner.call('threads.create', { projectId: thread.projectId!, providerId: 'echo', accountId: thread.accountId!, title: 'reader' })).id;
  await owner.call('threads.subscribe', { threadId: reader });
  const finished = owner.next('turn.finished', turn => turn.threadId === reader, 15000);
  await owner.call('turns.start', { threadId: reader, prompt: `[spawn:${process.platform === 'win32' ? 'type' : 'cat'} ${join(root, '.env')}]` });
  expect((await finished).status).toBe('done');
  const text = (await owner.call('threads.get', { threadId: reader })).messages.flatMap(message => message.parts).map(part => part.type === 'text' ? part.text : '').join('\n');
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
  expect((await cli(['secret', 'list'])).out).toContain('no key kept for this project');

  const asked = cli(['secret', 'ask', 'API_KEY', '--why', 'to call the API']);
  let requestId = '';
  await waitFor(() => {
    const part = h.core.journal.listMessages(threadId).flatMap(message => message.parts).find(item => item.type === 'secret_request' && item.status === 'pending');
    if (part?.type === 'secret_request') requestId = part.requestId;
    return requestId !== '';
  });
  const value = secretValue();
  await owner.call('secrets.answer', { threadId, requestId, value, keep: true });
  const answer = await asked;
  expect(answer).toMatchObject({ code: 0 });
  expect(answer.out).toContain('saved secret:project/API_KEY');
  expect((await cli(['secret', 'list'])).out).toContain('secret:project/API_KEY');

  writeFileSync(join(root, 'echo-args.js'), 'console.log(process.argv.slice(2).join(" ") + " " + process.env.API_KEY); process.exit(4);\n');
  const ran = await cli(['secret', 'run', 'secret:project/API_KEY', '--as', 'API_KEY', '--', bun, 'echo-args.js', '--json']);
  expect(ran.code).toBe(4);
  expect(ran.out).toBe(`--json ${secretMask('API_KEY')}\n`);
  expect(ran.out + ran.err).not.toContain(value);
  expect((await cli(['secret', 'delete'])).code).not.toBe(0);
  expect(await leaks(h, value)).toEqual([]);
});

// The system's own vault (DPAPI, Keychain or Secret Service) writes outside the test's folder on macOS and Linux: opt-in only.
test.if(process.env.BOITE_E2E_SECRET_VAULT === '1')('the system vault keeps a value, gives it back and erases it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-vault-'));
  try {
    const vault = await openSecretVault(dir);
    expect(vault.kind).toBe(process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : 'libsecret');
    const id = `sec_vaulttest${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const value = new TextEncoder().encode(secretValue());
    await vault.put(id, value);
    expect(await vault.take(id)).toEqual(value);
    await vault.delete(id);
    expect(await vault.take(id)).toBeNull();
    if (vault.ids) expect(await vault.ids()).not.toContain(id);
  } finally {
    await removeDir(dir);
  }
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
