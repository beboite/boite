import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, AccountId, ProviderDescriptor, ProviderId } from '@boite/contracts';
import type { Core } from './core.ts';
import { newId } from './ids.ts';
import { notFound, refused } from './errors.ts';
import { profileFor } from './providers/loader.ts';
import { homePath } from './paths.ts';

export class AccountStore {
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

  /** The provider's own login directory: its isolation variable if the core has one, else `~/.<id>`. */
  private defaultLocation(provider: ProviderDescriptor): string | null {
    const profile = profileFor(provider);
    if (profile !== undefined) {
      for (const key of Object.keys(profile.isolation)) {
        const value = process.env[key];
        if (value !== undefined && value.length > 0) return value;
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
}
