import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, AccountId, ProviderDescriptor, ProviderId } from '@boite/contracts';
import type { Core } from './core.ts';
import { newId } from './ids.ts';
import { invalidParams, messageOf, notFound, refused } from './errors.ts';
import { profileFor, resolveExecutable } from './providers/loader.ts';
import { homePath } from './paths.ts';
import type { SpawnedPipedProcess } from './procs.ts';

/** The thread a login process is traced under. It is a name, never a real thread. */
export function loginThreadId(accountId: AccountId): string {
  return `login:${accountId}`;
}

const URL_IN_OUTPUT = /https:\/\/\S+/;

/**
 * What an XDG variable means when it is not set. A descriptor that isolates an
 * account through one of them (OpenCode does) puts its session file under the
 * same variable, so the provider's own location is that variable's own default,
 * never `~/.<id>`.
 */
const XDG_DEFAULTS: Record<string, string[]> = {
  XDG_DATA_HOME: ['.local', 'share'],
  XDG_CONFIG_HOME: ['.config'],
  XDG_STATE_HOME: ['.local', 'state'],
  XDG_CACHE_HOME: ['.cache'],
};

interface LoginRun {
  spawned: SpawnedPipedProcess;
  /** The first https link the CLI printed, carried by every later event. */
  url: string | null;
  /** The last line printed, what the exit event carries. */
  lastLine: string;
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
    const useDefault = params.useDefaultLocation === true;
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
    return this.check(account.id);
  }

  remove(accountId: AccountId): void {
    this.require(accountId);
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

  /** Environment that makes this account blind to the others. Empty for the provider's own login. */
  accountEnv(account: Account, provider: ProviderDescriptor): Record<string, string> {
    if (account.isolationDir === null) return {};
    const profile = profileFor(provider);
    if (profile === undefined) return {};
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(profile.isolation)) {
      env[key] = value.split('{isolationDir}').join(account.isolationDir);
    }
    return env;
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
    const command = provider.login.command.map((part) => part.split('{isolationDir}').join(isolationDir));
    const env: Record<string, string> = { ...this.accountEnv(account, provider) };
    for (const [key, value] of Object.entries(provider.login.env ?? {})) {
      env[key] = value.split('{isolationDir}').join(isolationDir);
    }

    const [first, ...args] = command;
    if (first === undefined) throw refused('the login command is empty', { accountId, field: 'login.command' });
    const executable = this.loginExecutable(provider, first);

    mkdirSync(isolationDir, { recursive: true });
    let spawned: SpawnedPipedProcess;
    try {
      spawned = this.core.procs.spawnPiped(loginThreadId(accountId), executable, args, { cwd: isolationDir, env });
    } catch (error) {
      throw refused(`the login command ${executable} did not start: ${messageOf(error)}`, {
        accountId,
        command: [executable, ...args].join(' '),
      });
    }

    const run: LoginRun = { spawned, url: null, lastLine: '' };
    this.logins.set(accountId, run);
    this.emitLogin(accountId, 'running', '', run);
    void this.readLogin(accountId, run);
    return { ok: true };
  }

  /** One line into the running login's stdin, for a CLI that asks for a pasted code. */
  loginInput(accountId: AccountId, text: string): { ok: true } {
    const run = this.logins.get(accountId);
    if (run === undefined) throw refused(`no login is running for ${accountId}`, { accountId });
    try {
      run.spawned.proc.stdin.write(`${text}\n`);
      run.spawned.proc.stdin.flush();
    } catch (error) {
      throw refused(`the login process did not take the input: ${messageOf(error)}`, { accountId });
    }
    return { ok: true };
  }

  /** Every login still running, killed with the core. */
  closeLogins(): void {
    for (const [accountId, run] of this.logins) {
      try {
        run.spawned.proc.kill();
      } catch {
        // already gone
      }
      this.logins.delete(accountId);
    }
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
    const onLine = (line: string): void => {
      if (line.length === 0) return;
      run.lastLine = line;
      if (run.url === null) run.url = URL_IN_OUTPUT.exec(line)?.[0] ?? null;
      this.emitLogin(accountId, 'running', line, run);
    };
    await Promise.all([pumpLines(run.spawned.proc.stdout, onLine), pumpLines(run.spawned.proc.stderr, onLine)]);
    const exitCode = await run.spawned.exited;
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
   * carries one, that variable's own default when it is an XDG one, else
   * `~/.<id>`.
   */
  private defaultLocation(provider: ProviderDescriptor): string | null {
    const profile = profileFor(provider);
    if (profile !== undefined) {
      for (const key of Object.keys(profile.isolation)) {
        const value = process.env[key];
        if (value !== undefined && value.length > 0) return value;
        const fallback = XDG_DEFAULTS[key];
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
  core.router.register('accounts.remove', (params) => {
    core.accounts.remove(params.accountId);
    return { ok: true } as const;
  });
  core.router.register('accounts.check', (params) => core.accounts.check(params.accountId));
  core.router.register('accounts.login', (params) => core.accounts.login(params.accountId));
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
