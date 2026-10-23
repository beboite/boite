import { QUOTA_ALERT_PERIODS, QUOTA_ALERT_THRESHOLDS, quotaAlertPeriod, type AccountQuota, type QuotaAlert, type QuotaAlertPeriod, type QuotaAlerts } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams } from './errors.ts';

const SETTING = 'quota-alerts';
const FIRED = 'quota-alerts.fired';
/**
 * How often the accounts with an alert are read while no client asks. Each
 * read is one HTTP request, or one short app-server for Codex; the minute of
 * cache and the failure backoff of the quota store still apply.
 */
export const QUOTA_ALERTS = { pollMs: 300_000 };
/** How far under its threshold a window falls before it may alert again without a reset. */
const REARM_POINTS = 10;

/** One window that alerted, kept so a restart or the next reading does not say it twice. */
type Fired = { threshold: number; resetsAt: number | null; at: number };
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ObjectValue : {};
const key = (accountId: string, windowId: string) => `${accountId}\n${windowId}`;

/**
 * The alerts set per account, and which windows already alerted. A window
 * alerts once when its used share reaches the threshold of its period, then
 * again only after its reset time passed or it fell `REARM_POINTS` below.
 */
export class QuotaAlertStore {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private core: Core, private poll: () => Promise<void>) {}

  /** Every account's alerts, as saved; a malformed entry is dropped, never thrown. */
  all(): Record<string, QuotaAlerts> {
    const saved = object(this.core.journal.getSetting(SETTING));
    const result: Record<string, QuotaAlerts> = {};
    for (const [accountId, value] of Object.entries(saved)) {
      const alerts: QuotaAlerts = {};
      for (const period of QUOTA_ALERT_PERIODS) {
        const threshold = object(value)[period];
        if (typeof threshold === 'number' && QUOTA_ALERT_THRESHOLDS.includes(threshold)) alerts[period] = threshold;
      }
      if (Object.keys(alerts).length) result[accountId] = alerts;
    }
    return result;
  }

  /** The row with its alerts, the way every list and event shows it. */
  decorate(row: AccountQuota): AccountQuota {
    const alerts = this.all()[row.accountId];
    if (alerts) return { ...row, alerts };
    if (!row.alerts) return row;
    const { alerts: _gone, ...rest } = row;
    return rest;
  }

  /**
   * Saves one period's threshold. A window of `row` already past it counts as
   * alerted: the user is looking at it as they choose.
   */
  set(accountId: string, period: QuotaAlertPeriod, threshold: number | null, row: AccountQuota | undefined): void {
    if (!QUOTA_ALERT_PERIODS.includes(period)) throw invalidParams(`quotas.alert period must be one of ${QUOTA_ALERT_PERIODS.join(', ')}`, { field: 'period', expected: QUOTA_ALERT_PERIODS });
    if (threshold !== null && !QUOTA_ALERT_THRESHOLDS.includes(threshold)) {
      throw invalidParams(`quotas.alert threshold must be null or one of ${QUOTA_ALERT_THRESHOLDS.join(', ')}`, { field: 'threshold', expected: [null, ...QUOTA_ALERT_THRESHOLDS] });
    }
    const all = this.all();
    const alerts: QuotaAlerts = { ...all[accountId] };
    if (threshold === null) delete alerts[period];
    else alerts[period] = threshold;
    if (Object.keys(alerts).length) all[accountId] = alerts;
    else delete all[accountId];
    this.core.journal.append({ type: 'quotas.alertSet', threadId: null, version: 1, payload: { accountId, period, threshold } }, () => this.core.journal.setSetting(SETTING, all));
    const fired = this.fired();
    for (const window of row?.windows ?? []) {
      if (quotaAlertPeriod(window) !== period) continue;
      if (threshold !== null && window.usedPercent >= threshold) fired[key(accountId, window.id)] = { threshold, resetsAt: window.resetsAt, at: Date.now() };
      else delete fired[key(accountId, window.id)];
    }
    this.save(fired);
  }

  /** An account that is gone takes its alerts with it. */
  forget(accountId: string): void {
    const all = this.all();
    if (all[accountId]) {
      delete all[accountId];
      this.core.journal.setSetting(SETTING, all);
    }
    this.rearm(accountId);
  }

  /** Another login on the same account: its windows are not the ones that alerted. The thresholds stay. */
  rearm(accountId: string): void {
    const fired = this.fired();
    const prefix = key(accountId, '');
    const kept = Object.fromEntries(Object.entries(fired).filter(([name]) => !name.startsWith(prefix)));
    if (Object.keys(kept).length !== Object.keys(fired).length) this.save(kept);
  }

  /** The accounts some alert watches: what the poll reads. */
  watched(): string[] { return Object.keys(this.all()); }

  /**
   * Fresh readings only: a failed read keeps old windows, and a window whose
   * reset time passed describes a period that is over. `readAt` is when the
   * reading was taken, its `checkedAt` unless given: one taken before a
   * window alerted is older news and neither re-arms nor alerts it.
   */
  check(rows: AccountQuota[], now = Date.now(), readAt?: number): void {
    const config = this.all();
    if (!rows.some((row) => config[row.accountId])) return;
    const fired = this.fired();
    let changed = false;
    for (const row of rows) {
      const alerts = config[row.accountId];
      if (!alerts || row.status !== 'ready' || row.error) continue;
      for (const window of row.windows) {
        const period = quotaAlertPeriod(window);
        if (period === null) continue;
        const threshold = alerts[period];
        const name = key(row.accountId, window.id);
        const record = fired[name];
        if (record && (readAt ?? row.checkedAt ?? now) < record.at) continue;
        if (record && (threshold === undefined || record.threshold !== threshold || window.usedPercent <= record.threshold - REARM_POINTS
          || (record.resetsAt !== null && now >= record.resetsAt))) {
          delete fired[name];
          changed = true;
        }
        if (threshold === undefined || fired[name] || window.usedPercent < threshold || (window.resetsAt !== null && window.resetsAt <= now)) continue;
        fired[name] = { threshold, resetsAt: window.resetsAt, at: now };
        changed = true;
        const alert: QuotaAlert = { accountId: row.accountId, providerId: row.providerId, providerName: row.providerName,
          label: row.label.trim() || row.providerName, period, threshold, window, at: now };
        this.core.logs.info(`The ${period === 'fiveHour' ? '5-hour' : 'weekly'} limit of ${alert.label} (${row.providerName}) reached ${Math.round(window.usedPercent)}%, past its ${threshold}% alert`, {
          source: 'quotas', event: 'quota.alert', data: { accountId: row.accountId, windowId: window.id, threshold, usedPercent: window.usedPercent },
        });
        this.core.bus.emit('quotas.alerted', alert);
      }
    }
    if (changed) this.save(fired);
  }

  /** Reads the watched accounts every `QUOTA_ALERTS.pollMs`, so an alert goes out with no window open. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.watched().length) return;
      void this.poll().catch((error: unknown) => this.core.log('warn', `quota alerts: ${error instanceof Error ? error.message : String(error)}`, { source: 'quotas', event: 'quota.alert' }));
    }, QUOTA_ALERTS.pollMs);
    this.timer.unref?.();
  }

  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private fired(): Record<string, Fired> {
    const saved = object(this.core.journal.getSetting(FIRED));
    const result: Record<string, Fired> = {};
    for (const [name, value] of Object.entries(saved)) {
      const row = object(value);
      if (typeof row['threshold'] === 'number' && typeof row['at'] === 'number' && (row['resetsAt'] === null || typeof row['resetsAt'] === 'number')) {
        result[name] = { threshold: row['threshold'], resetsAt: row['resetsAt'] as number | null, at: row['at'] };
      }
    }
    return result;
  }

  private save(fired: Record<string, Fired>): void {
    if (!this.core.journal.isClosed()) this.core.journal.setSetting(FIRED, fired);
  }
}
