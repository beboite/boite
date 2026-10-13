import type { ProviderId, UpdateEverythingResult } from '@boite/contracts';
import type { Core } from './core.ts';
import { messageOf, refused } from './errors.ts';

/** More agents than any descriptor set ships is a malformed request, not a plan. */
const MAX_AGENTS = 64;

function agentsOf(value: unknown): ProviderId[] {
  if (!Array.isArray(value) || value.length > MAX_AGENTS || value.some((id) => typeof id !== 'string' || id === '')) {
    throw refused(`core.updateEverything.agents must be an array of at most ${MAX_AGENTS} provider ids`, { field: 'agents' });
  }
  return [...new Set(value as ProviderId[])];
}

/**
 * Starts every update of this machine the client listed: every agent at
 * once, then Boite's own download beside their updaters. The agents go first
 * because an update can wait on a version check before it counts as under
 * way, and a quick download must not reach the idle gate in that gap. The
 * installation then waits for them there (`Core.requestIdleShutdown` counts
 * an agent update as work), so the restart never replaces the core under a
 * half-written agent install.
 */
export async function updateEverything(core: Core, params: { agents?: unknown; server?: unknown } | null): Promise<UpdateEverythingResult> {
  const agents = agentsOf(params?.agents);
  const server = params?.server ?? null;
  if (server !== null && (typeof server !== 'string' || server === '')) {
    throw refused('core.updateEverything.server must be the offered version or null', { field: 'server' });
  }

  const started: ProviderId[] = [];
  const failed: UpdateEverythingResult['failed'] = [];
  await Promise.all(agents.map(async (requested) => {
    try {
      const id = core.providers.require(requested).id;
      // Already under way counts as started: the click asked for that very update.
      if (!core.updates.updating(id)) await core.updates.update(id);
      started.push(id);
    } catch (error) {
      failed.push({ providerId: requested, message: messageOf(error) });
    }
  }));
  let serverError: string | null = null;
  if (server !== null) {
    try { core.serverUpdates.install(server); }
    catch (error) { serverError = messageOf(error); }
  }
  // The order the client listed, not the order the updaters answered in.
  const order = (id: ProviderId) => agents.indexOf(id);
  started.sort((a, b) => order(a) - order(b));
  failed.sort((a, b) => order(a.providerId) - order(b.providerId));
  core.logs.info(`Update everything: ${started.length} agents started, ${failed.length} refused, Boite ${server === null ? 'not asked' : serverError === null ? `to ${server}` : 'refused'}`, {
    source: 'updates', event: 'update-everything.started',
    data: { agents: started.join(','), failed: failed.map((entry) => entry.providerId).join(','), server, serverError },
  });
  return { agents: started, failed, server: core.serverUpdates.snapshot(), serverError };
}
