import type { ProcessPlatform } from '../types.ts';
import { totalmem, version } from 'node:os';
import { resolveMemoryLimits } from '../../memory-limits.ts';
import { machineMemory } from './memory.ts';
import { machineVolumes } from './volumes.ts';
import { readGpus, releaseGpus } from './gpu.ts';
import * as jobs from './jobs.ts';
import * as guard from './guard.ts';
import { findTailscaleCli } from '../tailscale.ts';
import { firewallAllow, firewallQuery } from './firewall.ts';
import { WindowsExecutionBoundary } from './protected.ts';
import { treeKill } from './tree-kill.ts';

export const platform: ProcessPlatform = {
  protectedExecution: new WindowsExecutionBoundary(),
  tailscaleCli: () => findTailscaleCli('windows'),
  firewall: { query: firewallQuery, allow: firewallAllow },
  // bun:ffi and the WinRT capture objects load with the first `boite window`, never at startup.
  windowCapture: async () => (await import('./window-capture.ts')).loadWindowCapture(),
  // UI Automation and the pointer's window class load with the first `boite window read` or `point`.
  windowGuide: async () => (await import('./window-guide.ts')).loadWindowGuide(),
  retain(events, protections) {
    jobs.retainJobs(events);
    guard.retainGuard(protections);
  },
  async release() {
    releaseGpus();
    await Promise.all([jobs.releaseJobs(), guard.releaseGuard()]);
  },
  capability: jobs.jobsCapability,
  applySettings(settings) {
    jobs.setProcessLimits({ ...settings, ...resolveMemoryLimits(settings, machineMemory()?.totalBytes ?? totalmem()) });
    guard.setGuardEnabled(settings.focusGuard);
    guard.setGuardMute(settings.muteAgents);
  },
  attach: jobs.assignToThreadJob,
  hasProcesses: jobs.threadJobHasProcesses,
  startup: jobs.setThreadStartup,
  terminate: jobs.terminateThreadJob,
  terminateProcess: jobs.terminateJobProcess,
  // Only a pid captured by the registry may reach this fallback. Async, so
  // taskkill's start (tens to hundreds of ms) does not hold the event loop.
  // The registry also calls the child's own kill method.
  terminateUnassigned: pid => treeKill(pid),
  sample: jobs.sampleThreadJob,
  machineMemory,
  machineVolumes,
  machineGpus: readGpus,
  osLabel: () => version() || null,
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
