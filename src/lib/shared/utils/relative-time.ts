import { t } from "$lib/i18n/index.svelte";

/**
 * How long something took, and how long ago it happened.
 *
 * One place, because three surfaces were about to answer it three ways: the
 * commit rows on the dashboard, the terminal rows beside them, and the git
 * strip that had the only copy until now. The strip's own words are reused
 * rather than rewritten, so "2 h" reads the same wherever it appears.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MONTH = DAY * 30;
const YEAR = DAY * 365;

/** The largest unit that still says something true, and nothing after it. */
export function formatSpan(ms: number): string {
  const span = Math.max(0, ms);
  if (span < MINUTE) return t("time.seconds", { count: Math.floor(span / 1000) });
  if (span < HOUR) return t("time.minutes", { count: Math.floor(span / MINUTE) });
  if (span < DAY) return t("time.hours", { count: Math.floor(span / HOUR) });
  if (span < MONTH) return t("time.days", { count: Math.floor(span / DAY) });
  if (span < YEAR) return t("time.months", { count: Math.floor(span / MONTH) });
  return t("time.years", { count: Math.floor(span / YEAR) });
}

/**
 * The same span as a moment in the past. Under a minute is "just now" rather
 * than a count of seconds: a row that ticks 1, 2, 3 draws the eye to the one
 * thing on the page that is not worth reading.
 */
export function formatAgo(ms: number): string {
  if (ms < MINUTE) return t("time.justNow");
  return t("time.ago", { span: formatSpan(ms) });
}
