/**
 * What waits on the user: the threads of every connected machine that ask a
 * question or finished unread. The document title and the installed app's
 * icon badge both show this count; the core counts the same way when a push
 * sets the badge with no window open (push.ts `badge`).
 */
interface AttentionThread { archived?: boolean; unread?: boolean; status?: string; openQuestions?: number }

export function attentionCount(stores: readonly { threads: readonly AttentionThread[] }[]): number {
  return stores.reduce((sum, owner) => sum + owner.threads.filter((t) => !t.archived && (t.unread || t.status === 'waiting' || (t.openQuestions ?? 0) > 0)).length, 0);
}

type BadgeNavigator = { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

/**
 * The icon badge of an installed app (iOS 16.4+ home-screen apps, Chromium
 * PWAs). Browsers without the Badging API, or that refuse it, keep no badge.
 */
export function syncAppBadge(count: number, nav: BadgeNavigator = navigator as BadgeNavigator): void {
  try {
    const done = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
    void done?.catch(() => {});
  } catch {
    // The API exists but throws (no permission, not installed): nothing to show.
  }
}
