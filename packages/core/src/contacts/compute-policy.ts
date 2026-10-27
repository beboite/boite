import type { PermissionMode, Protocol, SharedComputeJob, SharedComputeStart, SharedExecutionProtection } from '@boite/contracts';
import { invalidParams, refused } from '../errors.ts';
import { text } from '../coordination-letter.ts';
import { projectRef, sameProject, threadRef } from './project-policy.ts';

export function computeInput(raw: SharedComputeStart): SharedComputeStart {
  if (!raw || typeof raw !== 'object') throw invalidParams('compute: expected a job request');
  for (const field of Object.keys(raw)) if (!['requestId', 'host', 'profileId', 'task', 'title', 'baseCommit', 'claimId'].includes(field)) throw invalidParams(`compute.${field}: expected only job fields, no path, account, permission or result`);
  const baseCommit = commit(raw.baseCommit, 'baseCommit');
  return { requestId: text(raw.requestId, 'requestId', 100), host: projectRef(raw.host, 'host'), profileId: text(raw.profileId, 'profileId', 128), task: text(raw.task, 'task', 12000), baseCommit,
    ...(raw.title === undefined ? {} : { title: text(raw.title, 'title', 120) }), ...(raw.claimId === undefined ? {} : { claimId: text(raw.claimId, 'claimId', 100) }) };
}
export function commit(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw)) throw invalidParams(`${field}: expected a full lowercase git commit object id`);
  return raw;
}
/** No ACP fallback to a plain mode and no pi promise of approvals it cannot enforce. */
export function sharedPermissionSupport(protocol: Protocol, mode: PermissionMode, providerId?: string): boolean {
  if (protocol === 'pi') return mode === 'yolo' || mode === 'bypassPermissions';
  if (protocol === 'acp') return providerId === 'opencode' && (mode === 'default' || mode === 'plan');
  if (protocol === 'echo') return mode === 'default';
  return protocol === 'claude-sdk' || protocol === 'codex-appserver' || protocol === 'muse';
}
/** Approval callbacks, cwd and provider sandbox names do not attest selective secret-file isolation. */
export function sharedExecutionProtection(protocol: Protocol, nativeAvailable = false, providerId?: string): SharedExecutionProtection {
  if (protocol === 'echo') return {supported: true, boundary: 'no-tools'};
  if (nativeAvailable && (protocol === 'claude-sdk' || protocol === 'codex-appserver' || protocol === 'muse' || protocol === 'pi' || protocol === 'acp' && providerId === 'opencode')) return {supported: true, boundary: 'isolated-process'};
  const reason: Record<Exclude<Protocol, 'echo'>, string> = {
    'claude-sdk': 'Claude protected tools require a supported native host boundary and its userspace helper',
    'codex-appserver': 'Codex protected tools require a supported native host boundary and its userspace helper',
    acp: 'Protected ACP requires verified OpenCode 1.19.3 with its core-owned extension and a native host boundary; generic ACP claims are insufficient',
    muse: 'Muse protected execution requires verified native 1.4.13 with mandatory MCP-only admission and a supported native host boundary',
    pi: 'pi protected tools require its native extension and a supported native host boundary; native approvals remain unavailable',
  };
  return {supported: false, reason: reason[protocol]};
}
/** Project only the wire contract. A malicious peer's path/account/result extras never become local authority. */
export function checkedComputeJob(raw: SharedComputeJob, expected: SharedComputeJob, repository: string): SharedComputeJob {
  if (!raw || raw.id !== expected.id || raw.sharedProjectId !== expected.sharedProjectId || raw.requestId !== expected.requestId || !sameProject(projectRef(raw.host), expected.host)
    || JSON.stringify(threadRef(raw.source)) !== JSON.stringify(expected.source) || raw.profileId !== expected.profileId || raw.grantRevision !== expected.grantRevision || raw.claimId !== expected.claimId) throw refused('compute.job: expected the exact requested source, host, project and grant');
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0 || !['queued', 'running', 'waiting', 'uncertain', 'done', 'failed', 'cancelled', 'revoked'].includes(raw.status) || !Number.isSafeInteger(raw.createdAt) || !Number.isSafeInteger(raw.updatedAt)
    || !['default', 'plan', 'acceptEdits', 'bypassPermissions', 'yolo', 'dontAsk'].includes(raw.permissionMode)) throw invalidParams('compute.job: expected job state, permission and timestamps');
  const worker = raw.worker === null ? null : threadRef(raw.worker);
  if (worker && !sameProject(worker.project, expected.host)) throw refused('compute.worker: expected the requested execution host');
  let result: SharedComputeJob['result'] = null;
  if (raw.result !== null) {
    const r = raw.result;
    if (raw.status !== 'done' || !worker || r.repository !== repository || !/^boite\/sub-[a-z0-9]+$/.test(r.branch) || r.branch !== `boite/sub-${worker.threadId.slice(4, 14)}` || typeof r.dirty !== 'boolean') throw refused('compute.result: expected the captured worker branch and associated repository');
    result = { repository, branch: r.branch, baseCommit: commit(r.baseCommit, 'result.baseCommit'), commit: commit(r.commit, 'result.commit'), dirty: r.dirty, text: typeof r.text === 'string' ? r.text.slice(0, 4000) : '' };
  }
  if (raw.status === 'done' && result === null) throw refused('compute.result: a done job must include host-verified git provenance');
  return { id: expected.id, revision: raw.revision, sharedProjectId: expected.sharedProjectId, requestId: expected.requestId, source: expected.source, host: expected.host, worker,
    grantRevision: expected.grantRevision, profileId: expected.profileId, providerId: text(raw.providerId, 'job.providerId', 128), model: raw.model === null ? null : text(raw.model, 'job.model', 256),
    effort: raw.effort === null ? null : text(raw.effort, 'job.effort', 64), permissionMode: raw.permissionMode, status: raw.status, claimId: expected.claimId, result,
    error: raw.error === null ? null : text(raw.error, 'job.error', 500), createdAt: raw.createdAt, updatedAt: raw.updatedAt };
}
