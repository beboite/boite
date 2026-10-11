import type { Account } from '@boite/contracts';
import type { Core } from './core.ts';

/** When each running login started, per core: two cores in one process (tests) never share one. */
const loginsByCore = new WeakMap<Core, Map<string, number>>();

/** An account's connection status moved: signed in, signed out, broken. Never the identity itself. */
export function logAccountStatus(core: Core, account: Account, status: Account['status']): void {
  const level = status === 'ok' ? 'info' : 'warn';
  core.logs.record(level, `Account ${account.id} of ${account.providerId} went from ${account.status} to ${status}`, {
    source: 'accounts', event: 'account.status', data: { accountId: account.id, providerId: account.providerId, from: account.status, status, isolated: account.isolationDir !== null },
  });
}

/**
 * A login run, from its start to its end: one line when it starts and one
 * when it ends, with how long it took and the last line the login printed on
 * a failure. The lines in between reach the live log only.
 */
export function logLoginState(core: Core, account: Account | null, state: 'running' | 'done' | 'failed', output: string, exitCode: number | null, cancelled = false): void {
  if (account === null) return;
  const base = { source: 'accounts', data: { accountId: account.id, providerId: account.providerId } };
  let loginsStarted = loginsByCore.get(core);
  if (loginsStarted === undefined) { loginsStarted = new Map(); loginsByCore.set(core, loginsStarted); }
  if (state === 'running') {
    if (loginsStarted.has(account.id)) return;
    loginsStarted.set(account.id, Date.now());
    core.logs.info(`Login started for account ${account.id} of ${account.providerId}`, { ...base, event: 'account.login.started' });
    return;
  }
  const startedAt = loginsStarted.get(account.id);
  loginsStarted.delete(account.id);
  const durationMs = startedAt === undefined ? undefined : Date.now() - startedAt;
  if (state === 'done') {
    core.logs.info(`Login succeeded for account ${account.id} of ${account.providerId}`, { ...base, event: 'account.login.succeeded', ...(durationMs === undefined ? {} : { durationMs }) });
    return;
  }
  // A login line often carries its sign-in link with device or OAuth parameters: only the site stays.
  const reason = output.trim().slice(0, 300).replace(/(https?:\/\/[^\s/?#]+)\S*/g, '$1/<redacted>') || 'no reason printed';
  // The user stopped it: lifecycle, not a problem to group. The run says so, whatever the login printed last.
  if (cancelled) {
    core.logs.info(`Login cancelled for account ${account.id} of ${account.providerId}`, { ...base, event: 'account.login.cancelled', ...(durationMs === undefined ? {} : { durationMs }) });
    return;
  }
  core.logs.warn(`Login failed for account ${account.id} of ${account.providerId}${exitCode === null ? '' : `, exit code ${exitCode}`}: ${reason}`, {
    ...base, event: 'account.login.failed', ...(durationMs === undefined ? {} : { durationMs }), data: { ...base.data, exitCode, reason },
  });
}
