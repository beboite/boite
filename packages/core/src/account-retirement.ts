import { rmSync } from 'node:fs';
import type { Core } from './core.ts';
import { ownIsolationDir } from './accounts.ts';
import { RETIRED_PROVIDERS } from './providers/retired.ts';

/**
 * At startup, the accounts of a provider Boite no longer ships leave, with the
 * limits switch an older core kept for that provider's own quota source
 * (`quota:<provider>`). A conversation that named one stays and reads as on a
 * removed account: its next send refuses until the user picks another account
 * in its model picker (`threads/account-fallback.ts`).
 */
export function dropRetiredAccounts(core: Core): void {
  const retired = core.accounts.list().filter((account) => RETIRED_PROVIDERS.has(account.providerId));
  const stale = new Set([...retired.map((account) => account.id), ...[...RETIRED_PROVIDERS].map((id) => `quota:${id}`)]);
  const stored = core.journal.getSetting('quota-accounts');
  const quotas = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
  const kept = Object.fromEntries(Object.entries(quotas).filter(([id]) => !stale.has(id)));
  const quotasChanged = Object.keys(kept).length !== Object.keys(quotas).length;
  if (retired.length === 0 && !quotasChanged) return;
  for (const account of retired) {
    const directory = ownIsolationDir(core.dataDir, account);
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
    core.journal.append({ type: 'account.removed', threadId: null, version: 1, payload: { accountId: account.id } }, () => {
      core.journal.deleteAccount(account.id);
      core.journal.deleteSetting(`account-auth-rejected:${account.id}`);
    });
  }
  const grants = core.workforce.resident.grants();
  if (grants.some((grant) => stale.has(grant.accountId))) core.journal.setSetting('agents:account-grants', grants.filter((grant) => !stale.has(grant.accountId)));
  if (quotasChanged) core.journal.setSetting('quota-accounts', kept);
  core.log('info', `retired providers: removed ${retired.length} account(s) of ${[...RETIRED_PROVIDERS].join(', ')}`);
}
