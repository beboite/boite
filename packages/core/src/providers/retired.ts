import type { ProviderId } from '@boite/contracts';

/**
 * Providers Boite shipped once and no longer has. A data directory, an agent or
 * a plugin manifest from an older Boite can still name one: startup removes
 * their accounts (`account-retirement.ts`), a plugin's account pool drops the
 * id, and whatever else names it reads as any provider that is not installed.
 * `antigravity-cli` ran the user's `agy` in print mode; the managed ACP server
 * `antigravity` replaces it.
 */
export const RETIRED_PROVIDERS: ReadonlySet<ProviderId> = new Set(['antigravity-cli']);
