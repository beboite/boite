/**
 * The oldest browsers the UI runs on: Safari 15.4 (iOS 15.4) and Chromium 111
 * (docs/phone.md). The build target lowers syntax only, never a regex or a
 * method, so what those engines lack is refused here instead, on every chunk
 * the build writes (`vite.config.ts`) and on the sources (`browser-floor.test.ts`).
 *
 * A regex lookbehind is a parse error before Safari 16.4: one in a chunk the
 * page loads at start blanks the whole app. The copying array methods arrived
 * in Safari 16 and throw where they are called.
 */
const TOO_NEW: { pattern: RegExp; what: string }[] = [
  { pattern: /\(\?<[=!]/, what: 'a regex lookbehind (Safari 16.4)' },
  { pattern: /\.toSorted\(/, what: 'Array.prototype.toSorted (Safari 16)' },
  { pattern: /\.toReversed\(/, what: 'Array.prototype.toReversed (Safari 16)' },
  { pattern: /\.toSpliced\(/, what: 'Array.prototype.toSpliced (Safari 16)' }
];

/** What `code` uses that the browser floor lacks, one line per hit with its offset. */
export function tooNewForFloor(code: string): string[] {
  const hits: string[] = [];
  for (const { pattern, what } of TOO_NEW) {
    const global = new RegExp(pattern.source, 'g');
    for (const match of code.matchAll(global)) hits.push(`${what} at offset ${match.index}: ${code.slice(Math.max(0, match.index - 30), match.index + 30).replaceAll('\n', ' ')}`);
  }
  return hits;
}
