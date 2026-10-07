import type { HarnessUpdate, ServerUpdateStatus } from '@boite/contracts';

/**
 * What one row of the machine list says about its updates: Boite on that
 * machine and every agent there, read as one word. The most pressing wins, so
 * a row never says "Up to date" over an agent that failed to update.
 */
export type MachineUpdateState = 'failed' | 'updating' | 'available' | 'checking' | 'current';

function newer(update: HarnessUpdate): boolean {
  return update.latest !== null && update.current !== null && update.latest !== update.current
    && (update.pending || update.skipped === update.latest || update.state === 'failed');
}

/** The user chose not to hear about this release again. */
export function harnessSkipped(update: HarnessUpdate): boolean {
  return update.skipped !== null && update.skipped === update.latest;
}

/** The release an agent's row offers: its arrow, its Update button and the machine's summary go together. */
export function harnessOffered(update: HarnessUpdate): boolean {
  return !harnessSkipped(update) && (update.pending || (update.state === 'failed' && newer(update)));
}

export interface MachineUpdates {
  /** Boite on a machine that updates itself; null on the computer the desktop app runs on, and before the first answer. */
  server: Pick<ServerUpdateStatus, 'phase'> | null;
  /** The desktop app's own updater, on the computer it runs on; null anywhere else. */
  app: { phase: string } | null;
  agents: readonly HarnessUpdate[];
}

const BUSY = ['downloading', 'waiting', 'installing'];

export function machineUpdateState({ server, app, agents }: MachineUpdates): MachineUpdateState | null {
  const phases = [server?.phase, app?.phase];
  if (phases.includes('error') || agents.some((update) => update.state === 'failed')) return 'failed';
  if (phases.some((phase) => phase !== undefined && BUSY.includes(phase)) || agents.some((update) => update.state === 'updating')) return 'updating';
  // `ready` is the desktop app's downloaded release, waiting for a restart.
  if (phases.includes('available') || phases.includes('ready') || agents.some(harnessOffered)) return 'available';
  if (phases.includes('checking') || agents.some((update) => update.state === 'checking')) return 'checking';
  // Nothing was read yet says nothing: a row is up to date only once something answered.
  const answered = phases.includes('current') || agents.some((update) => update.checkedAt !== null);
  return answered ? 'current' : null;
}
