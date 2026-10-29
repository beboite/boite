import type { DesktopUpdateStatus, ProviderId } from '@boite/contracts';
import type { Core } from './core.ts';
import { refused } from './errors.ts';
import { machineName } from './paths.ts';
import type { Connection } from './router.ts';

const PHASES: ReadonlySet<DesktopUpdateStatus['phase']> = new Set(['idle', 'checking', 'current', 'available', 'downloading', 'ready', 'waiting', 'installing', 'error']);
/** Phases from which the window can still be asked to install the offered release. */
const STARTABLE: ReadonlySet<DesktopUpdateStatus['phase']> = new Set(['available', 'downloading', 'ready', 'error']);
/** Phases where the window is already installing: asking again changes nothing. */
const UNDER_WAY: ReadonlySet<DesktopUpdateStatus['phase']> = new Set(['waiting', 'installing']);
/** How often the wait for agent updates looks again; they last seconds to minutes. */
const AGENT_POLL_MS = 250;

/**
 * The desktop window this core's own shell opened: the core token, on
 * loopback, from the shell. A member of the group comes in with a session,
 * a phone from another address, a plugin or the CLI under another name; none
 * of them holds this machine's installer.
 */
export function isLocalWindow(connection: Connection): boolean {
  return connection.identity.principal === 'owner' && connection.identity.sessionId === null
    && connection.remote === false && connection.clientName === 'shell';
}

function text(value: unknown, field: string, max: number, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length > max) {
    throw refused(`core.desktopUpdateReport.status.${field} must be a string of at most ${max} characters${nullable ? ' or null' : ''}`, { field: `status.${field}` });
  }
  return value;
}

function count(value: unknown, field: string, nullable: boolean): number | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw refused(`core.desktopUpdateReport.status.${field} must be a number of bytes${nullable ? ' or null' : ''}`, { field: `status.${field}` });
  }
  return value;
}

function statusOf(value: unknown): DesktopUpdateStatus {
  if (typeof value !== 'object' || value === null) throw refused('core.desktopUpdateReport.status must be the desktop updater\'s snapshot', { field: 'status' });
  const status = value as Record<string, unknown>;
  if (!PHASES.has(status.phase as DesktopUpdateStatus['phase'])) {
    throw refused(`core.desktopUpdateReport.status.phase must be one of ${[...PHASES].join(', ')}`, { field: 'status.phase' });
  }
  if (status.channel !== 'stable' && status.channel !== 'nightly') {
    throw refused('core.desktopUpdateReport.status.channel must be stable or nightly', { field: 'status.channel' });
  }
  return {
    phase: status.phase as DesktopUpdateStatus['phase'],
    currentVersion: text(status.currentVersion, 'currentVersion', 80, false)!,
    version: text(status.version, 'version', 80, true),
    channel: status.channel,
    received: count(status.received, 'received', false)!,
    total: count(status.total, 'total', true),
    error: text(status.error, 'error', 2000, true),
  };
}

/**
 * The desktop app's updater, as this machine's own window reports it. Only
 * the window can install a release (the shell's updater answers its own
 * webview alone), so another machine of the group reads its state here and
 * asks for an install through `request`, which the core hands to that window
 * as `ui.appUpdate`.
 */
export class DesktopUpdates {
  /** The window that reported last; `connection` is null once a window installing the release has closed for it. */
  private reporter: { connection: Connection | null; status: DesktopUpdateStatus; release: (() => void) | undefined } | null = null;
  private closed = false;

  constructor(private readonly core: Core) {}

  /** The machine as an error names it: what the group shows comes from the same host name. */
  private get machine(): string { return machineName(); }

  snapshot(): DesktopUpdateStatus | null {
    return this.reporter ? { ...this.reporter.status } : null;
  }

  report(params: { status?: unknown } | null, connection: Connection): { ok: true } {
    if (!isLocalWindow(connection)) {
      throw refused('core.desktopUpdateReport is for this machine\'s own desktop window only: the core token on loopback, client shell', { field: 'connection' });
    }
    const status = statusOf(params?.status);
    if (this.reporter?.connection !== connection) {
      this.reporter?.release?.();
      const release = connection.onClose?.(() => {
        if (this.reporter?.connection !== connection) return;
        // A window that closes to install keeps saying so until the next core
        // starts: a click elsewhere must not read the update as done or gone.
        if (UNDER_WAY.has(this.reporter.status.phase)) {
          this.reporter.connection = null;
          return;
        }
        this.reporter = null;
        this.core.bus.emit('core.desktopUpdateChanged', { status: null });
      });
      this.reporter = { connection, status, release };
    } else {
      this.reporter.status = status;
    }
    this.core.bus.emit('core.desktopUpdateChanged', { status: { ...status } });
    return { ok: true };
  }

  /**
   * Checks that this machine's window can take `version` now, without asking
   * it yet. Returns the reason it cannot, or null.
   */
  refusal(version: string): string | null {
    const status = this.reporter?.status;
    if (!status) return `Boite is not open on ${this.machine}`;
    if (this.reporter!.connection === null) return UNDER_WAY.has(status.phase) && status.version === version ? null : `Boite is not open on ${this.machine}`;
    if (UNDER_WAY.has(status.phase) && status.version === version) return null;
    if (status.version !== version) return `The desktop app on ${this.machine} offers ${status.version ?? 'no release'}, not ${version}`;
    if (!STARTABLE.has(status.phase)) return `The desktop app on ${this.machine} cannot install now (${status.phase})`;
    return null;
  }

  /** Hands `version` to this machine's window. Returns the reason it did not, or null once sent. */
  request(version: string): string | null {
    const problem = this.refusal(version);
    if (problem !== null) return problem;
    const reporter = this.reporter!;
    if (UNDER_WAY.has(reporter.status.phase) || reporter.connection === null) return null;
    try { reporter.connection.sendEvent('ui.appUpdate', { version }); }
    catch { return `Boite is not open on ${this.machine}`; }
    this.core.logs.info(`Desktop app update to ${version} handed to this machine's window`, { source: 'updates', event: 'desktop-update.requested', data: { version } });
    return null;
  }

  /**
   * Waits for `agents` to finish updating, then hands the release over: the
   * install restarts the core, which would cut an agent's updater off.
   */
  async requestAfter(agents: readonly ProviderId[], version: string): Promise<void> {
    while (!this.closed && agents.some((id) => this.core.updates.updating(id))) await Bun.sleep(AGENT_POLL_MS);
    if (this.closed) return;
    const problem = this.request(version);
    if (problem !== null) {
      this.core.logs.record('warn', `Desktop app update to ${version} not handed over: ${problem}`, { source: 'updates', event: 'desktop-update.refused', data: { version, error: problem } });
    }
  }

  close(): void {
    this.closed = true;
    this.reporter?.release?.();
    this.reporter = null;
  }
}
