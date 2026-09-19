import type { Account, ProviderInstallState, ProviderSummary } from '@boite/contracts';

/**
 * Where one provider stands for a user who only wants it to work. The Providers
 * page draws one row per provider and each row has exactly one of these, so it
 * never offers two next steps at once.
 *
 * - `installing`: Boite is downloading the agent.
 * - `install`: the agent is missing and Boite can download it.
 * - `repair`: the managed files are recorded as installed yet nothing resolves.
 * - `manual`: the agent is missing and only its own installer can put it there.
 * - `signing-in`: a login Boite started is running.
 * - `sign-in`: the agent is there, no account is logged in, Boite can log one in.
 * - `external`: same, but the agent only logs in from its own interface.
 * - `ready`: at least one account is logged in.
 */
export type SetupStep =
  | 'installing'
  | 'install'
  | 'repair'
  | 'manual'
  | 'signing-in'
  | 'sign-in'
  | 'external'
  | 'ready';

export function installRunning(install: ProviderInstallState | null): boolean {
  return install !== null && install.state !== 'absent' && install.state !== 'installed' && install.state !== 'failed';
}

export function setupStep(
  provider: ProviderSummary,
  install: ProviderInstallState | null,
  accounts: Account[],
  loggingIn: (accountId: string) => boolean
): SetupStep {
  if (installRunning(install)) return 'installing';
  if (!provider.available) {
    if (install === null) return 'manual';
    return install.state === 'installed' ? 'repair' : 'install';
  }
  if (accounts.some((account) => loggingIn(account.id))) return 'signing-in';
  if (accounts.some((account) => account.status === 'ok')) return 'ready';
  return provider.login ? 'sign-in' : 'external';
}

/** The account a sign-in from the row lands on: one Boite already made and nobody is logged into. */
export function signInTarget(accounts: Account[]): Account | null {
  return accounts.find((account) => account.isolationDir !== null && account.status !== 'ok') ?? null;
}

/** "Claude", then "Claude 2": a label the user never has to type. */
export function nextAccountLabel(provider: ProviderSummary, accounts: Account[]): string {
  const taken = new Set(accounts.map((account) => account.label));
  if (!taken.has(provider.name)) return provider.name;
  let index = 2;
  while (taken.has(`${provider.name} ${index}`)) index += 1;
  return `${provider.name} ${index}`;
}
