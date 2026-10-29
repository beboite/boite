import type { PullRequestWatch } from '@boite/contracts';
import { time } from './format';
import { fill, strings } from './strings';

/** What a pull request watch last saw, or why it waits: the line beside its number in the panel and the header's menu. */
export function watchStatus(watch: PullRequestWatch): string {
  if (watch.paused) return fill(watch.paused.reason === 'rate-limit' ? strings.tasks.watchRateLimited : strings.tasks.watchUnreachable, { time: time(watch.paused.until) });
  const seen = watch.seen;
  if (!seen) return strings.tasks.watchNotRead;
  const { total, running, failed } = seen.checks;
  const parts = total === 0 ? [strings.tasks.watchNoChecks] : [
    fill(strings.tasks.watchChecks, { total: String(total) }),
    ...(running > 0 ? [fill(strings.tasks.watchRunning, { count: String(running) })] : []),
    ...(failed > 0 ? [fill(strings.tasks.watchFailed, { count: String(failed) })] : []),
  ];
  if (seen.conflicting) parts.push(fill(strings.tasks.watchConflict, { base: seen.base }));
  if (seen.queue) parts.push(fill(strings.tasks.watchQueued, { position: String(seen.queue.position) }));
  return parts.join(' · ');
}
