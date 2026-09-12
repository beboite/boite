import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Account, AccountId, ProviderDescriptor, ProviderId, RpcEvents } from '@boite/contracts';
import type { Core } from './core.ts';
import { newId } from './ids.ts';
import { invalidParams, messageOf, notFound, refused } from './errors.ts';
import { runAcpLogin, type AcpLoginRun } from './drivers/acp.ts';
import { agentEnv, profileFor, resolveExecutable } from './providers/loader.ts';
import { browserNoopPath, browserNoopScript, currentOs, homePath } from './paths.ts';
import type { SpawnedPipedProcess } from './procs.ts';

/** The thread a login process is traced under. It is a name, never a real thread. */
export function loginThreadId(accountId: AccountId): string {
  return `login:${accountId}`;
}

const URL_IN_OUTPUT = /https:\/\/\S+/;

/** How long the one GET on a pasted redirect URL waits before it is called failed. */
const CALLBACK_TIMEOUT_MS = 10_000;

/**
 * What an isolation variable means when it is not set, as segments under the
 * home directory. A descriptor that isolates an account through one of them
 * (OpenCode uses the XDG pair, Codex `CODEX_HOME`, pi `PI_CODING_AGENT_DIR`)
 * puts its session file under that same variable, so the provider's own location
 * is the variable's own default, never `~/.<id>`.
 */
const ISOLATION_DEFAULTS: Record<string, string[]> = {
  XDG_DATA_HOME: ['.local', 'share'],
  XDG_CONFIG_HOME: ['.config'],
  XDG_STATE_HOME: ['.local', 'state'],
  XDG_CACHE_HOME: ['.cache'],
  CODEX_HOME: ['.codex'],
  CLAUDE_CONFIG_DIR: ['.claude'],
  GROK_HOME: ['.grok'],
  PI_CODING_AGENT_DIR: ['.pi', 'agent'],
};

