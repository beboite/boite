import type { StewardCapability, StewardGrant } from '@boite/contracts';
import { count } from './format';
import { fill, strings } from './strings';

/** Capabilities a grant never carries unless the owner ticks them: they act in the user's place. */
export const RISKY_STEWARD_CAPABILITIES: readonly StewardCapability[] = ['permissions', 'remove'];

/** "Steward · 2 projects", the chip a steward thread wears beside its communication settings. */
export function stewardChip(grant: StewardGrant): string {
  if (grant.allProjects) return strings.steward.chipAll;
  return grant.projectIds.length === 1 ? strings.steward.chipOne : fill(strings.steward.chipMany, { count: count(grant.projectIds.length) });
}
