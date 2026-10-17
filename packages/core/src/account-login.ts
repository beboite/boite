/**
 * What an ACP sign-in leaves besides the account's token: the folders its one
 * process used, and the models the session it opened after `authenticate`
 * listed. The sign-in itself runs in `accounts.ts`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, ProviderDescriptor } from '@boite/contracts';
import type { Core } from './core.ts';
import type { AcpLoginCatalog } from './drivers/acp/login.ts';
import { rememberSessionModels } from './drivers/index.ts';
import { launchTemp } from './drivers/launch-temp.ts';
import { messageOf } from './errors.ts';
import { removeDir } from './fs-retry.ts';

export interface LoginFolders {
  /** The empty folder the catalog session opens in, as a probe's does. */
  catalogCwd: string;
  /** What the launch adds to its environment: a folder to unpack in, for an agent that unpacks itself. */
  env: Record<string, string>;
  /** Removes both once the process tree has exited. Never throws. */
  dispose(): Promise<void>;
}

export function loginFolders(core: Core, account: Account, provider: ProviderDescriptor, threadId: string): LoginFolders {
  const log = (message: string): void => {
    core.log('warn', `signing in to ${provider.name}: ${message}`, { source: provider.id, event: 'account.login.cleanup', threadId });
  };
  const catalogCwd = mkdtempSync(join(tmpdir(), 'boite-login-'));
  let temp: ReturnType<typeof launchTemp>;
  try {
    temp = launchTemp(provider, account.isolationDir);
  } catch (error) {
    void removeDir(catalogCwd, log);
    throw error;
  }
  return {
    catalogCwd,
    env: temp?.env ?? {},
    async dispose() {
      await temp?.dispose(log);
      await removeDir(catalogCwd, log);
    },
  };
}

/**
 * The models the sign-in's own session listed become the account's catalog,
 * told to every client as a probe would be. Call it in the tick of the check
 * that announced the signed-in account: that announcement drops the list the
 * account had, and a picker asking next finds this one instead of starting the
 * agent again. A sign-in that read none says why in the log; the next look at
 * the models probes as before.
 */
export async function publishLoginCatalog(
  core: Core,
  account: Account,
  provider: ProviderDescriptor,
  catalog: AcpLoginCatalog,
  threadId: string,
): Promise<void> {
  const context = { source: provider.id, event: 'provider.loginCatalog', threadId };
  if (catalog.created === null) {
    if (catalog.error !== null) core.logs.record('warn', `The ${provider.name} sign-in did not list its models: ${catalog.error}`, context);
    return;
  }
  try {
    const models = await rememberSessionModels(provider, account.id, catalog.created);
    if (models === null || core.journal.isClosed() || core.journal.getAccount(account.id)?.status !== 'ok') return;
    core.bus.emit('providers.probed', { providerId: provider.id, accountId: account.id, models, probedAt: Date.now() });
    core.logs.record('info', `The ${provider.name} sign-in listed ${models.length} models`, { ...context, data: { models: models.length } });
  } catch (error) {
    core.logs.record('warn', `The ${provider.name} sign-in did not list its models: ${messageOf(error)}`, context);
  }
}
