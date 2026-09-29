import { RpcErrorCode } from '@boite/contracts';
import type {
  Account,
  HarnessUpdate,
  ProviderId,
  ProviderInstallState,
  ProviderRejected,
  ProviderSummary,
  RpcEvents
} from '@boite/contracts';
import { RpcFailure } from '../client';
import type { LoginState } from '../store.svelte';
import type { StoreContext } from './context';

/** What the summaries say about every managed install, as one map. */
export function installStatesOf(providers: ProviderSummary[]): Record<ProviderId, ProviderInstallState> {
  const out: Record<ProviderId, ProviderInstallState> = {};
  for (const provider of providers) {
    if (provider.install !== null) out[provider.id] = provider.install;
  }
  return out;
}

/** The providers this machine runs, their accounts and sign-ins, their managed installs and updates. */
export class Accounts {
  /**
   * The guided connection dialog: open on a provider's steps, or on the list
   * when `providerId` is null. `accountId` names the account a "sign in again"
   * is for, so the login lands on it rather than on a new one.
   */
  connectDialog = $state<{ providerId: ProviderId | null; accountId: string | null } | null>(null);
  providers = $state<ProviderSummary[]>([]);
  rejectedProviders = $state<ProviderRejected[]>([]);
  /**
   * Where each managed install stands, keyed by provider. The summaries seed it
   * and `providers.installProgress` moves it while a download runs, which is the
   * only state a summary cannot carry between two `providers.list` calls.
   */
  installStates = $state<Record<ProviderId, ProviderInstallState>>({});
  /** Where each agent of this machine stands against its newest release, the core's own reading. */
  harnessUpdates = $state<HarnessUpdate[]>([]);
  accounts = $state<Account[]>([]);
  /** Keyed by account id: one entry while a login runs, and after one failed. */
  logins = $state<Record<string, LoginState>>({});
  loginRevision = 0;
  loginChanges = new Map<string, number>();

  constructor(private readonly ctx: StoreContext) {}

  accountsOf(providerId: ProviderId): Account[] {
    return this.accounts.filter((a) => a.providerId === providerId);
  }

  providerOf(id: ProviderId): ProviderSummary | null {
    return this.providers.find((p) => p.id === id) ?? null;
  }

  /** Null when this provider ships no release for Boite to install. */
  installOf(id: ProviderId): ProviderInstallState | null {
    return this.installStates[id] ?? this.ctx.store.providerOf(id)?.install ?? null;
  }

  accountOf(id: string): Account | null {
    return this.accounts.find((a) => a.id === id) ?? null;
  }

  openConnect(providerId: ProviderId | null = null, accountId: string | null = null): void {
    this.connectDialog = { providerId, accountId };
  }

  closeConnect(): void {
    this.connectDialog = null;
  }

  async addAccount(input: {
    providerId: ProviderId;
    label: string;
    useDefaultLocation?: boolean;
  }): Promise<Account | null> {
    const client = this.ctx.client;
    if (!client) return null;
    try {
      const account = await client.call('accounts.add', input);
      if (!this.accounts.some((a) => a.id === account.id))
        this.accounts = [...this.accounts, account];
      return account;
    } catch (error) {
      this.ctx.fail(error);
      return null;
    }
  }

  /** Events received after the snapshot request win over its older rows. */
  restoreLogins(events: RpcEvents['account.login'][], revision: number): void {
    const snapshot: Record<string, LoginState> = {};
    for (const { accountId, ...state } of events) {
      if (state.state !== 'done') snapshot[accountId] = { ...state, state: state.state };
    }
    for (const [accountId, changedAt] of this.loginChanges) {
      if (changedAt <= revision) continue;
      const current = this.logins[accountId];
      if (current) snapshot[accountId] = current;
      else delete snapshot[accountId];
    }
    this.logins = snapshot;
  }

  async removeAccount(accountId: string): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      await client.call('accounts.remove', { accountId });
      this.accounts = this.accounts.filter((a) => a.id !== accountId);
      delete this.logins[accountId];
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  async cancelLogin(accountId: string): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      await client.call('accounts.loginCancel', { accountId });
      delete this.logins[accountId];
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  /** Start the provider's login for this account; the rest arrives as `account.login`. */
  async loginAccount(accountId: string): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      await client.call('accounts.login', { accountId });
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  /** One line into the running login, for a CLI that asks for a code to paste. */
  async sendLoginInput(accountId: string, text: string): Promise<void> {
    const client = this.ctx.client;
    if (!client || text.trim().length === 0) return;
    try {
      await client.call('accounts.loginInput', { accountId, text: text.trim() });
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  async checkAccount(accountId: string): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      const account = await client.call('accounts.check', { accountId });
      this.accounts = this.accounts.map((a) => (a.id === account.id ? account : a));
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  // -------------------------------------------------------------------------
  // Managed installs
  // -------------------------------------------------------------------------

  async reloadProviders(): Promise<boolean> {
    const client = this.ctx.client;
    if (!client) return false;
    try {
      const { loaded } = await client.call('providers.reload', {});
      this.providers = loaded;
      for (const account of this.accounts) await this.ctx.store.checkAccount(account.id);
      return true;
    } catch (error) {
      this.ctx.fail(error);
      return false;
    }
  }

  /**
   * The list is the core's and arrives again as `providers.updatesChanged`.
   * A core from before updates answers MethodNotFound: that machine simply
   * offers none, which is not an error worth a toast.
   */
  async loadHarnessUpdates(refresh = false): Promise<void> {
    const client = this.ctx.client;
    if (!client || !this.ctx.store.owner) return;
    try {
      const updates = await client.call('providers.updates', refresh ? { refresh: true } : {});
      if (client === this.ctx.client) this.harnessUpdates = updates;
    } catch (error) {
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) {
        if (client === this.ctx.client) this.harnessUpdates = [];
        return;
      }
      if (refresh) this.ctx.fail(error);
      else console.warn('reading the agent updates failed', error);
    }
  }

  async updateHarness(providerId: ProviderId): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      const update = await client.call('providers.update', { providerId });
      this.#putHarnessUpdate(update);
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  async skipHarnessUpdate(providerId: ProviderId, version: string | null): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      this.#putHarnessUpdate(await client.call('providers.updateSkip', { providerId, version }));
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  #putHarnessUpdate(update: HarnessUpdate): void {
    this.harnessUpdates = this.harnessUpdates.some((entry) => entry.providerId === update.providerId)
      ? this.harnessUpdates.map((entry) => (entry.providerId === update.providerId ? update : entry))
      : [...this.harnessUpdates, update];
  }

  /** Start the download. The rest arrives as `providers.installProgress`. */
  async installProvider(providerId: ProviderId): Promise<boolean> {
    const client = this.ctx.client;
    if (!client) return false;
    try {
      const state = await client.call('providers.install', { providerId });
      this.installStates = { ...this.installStates, [providerId]: state };
      return true;
    } catch (error) {
      this.ctx.fail(error);
      return false;
    }
  }

  async cancelInstall(providerId: ProviderId): Promise<void> {
    const client = this.ctx.client;
    const state = this.ctx.store.installOf(providerId);
    if (!client || state === null || state.state === 'absent' || state.state === 'installed' || state.state === 'failed')
      return;
    try {
      await client.call('providers.installCancel', { providerId, operationId: state.operationId });
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  /** Delete the files. Refused by the core while a process of that provider is alive. */
  async uninstallProvider(providerId: ProviderId): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      const state = await client.call('providers.uninstall', { providerId });
      this.installStates = { ...this.installStates, [providerId]: state };
    } catch (error) {
      this.ctx.fail(error);
    }
  }
}
