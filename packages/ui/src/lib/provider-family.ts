import { providerEnabled, type Account, type ProviderSummary } from '@boite/contracts';
import { connected } from './provider-setup';

/**
 * Descriptors that are one agent to the person using them. Antigravity ships
 * twice, the server Boite downloads and the `agy` command the user installed
 * themselves; both sign in to the same Google account and answer with the
 * same models, so every list shows one Antigravity with both ways inside it.
 */
const FAMILY: Record<string, string> = { 'antigravity-cli': 'antigravity' };

/** The id of the row a provider is drawn in. */
export function familyOf(providerId: string): string {
  return FAMILY[providerId] ?? providerId;
}

export type ProviderRow = {
  /** The family's id: the head descriptor's own when it is loaded. */
  id: string;
  /** The head descriptor's name, never a member's "CLI" variant. */
  name: string;
  members: ProviderSummary[];
};

/** Providers folded into one row per family, in the order the first member arrives. */
export function providerRows(providers: readonly ProviderSummary[]): ProviderRow[] {
  const rows: ProviderRow[] = [];
  for (const provider of providers) {
    const id = familyOf(provider.id);
    const row = rows.find((entry) => entry.id === id);
    if (!row) {
      rows.push({ id, name: provider.name, members: [provider] });
      continue;
    }
    // The head goes first, whatever order the core listed them in.
    if (provider.id === id) {
      row.members.unshift(provider);
      row.name = provider.name;
    } else row.members.push(provider);
  }
  return rows;
}

/**
 * The Providers page's three lists: rows something can run on now, the ones
 * still to install or sign into, then the ones turned off, each in the core's
 * order. One signed-in member is enough for its family to count as connected,
 * and a family is off only when every member is.
 */
export function providerGroups(
  providers: readonly ProviderSummary[],
  accounts: Account[]
): { connected: ProviderRow[]; rest: ProviderRow[]; off: ProviderRow[] } {
  const rows = providerRows(providers);
  const on = (row: ProviderRow) => row.members.some((member) => connected(member, accounts));
  const off = (row: ProviderRow) => row.members.every((member) => !providerEnabled(member));
  return { connected: rows.filter(on), rest: rows.filter((row) => !on(row) && !off(row)), off: rows.filter(off) };
}
