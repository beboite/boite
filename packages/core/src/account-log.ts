import type { Account } from '@boite/contracts';
import type { Core } from './core.ts';

const loginsStarted = new Map<string, number>();

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
export function logLoginState(core: Core, account: Account | null, state: 'running' | 'done' | 'failed', output: string, exitCode: number | null): void {
  if (account === null) return;
  const base = { source: 'accounts', data: { accountId: account.id, providerId: account.providerId } };
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
  const reason = output.trim().slice(0, 300) || 'no reason printed';
  core.logs.warn(`Login failed for account ${account.id} of ${account.providerId}${exitCode === null ? '' : `, exit code ${exitCode}`}: ${reason}`, {
    ...base, event: 'account.login.failed', ...(durationMs === undefined ? {} : { durationMs }), data: { ...base.data, exitCode, reason },
  });
}
