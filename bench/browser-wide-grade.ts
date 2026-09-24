import type { WidePredicate, WideTask } from './browser-wide-tasks.ts';

export interface WideObservation {
  url: string;
  title: string;
  text: string;
  controls: Record<string, { value?: string; checked?: boolean; expanded?: boolean }[]>;
}

function matchesUrl(raw: string, predicate: Extract<WidePredicate, { kind: 'url' | 'visited-url' }>, origin: string): boolean {
  try {
    const url = new URL(raw);
    return url.origin === origin && (!predicate.equals || url.href === predicate.equals)
      && (!predicate.pathname || url.pathname === predicate.pathname)
      && Object.entries(predicate.query ?? {}).every(([key, value]) => url.searchParams.get(key) === value);
  } catch { return false; }
}

/** The grader reads evidence after the plugin stops; none of its selectors reach Jev. */
export function gradeWide(task: WideTask, final: WideObservation, visited: string[], actions: number) {
  const origin = new URL(task.url).origin;
  const checks = task.grader.all.map(predicate => {
    if (predicate.kind === 'url') return matchesUrl(final.url, predicate, origin);
    if (predicate.kind === 'visited-url') return visited.some(url => matchesUrl(url, predicate, origin));
    if (predicate.kind === 'text') return final.text.includes(predicate.contains);
    if (predicate.kind !== 'control') return false;
    return (final.controls[predicate.selector] ?? []).some(control =>
      (predicate.value === undefined || control.value === predicate.value)
      && (predicate.checked === undefined || control.checked === predicate.checked)
      && (predicate.expanded === undefined || control.expanded === predicate.expanded));
  });
  let sameOrigin = false;
  try { sameOrigin = new URL(final.url).origin === new URL(task.url).origin; } catch {}
  return { checks, sameOrigin, acted: actions > 0, passed: checks.length > 0 && checks.every(Boolean) && sameOrigin && actions > 0 };
}
