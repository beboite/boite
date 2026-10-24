import type { ProcessPlatform } from '../types.ts';
import { totalmem } from 'node:os';
import { resolveMemoryLimits } from '../../memory-limits.ts';
import { machineMemory } from './memory.ts';
import * as jobs from './jobs.ts';
import * as guard from './guard.ts';
import { findTailscaleCli } from '../tailscale.ts';
import { firewallAllow, firewallQuery } from './firewall.ts';
import { WindowsExecutionBoundary } from './protected.ts';

export const platform: ProcessPlatform = {
  protectedExecution: new WindowsExecutionBoundary(),
  tailscaleCli: () => findTailscaleCli('windows'),
  firewall: { query: firewallQuery, allow: firewallAllow },
  retain(events, protections) {
    jobs.retainJobs(events);
    guard.retainGuard(protections);
  },
  async release() {
    await Promise.all([jobs.releaseJobs(), guard.releaseGuard()]);
  },
  capability: jobs.jobsCapability,
  applySettings(settings) {
    jobs.setProcessLimits({ ...settings, ...resolveMemoryLimits(settings, machineMemory()?.totalBytes ?? totalmem()) });
    guard.setGuardEnabled(settings.focusGuard);
    guard.setGuardMute(settings.muteAgents);
  },
  attach: jobs.assignToThreadJob,
  startup: jobs.setThreadStartup,
  terminate: jobs.terminateThreadJob,
  terminateProcess: jobs.terminateJobProcess,
  terminateUnassigned(pid) {
    // Only a pid captured by the registry may reach this fallback. Not through
    // procs.spawn: taskkill must not join the thread it stops. Async, so its
    // start (tens to hundreds of ms) does not hold the event loop.
    try {
      const taskkill = Bun.spawn({
        cmd: ['taskkill', '/T', '/F', '/PID', String(pid)],
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true,
      });
      return taskkill.exited.catch(() => undefined);
    } catch {
      // The registry also calls the child's own kill method.
      return undefined;
    }
  },
  sample: jobs.sampleThreadJob,
  machineMemory,
  pidAdded: (threadId, pid, guarded) => { if (guarded) guard.guardPidAdded(threadId, pid); },
  pidRemoved: (threadId, pid, guarded) => { if (guarded) guard.guardPidRemoved(threadId, pid); },
  warm() {
    jobs.warmJobs();
    guard.warmGuard();
  },
  forget: jobs.releaseThreadJob,
  guardStatus: guard.guardStatus,
  startedAt: jobs.processStartedAt,
  runningSince: jobs.processRunningSince,
};
