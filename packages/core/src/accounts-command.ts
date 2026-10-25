import type { Account } from '@boite/contracts';
import type { CoreClient } from './client.ts';

/** `main.ts`'s connection to the running core as its owner, passed in so this module loads only for its command. */
export type OwnerClient = (argv: string[]) => Promise<CoreClient>;

/**
 * `boite-core accounts [--refresh] [--json]`: the agent accounts of the core
 * already running on this data directory and whether each is signed in, the
 * Providers page of a machine with no window. `--refresh` first reloads the
 * providers, which adopts the default account of a CLI login made since the
 * core started, then asks each account's agent again, as the Providers
 * page's check does: a login file alone does not clear a refusal the agent
 * gave before.
 */
export async function accounts(argv: string[], ownerClient: OwnerClient): Promise<Account[]> {
  const client = await ownerClient(argv);
  try {
    if (!argv.includes('--refresh')) return await client.call('accounts.list', {});
    await client.call('providers.reload', {});
    const listed = await client.call('accounts.list', {});
    // A failed check leaves the account in `error`, which the list then shows.
    await Promise.allSettled(listed.map((account) => client.call('accounts.check', { accountId: account.id, refresh: true })));
    return await client.call('accounts.list', {});
  } finally {
    client.close();
  }
}

/** One line per account: provider, status, then the label, which may hold spaces. */
function describeAccounts(list: Account[]): string {
  if (list.length === 0) return 'no agent account: install an agent, or sign in with its CLI and run boite-core accounts --refresh\n';
  return list.map((account) => `${account.providerId}\t${account.status}\t${account.label}${account.identity ? ` (${account.identity})` : ''}\n`).join('');
}

/** Loaded by `main.ts` only for this command: the entry every core starts from stays small. */
export function runAccounts(argv: string[], ownerClient: OwnerClient): void {
  accounts(argv, ownerClient).then(
    (list) => {
      process.stdout.write(argv.includes('--json') ? `${JSON.stringify(list)}\n` : describeAccounts(list));
      process.exit(0);
    },
    (error: unknown) => {
      process.stderr.write(`boite-core accounts: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