interface LoginRun {
  done: Promise<void>;
  /** The CLI form: a piped process whose stdin takes a pasted code. */
  spawned: SpawnedPipedProcess | null;
  /** The ACP form: one `authenticate` call over the agent's own stdio. */
  acp: AcpLoginRun | null;
  /** The first https link the agent printed, carried by every later event. */
  url: string | null;
  /** The last line printed, what the exit event carries. */
  lastLine: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** A loopback callback a phone or a remote client pasted back into Boite. */
function loopbackCallback(text: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(text.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  return parsed;
}

/**
 * The loopback address the agent asked the sign-in page to come back to, read
 * out of the `redirect_uri` of the link the agent itself printed. Boite fetches
 * that address on the machine the core runs on, so it is the agent that decides
 * what gets fetched, never the pasted text.
 */
function announcedCallback(loginUrl: string | null): URL | null {
  if (loginUrl === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(loginUrl);
  } catch {
    return null;
  }
  const redirect = parsed.searchParams.get('redirect_uri') ?? parsed.searchParams.get('redirect_url');
  return redirect === null ? null : loopbackCallback(redirect);
}

export class AccountStore {
  private readonly logins = new Map<AccountId, LoginRun>();

  constructor(private readonly core: Core) {}

  list(): Account[] {
    return this.core.journal.listAccounts();
  }

  require(accountId: AccountId): Account {
    const account = this.core.journal.getAccount(accountId);
    if (account === null) throw notFound(`unknown account ${accountId}`, { accountId });
    return account;
  }

  add(params: { providerId: ProviderId; label: string; useDefaultLocation?: boolean }): Account {
    const provider = this.core.providers.require(params.providerId);
    const id = newId('acc_');
    // A provider that is always isolated has no default location to fall back
    // on: its own login belongs to the user's IDE and is never Boite's to use.
    const useDefault = params.useDefaultLocation === true && provider.isolation?.alwaysIsolated !== true;
    let isolationDir: string | null = null;
    if (!useDefault) {
      isolationDir = join(this.core.dataDir, 'accounts', id);
      mkdirSync(isolationDir, { recursive: true });
    }
    const account: Account = {
      id,
      providerId: provider.id,
      label: params.label.length > 0 ? params.label : 'Account',
      isolationDir,
      status: 'unknown',
      identity: null,
      createdAt: Date.now(),
    };
    this.core.journal.append({ type: 'account.added', threadId: null, version: 1, payload: account }, () => {
      this.core.journal.putAccount(account);
    });
    this.prepare(account, provider);
    return this.check(account.id);
  }

  async remove(accountId: AccountId): Promise<void> {
    const account = this.require(accountId);
    if (this.core.journal.listThreads().some((thread) => thread.accountId === accountId)) {
      throw refused('this account is used by a thread; remove its project before removing the account', { accountId });
    }
    const directory = account.isolationDir;
    if (directory !== null && (resolve(directory) !== resolve(this.core.dataDir, 'accounts', accountId)
      || (existsSync(directory) && lstatSync(directory).isSymbolicLink()))) {
      throw refused('the account isolationDir must be its own directory under accounts', { accountId, field: 'isolationDir' });
    }
    await this.loginCancel(accountId);
    // Cancelling yields to RPC work; a new thread may have claimed this account.
    if (this.core.journal.listThreads().some((thread) => thread.accountId === accountId)) {
      throw refused('this account is used by a thread; remove its project before removing the account', { accountId });
    }
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
    this.core.journal.append(
      { type: 'account.removed', threadId: null, version: 1, payload: { accountId } },
      () => {
        this.core.journal.deleteAccount(accountId);
      },
    );
    this.core.bus.emit('accounts.removed', { accountId });
  }

  check(accountId: AccountId): Account {
    const account = this.require(accountId);
    const provider = this.core.providers.get(account.providerId);
    const status = provider === undefined ? 'error' : this.sessionStatus(account, provider);
    const next: Account = { ...account, status };
    this.core.journal.append({ type: 'account.checked', threadId: null, version: 1, payload: next }, () => {
      this.core.journal.putAccount(next);
    });
    this.core.bus.emit('accounts.updated', next);
    return next;
  }

  /**
   * Environment for a process of this account: the profile's fixed `env`, which
   * every account carries, plus the isolation variables, which only an account
   * with a directory of its own does. Preparing the account is part of it, so
   * the seed files and the browser launcher are on disk before any spawn.
   */
  accountEnv(account: Account, provider: ProviderDescriptor): Record<string, string> {
    const profile = profileFor(provider);
    if (profile === undefined) return {};
    this.prepare(account, provider);
    const isolationDir = account.isolationDir;
    const env: Record<string, string> = { ...(profile.env ?? {}) };
    if (isolationDir !== null) {
      for (const [key, value] of Object.entries(profile.isolation)) {
        env[key] = value.split('{isolationDir}').join(isolationDir);
      }
    }
    for (const [key, value] of Object.entries(env)) {
      env[key] = isolationDir === null ? value : value.split('{isolationDir}').join(isolationDir);
    }
    return env;
  }

  /**
   * What has to exist before the agent ever runs: the descriptor's seed files
   * under the isolation directory, and the browser launcher `BROWSER` points at
   * when the profile names one. Both are idempotent, so this runs before every
   * spawn as well as at account creation; a seed file already there is the
   * agent's own and is left alone.
   */
  prepare(account: Account, provider: ProviderDescriptor): void {
    const profile = profileFor(provider);
    if (profile === undefined) return;
    if (Object.values(profile.env ?? {}).some((value) => value === browserNoopPath(this.core.dataDir))) {
      this.writeBrowserNoop();
    }
    const isolationDir = account.isolationDir;
    if (isolationDir === null) return;
    for (const [path, content] of Object.entries(provider.seedFiles ?? {})) {
      const target = join(isolationDir, path);
      if (existsSync(target)) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    }
  }

  private writeBrowserNoop(): void {
    const file = browserNoopPath(this.core.dataDir);
    if (existsSync(file)) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, browserNoopScript(), 'utf8');
    if (currentOs() !== 'windows') chmodSync(file, 0o755);
  }

  /** One "Default" account per available provider, created on first start only. */
  ensureDefaults(): void {
    const known = new Set(this.list().map((account) => account.providerId));
    for (const provider of this.core.providers.available()) {
      if (known.has(provider.id)) continue;
      this.add({ providerId: provider.id, label: 'Default', useDefaultLocation: true });
    }
  }

  /**
   * Run the provider's login command for this account. The process goes through
   * `procs.spawnPiped` under the synthetic thread `login:<accountId>`, so it sits
   * in a Job Object and shows in the trace like any other agent process.
   */
  login(accountId: AccountId): { ok: true } {
    const account = this.require(accountId);
    const provider = this.core.providers.require(account.providerId);
    if (provider.login === undefined) {
      throw refused(`${provider.name} has no login command Boite can run`, {
        accountId,
        providerId: provider.id,
        field: 'login',
      });
    }
    if (account.isolationDir === null) {
      throw refused(
        `${account.label} uses ${provider.name}'s own location: log it in with your own ${provider.shortName} CLI, outside Boite`,
        { accountId, providerId: provider.id, field: 'isolationDir' },
      );
    }
    if (this.logins.has(accountId)) {
      throw refused(`a login is already running for ${account.label}`, { accountId });
    }

    const isolationDir = account.isolationDir;
    mkdirSync(isolationDir, { recursive: true });
    if (provider.login.acp !== undefined) return this.acpLogin(account, provider, provider.login.acp.methodId);

    const argv = provider.login.command;
    if (argv === undefined) throw refused('the login command is empty', { accountId, field: 'login.command' });
    const command = argv.map((part) => part.split('{isolationDir}').join(isolationDir));
    const env = agentEnv(provider, this.accountEnv(account, provider));
    for (const [key, value] of Object.entries(provider.login.env ?? {})) {
      env[key] = value.split('{isolationDir}').join(isolationDir);
    }

    const [first, ...args] = command;
    if (first === undefined) throw refused('the login command is empty', { accountId, field: 'login.command' });
    const executable = this.loginExecutable(provider, first);

    let spawned: SpawnedPipedProcess;
    this.core.providers.installs.acquire(provider.id);
    try {
      spawned = this.core.procs.spawnPiped(loginThreadId(accountId), executable, args, { cwd: isolationDir, env });
    } catch (error) {
      this.core.providers.installs.release(provider.id);
      throw refused(`the login command ${executable} did not start: ${messageOf(error)}`, {
        accountId,
        command: [executable, ...args].join(' '),
      });
    }

    const run: LoginRun = { spawned, acp: null, url: null, lastLine: '', done: Promise.resolve() };
    this.logins.set(accountId, run);
    this.emitLogin(accountId, 'running', '', run);
    run.done = this.readLogin(accountId, run).finally(() => this.core.providers.installs.release(provider.id));
    return { ok: true };
  }

  /**
   * The ACP form of a login: the agent is started the way a turn starts it,
   * under `login:<accountId>`, then `initialize` and `authenticate` with the
   * descriptor's method id. Everything the agent writes outside the ndjson
   * stream, the Google sign-in link included, streams back as `account.login`.
   */
  private acpLogin(account: Account, provider: ProviderDescriptor, methodId: string): { ok: true } {
    const accountId = account.id;
    const profile = profileFor(provider);
    const executable = profile === undefined ? null : resolveExecutable(profile);
    if (executable === null) {
      throw refused(`${provider.name} is not installed on this machine yet`, {
        accountId,
        providerId: provider.id,
        field: 'executable',
      });
    }
    const env = agentEnv(provider, this.accountEnv(account, provider));

    let acp: AcpLoginRun;
    this.core.providers.installs.acquire(provider.id);
    try {
      acp = runAcpLogin({
        methodId,
        executable,
        args: profile?.launch?.args ?? [],
        cwd: account.isolationDir ?? this.core.dataDir,
        env,
        spawnChild: (cmd, args, opts) => this.core.procs.spawnChild(loginThreadId(accountId), cmd, args, opts),
        onLine: (line) => {
          this.onLoginLine(accountId, line);
        },
      });
    } catch (error) {
      this.core.providers.installs.release(provider.id);
      throw refused(`the ${provider.name} agent did not start: ${messageOf(error)}`, {
        accountId,
        command: executable,
      });
    }

    const run: LoginRun = { spawned: null, acp, url: null, lastLine: '', done: Promise.resolve() };
    this.logins.set(accountId, run);
    this.emitLogin(accountId, 'running', '', run);
    run.done = this.finishAcpLogin(accountId, run, acp).finally(() => this.core.providers.installs.release(provider.id));
    return { ok: true };
  }

  loginStates(): RpcEvents['account.login'][] {
    return [...this.logins].map(([accountId, run]) => ({
      accountId, state: 'running', output: run.lastLine, url: run.url, exitCode: null,
    }));
  }

  async loginCancel(accountId: AccountId): Promise<{ ok: true }> {
    this.require(accountId);
    const run = this.logins.get(accountId);
    if (run !== undefined) {
      this.core.procs.killTree(loginThreadId(accountId));
      run.acp?.kill();
      await run.done;
    }
    return { ok: true };
  }

  private async finishAcpLogin(accountId: AccountId, run: LoginRun, acp: AcpLoginRun): Promise<void> {
    let failure: string | null = null;
    try {
      await acp.done;
    } catch (error) {
      failure = messageOf(error);
    }
    acp.kill();
    this.core.procs.killTree(loginThreadId(accountId));
    await acp.exited;
    this.logins.delete(accountId);
    if (failure !== null) run.lastLine = failure;
    this.emitLogin(accountId, failure === null ? 'done' : 'failed', run.lastLine, run, failure === null ? 0 : 1);
    if (this.core.journal.isClosed()) return;
    try {
      this.check(accountId);
    } catch {
      // the account was removed while its login ran
    }
  }

  /**
   * One line into the running login: a CLI login takes it on stdin, an ACP one
   * takes the redirect URL the Google page came back to and fetches it once,
   * which is how a phone or a remote client finishes a sign-in whose loopback
   * listener runs on this machine.
   *
   * That fetch happens on the core's machine, on an address the sender chose, so
   * the address is checked against the one the agent announced in its own
   * sign-in link: same port, same path. Without it, any client holding a session
   * key could aim a GET at any loopback port on the user's machine, and at
   * anything a redirect led to.
   */
  loginInput(accountId: AccountId, text: string): { ok: true } {
    const run = this.logins.get(accountId);
    if (run === undefined) throw refused(`no login is running for ${accountId}`, { accountId });
    if (run.acp !== null) {
      const pasted = loopbackCallback(text);
      if (pasted === null) {
        throw refused('paste the whole redirect URL the Google sign-in page came back to', {
          accountId,
          field: 'text',
        });
      }
      const expected = announcedCallback(run.url);
      if (expected === null) {
        throw refused('this login has not printed a sign-in link with a redirect address yet', {
          accountId,
          field: 'text',
          url: run.url,
        });
      }
      if (pasted.port !== expected.port || pasted.pathname !== expected.pathname) {
        throw refused(
          `this login listens on ${expected.host}${expected.pathname}, not ${pasted.host}${pasted.pathname}`,
          { accountId, field: 'text', expected: `${expected.host}${expected.pathname}` },
        );
      }
      void this.forwardCallback(accountId, pasted.toString());
      return { ok: true };
    }
    const spawned = run.spawned;
    if (spawned === null) throw refused(`no login is running for ${accountId}`, { accountId });
    try {
      spawned.proc.stdin.write(`${text}\n`);
      spawned.proc.stdin.flush();
    } catch (error) {
      throw refused(`the login process did not take the input: ${messageOf(error)}`, { accountId });
    }
    return { ok: true };
  }

  /** One GET on the loopback callback the agent is listening on. No redirect followed, no retry. */
  private async forwardCallback(accountId: AccountId, url: string): Promise<void> {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS) });
      this.onLoginLine(accountId, `the sign-in response was delivered (${response.status})`);
    } catch (error) {
      this.onLoginLine(accountId, `the sign-in response was not delivered: ${messageOf(error)}`);
    }
  }

  /** Every login still running, killed with the core. */
  async closeLogins(): Promise<void> {
    await Promise.all([...this.logins.keys()].map((accountId) => this.loginCancel(accountId)));
  }

  /** One line of a login's output, whichever form it takes. */
  private onLoginLine(accountId: AccountId, line: string): void {
    const run = this.logins.get(accountId);
    if (run === undefined || line.length === 0) return;
    run.lastLine = line;
    if (run.url === null) run.url = URL_IN_OUTPUT.exec(line)?.[0] ?? null;
    this.emitLogin(accountId, 'running', line, run);
  }

  /**
   * A descriptor names its executable the way a shell would (`claude`). When the
   * OS profile already resolved that same name to a real file, use the file: the
   * CLI here is an install the PATH does not always carry.
   */
  private loginExecutable(provider: ProviderDescriptor, first: string): string {
    const profile = profileFor(provider);
    if (profile === undefined) return first;
    const named = profile.executable.some((candidate) => candidate.kind === 'path' && candidate.value === first);
    if (!named) return first;
    return resolveExecutable(profile) ?? first;
  }

  private emitLogin(
    accountId: AccountId,
    state: 'running' | 'done' | 'failed',
    output: string,
    run: LoginRun,
    exitCode: number | null = null,
  ): void {
    if (this.core.journal.isClosed()) return;
    this.core.bus.emit('account.login', { accountId, state, output, url: run.url, exitCode });
  }

  /** stdout and stderr merged, one event per line, then the exit and a recheck. */
  private async readLogin(accountId: AccountId, run: LoginRun): Promise<void> {
    const spawned = run.spawned;
    if (spawned === null) return;
    const onLine = (line: string): void => {
      this.onLoginLine(accountId, line);
    };
    await Promise.all([pumpLines(spawned.proc.stdout, onLine), pumpLines(spawned.proc.stderr, onLine)]);
    const exitCode = await spawned.exited;
    this.logins.delete(accountId);
    this.emitLogin(accountId, exitCode === 0 ? 'done' : 'failed', run.lastLine, run, exitCode);
    if (this.core.journal.isClosed()) return;
    try {
      this.check(accountId);
    } catch {
      // the account was removed while its login ran
    }
  }

  private sessionStatus(account: Account, provider: ProviderDescriptor): Account['status'] {
    if (provider.auth.kind === 'none') return 'ok';
    const session = provider.auth.session ?? [];
    if (session.length === 0) return 'unknown';
    const base = account.isolationDir ?? this.defaultLocation(provider);
    if (base === null) return 'unknown';
    for (const file of session) {
      if (!existsSync(join(base, file))) return 'unauthenticated';
    }
    return 'ok';
  }

  /**
   * The provider's own login directory: its isolation variable if the environment
   * carries one, that variable's own default when Boite knows it, else
   * `~/.<id>`.
   */
  defaultLocation(provider: ProviderDescriptor): string | null {
    const profile = profileFor(provider);
    if (profile !== undefined) {
      for (const key of Object.keys(profile.isolation)) {
        const value = process.env[key];
        if (value !== undefined && value.length > 0) return value;
        const fallback = ISOLATION_DEFAULTS[key];
        if (fallback !== undefined) return join(homePath(), ...fallback);
      }
    }
    return join(homePath(), `.${provider.id}`);
  }
}

export function registerAccountMethods(core: Core): void {
  core.router.register('accounts.list', () => core.accounts.list());
  core.router.register('accounts.add', (params) => {
    if (typeof params.label !== 'string') throw refused('an account needs a label', { field: 'label' });
    return core.accounts.add(params);
  });
  core.router.register('accounts.remove', async (params) => {
    await core.accounts.remove(params.accountId);
    return { ok: true } as const;
  });
  core.router.register('accounts.check', (params) => core.accounts.check(params.accountId));
  core.router.register('accounts.login', (params) => core.accounts.login(params.accountId));
  core.router.register('accounts.logins', () => core.accounts.loginStates());
  core.router.register('accounts.loginCancel', (params) => core.accounts.loginCancel(params.accountId));
  core.router.register('accounts.loginInput', (params) => {
    if (typeof params.text !== 'string') throw invalidParams('a login input needs text', { field: 'text' });
    return core.accounts.loginInput(params.accountId, params.text);
  });
}

/** A stream read line by line, CRLF and LF alike, the tail counted as one more line. */
async function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        onLine(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    }
  } catch {
    // the process died mid-read; the exit code is what reports that
  }
  const tail = buffer.trim();
  if (tail.length > 0) onLine(tail);
}
