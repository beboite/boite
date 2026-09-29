/** Age of a release, refreshed whenever its popover opens. Invalid dates stay absent. */
export function releaseAge(publishedAt: string | null, now: number, locale: string): string | null {
  if (!publishedAt) return null;
  const timestamp = Date.parse(publishedAt);
  if (!Number.isFinite(timestamp)) return null;
  const seconds = Math.max(0, (now - timestamp) / 1000);
  const [size, unit]: [number, Intl.RelativeTimeFormatUnit] = seconds >= 86400
    ? [86400, 'day'] : seconds >= 3600 ? [3600, 'hour'] : [60, 'minute'];
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-Math.floor(seconds / size), unit);
}
