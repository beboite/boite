/**
 * How old an update reading may be when a machine connects or the window is
 * shown again before it is checked anew. Each core and the desktop app also
 * check on their own every six hours; without this, a release published
 * since stayed hidden behind "Up to date" until a manual check.
 */
export const UPDATE_STALE_MS = 15 * 60_000;

/** A reading never taken, or taken longer ago than `UPDATE_STALE_MS`. */
export function updateStale(checkedAt: number | null, now = Date.now()): boolean {
  return checkedAt === null || now - checkedAt > UPDATE_STALE_MS;
}

/** What a machine's store offers to check its updates again. */
export interface FreshenedMachine {
  connection: string;
  owner: boolean;
  localCore: boolean;
  serverUpdater: { freshen(now: number): Promise<void> };
  freshenHarnessUpdates(now: number): Promise<void>;
}

/**
 * The window is shown again: every machine whose Boite or agents were last
 * checked too long ago is checked now, and so is this computer's app. The
 * computer the desktop app runs on updates Boite through the app, not its core.
 */
export function freshenUpdates(machines: readonly FreshenedMachine[], app: { checkIfStale(now: number): void }, now = Date.now()): void {
  app.checkIfStale(now);
  for (const machine of machines) {
    if (machine.connection !== 'ready' || !machine.owner) continue;
    if (!machine.localCore) void machine.serverUpdater.freshen(now);
    void machine.freshenHarnessUpdates(now);
  }
}
