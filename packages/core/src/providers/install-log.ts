import type { ProviderInstallState, ProviderSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { programName } from '../threads/provider-process-log.ts';
import { knownVersion } from './versions.ts';

/**
 * One line per step of a managed install, not per progress tick: the step it
 * reached, the version, how long the install has run, and the failure message.
 */
export function installLogger(core: Core): (payload: ProviderInstallState & { providerId: string }) => void {
  const runs = new Map<string, { state: string; startedAt: number }>();
  return (payload) => {
    const run = runs.get(payload.providerId);
    if (run?.state === payload.state) return;
    const startedAt = run?.startedAt ?? Date.now();
    const durationMs = Date.now() - startedAt;
    const ended = payload.state === 'installed' || payload.state === 'failed' || payload.state === 'absent';
    if (ended) runs.delete(payload.providerId);
    else runs.set(payload.providerId, { state: payload.state, startedAt });
    // A list that reports an install already on disk is no step of a run.
    if (run === undefined && ended) return;
    const base = { source: 'updates', event: `provider.install.${payload.state}`, durationMs, data: { providerId: payload.providerId, version: payload.version, step: payload.state } };
    if (payload.state === 'downloading') core.logs.info(`Installing ${payload.providerId} ${payload.version}: downloading ${Math.round(payload.totalBytes / 1048576)} MiB`, { ...base, data: { ...base.data, totalBytes: payload.totalBytes } });
    else if (payload.state === 'failed') core.logs.warn(`Installing ${payload.providerId} ${payload.version} failed after ${Math.round(durationMs / 1000)} s: ${payload.message}`, { ...base, data: { ...base.data, reason: payload.message } });
    else if (payload.state === 'absent') core.logs.info(`Installing ${payload.providerId} ${payload.version} was cancelled`, { ...base, event: 'provider.install.cancelled' });
    else core.logs.info(`Installing ${payload.providerId} ${payload.version}: ${payload.state}`, base);
  };
}

/**
 * Which agents this machine can run, said once at startup and again whenever
 * one appears, disappears or moves to another program: the program's file
 * name and the version it reported, never its path.
 */
export function detectionLogger(core: Core): (providers: ProviderSummary[], rejected: number) => void {
  let last = new Map<string, string>();
  return (providers, rejected) => {
    const now = new Map<string, string>();
    for (const provider of providers) {
      const program = provider.executable === null ? null : programName(provider.executable);
      now.set(provider.id, `${provider.enabled === false ? 'off' : provider.available ? 'available' : 'missing'}|${program ?? ''}|${provider.executable === null ? '' : knownVersion(provider.executable) ?? ''}`);
    }
    const changed = [...now].filter(([id, state]) => last.get(id) !== state).map(([id]) => id);
    const gone = [...last.keys()].filter(id => !now.has(id));
    last = now;
    if (changed.length === 0 && gone.length === 0) return;
    for (const id of changed) {
      const [state, program, version] = now.get(id)!.split('|');
      core.logs.info(`Provider ${id} is ${state}${program ? `, program ${program}${version ? ` ${version}` : ''}` : ''}`, {
        source: 'providers', event: 'provider.detected', data: { providerId: id, state: state ?? null, program: program || null, version: version || null },
      });
    }
    for (const id of gone) core.logs.info(`Provider ${id} is no longer loaded`, { source: 'providers', event: 'provider.removed', data: { providerId: id } });
    if (rejected > 0) core.logs.warn(`${rejected} provider descriptors were rejected; Settings > Providers lists why`, { source: 'providers', event: 'provider.rejected', data: { rejected } });
  };
}

/** The steps of an agent update Boite runs: waiting for turns, started, finished. Returns the time the step was logged. */
export function logUpdate(core: Core, providerId: string, step: 'waiting' | 'started' | 'finished', data: Record<string, string | number | null>, startedAt?: number): number {
  const now = performance.now();
  const message = step === 'waiting' ? `Update of ${providerId} waits for ${data.running} running turns to pause or end`
    : step === 'started' ? `Updating ${providerId} from ${data.from ?? 'unknown'}`
      : `Update of ${providerId} ended ${data.state ?? 'unknown'}, now at ${data.to ?? 'unknown'}`;
  core.logs.record(step === 'finished' && data.state === 'failed' ? 'warn' : 'info', message, {
    source: 'updates', event: `provider.update.${step}`, ...(startedAt === undefined ? {} : { durationMs: now - startedAt }), data: { providerId, ...data },
  });
  return now;
}
