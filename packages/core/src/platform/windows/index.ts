import type { ProcessPlatform } from '../types.ts';
import * as jobs from './jobs.ts';
import * as guard from './guard.ts';

export const platform: ProcessPlatform = {
  retain(events, protections) {
    jobs.retainJobs(events);
    guard.retainGuard(protections);
  },
  async release() {
    await Promise.all([jobs.releaseJobs(), guard.releaseGuard()]);
  },
  capability: jobs.jobsCapability,
  applySettings(settings) {
    jobs.setProcessLimits(settings);
    guard.setGuardEnabled(settings.focusGuard);
    guard.setGuardMute(settings.muteAgents);
  },
  attach: jobs.assignToThreadJob,
  terminate: jobs.terminateThreadJob,
  terminateProcess: jobs.terminateJobProcess,
  terminateUnassigned(pid) {
    // Only a pid captured by the registry may reach this fallback.
    try {
      Bun.spawnSync({
        cmd: ['taskkill', '/T', '/F', '/PID', String(pid)],
        stdout: 'ignore', stderr: 'ignore', windowsHide: true,
      });
    } catch {
      // The registry also calls the child's own kill method.
    }
  },
  sample: jobs.sampleThreadJob,
  pidAdded: guard.guardPidAdded,
  pidRemoved: guard.guardPidRemoved,
  warm() {
    jobs.warmJobs();
    guard.warmGuard();
  },
  forget: jobs.releaseThreadJob,
  guardStatus: guard.guardStatus,
};
