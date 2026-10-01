import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Two costs a frame pays for as long as they are on screen, found the hard
 * way (docs/performance.md, "What a frame costs"): a backdrop blur is redrawn
 * whenever anything under it moves, so a window-wide one under a streaming
 * answer drew 11 fps instead of 58; and an endless animation of anything but
 * opacity or a transform repaints on every frame it runs.
 */

const SRC = resolve('src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.svelte') || entry.name.endsWith('.css') ? [path] : [];
  });
}

function styleOf(path: string): string {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.css')) return text;
  return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');
}

/** Every innermost rule body, `{ ... }` holding no other block. */
function blocks(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]!);
}

const relative = (path: string) => path.slice(SRC.length + 1).replaceAll('\\', '/');

/**
 * The floating surfaces allowed a backdrop blur, each a bounded box: the blur
 * costs its own area, measured at 60 fps under a streaming answer with the
 * CPU slowed four times.
 */
const BLURRED_SURFACES = new Set([
  'components/Composer.svelte',
  'components/ThreadActivity.svelte',
  'components/NotificationCard.svelte',
  'components/UndoToast.svelte',
  'components/HarnessUpdateNotices.svelte',
]);

test('a backdrop blur sits only on a bounded floating surface, never across the window', () => {
  const misplaced = sources(SRC).flatMap((path) => blocks(styleOf(path))
    .filter((body) => /backdrop-filter\s*:\s*(?!none)/.test(body))
    .filter((body) => !BLURRED_SURFACES.has(relative(path)) || /\binset\s*:\s*0\b/.test(body))
    .map(() => relative(path)));
  expect(misplaced).toEqual([]);
});

/** What the compositor moves without painting again. */
const COMPOSITED = new Set(['opacity', 'transform', 'translate', 'rotate', 'scale']);
/** Endless loops that repaint a box a few pixels wide, each for a stated reason. */
const PAINTED_LOOPS = new Map([
  // The running tool's one-line label; the sweep is a gradient clipped to its text.
  ['components/ToolGroup.svelte', new Set(['shimmer'])],
  // The single key cap waiting for a shortcut, only while it listens.
  ['components/KeyboardPage.svelte', new Set(['listen'])],
]);

function keyframes(css: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const match of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1;
    let at = match.index! + match[0].length;
    const start = at;
    while (depth > 0 && at < css.length) {
      if (css[at] === '{') depth += 1;
      else if (css[at] === '}') depth -= 1;
      at += 1;
    }
    const body = css.slice(start, at - 1);
    const properties = new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((property) => property[1]!));
    found.set(match[1]!, properties);
  }
  return found;
}

test('an endless animation moves only what the compositor moves, or is a stated exception', () => {
  const global = keyframes(readFileSync(join(SRC, 'app.css'), 'utf8'));
  const painted: string[] = [];
  for (const path of sources(SRC)) {
    const css = styleOf(path);
    const own = keyframes(css);
    for (const body of blocks(css)) {
      for (const declaration of body.matchAll(/animation\s*:\s*([^;]+)/g)) {
        const value = declaration[1]!;
        if (!/\binfinite\b/.test(value)) continue;
        const name = value.split(/[\s,]+/).find((word) => own.has(word) || global.has(word));
        if (name === undefined) continue;
        const properties = [...(own.get(name) ?? global.get(name)!)];
        if (properties.every((property) => COMPOSITED.has(property))) continue;
        if (PAINTED_LOOPS.get(relative(path))?.has(name)) continue;
        painted.push(`${relative(path)}: ${name} animates ${properties.filter((property) => !COMPOSITED.has(property)).join(', ')}`);
      }
    }
  }
  expect(painted).toEqual([]);
});

/**
 * A `:has()` is checked again whenever its subject's subtree changes. On the
 * app's outer containers that subtree is everything, so a streaming answer or
 * a scrolled list restyled the container on every node it mounted.
 */
test('no :has() takes the whole app for its subject', () => {
  const global = /(?:^|[\s,{}>+~])(?:html|body|#app|\.app|\.body)(?:[.#][\w-]+|\[[^\]]*\])*:has\(/m;
  const offending = sources(SRC).filter((path) => global.test(styleOf(path).replace(/\/\*[\s\S]*?\*\//g, ''))).map(relative);
  expect(offending).toEqual([]);
});

/**
 * The active prompt changes every few lines of a scroll, and the rail's bar for
 * it eased its width: a layout on every frame of every scroll, half of the
 * layouts a wheel up a long thread ran. A marker's bar eases a transform.
 */
test('the outline rail eases its prompt bars without laying the page out', () => {
  const css = styleOf(join(SRC, 'components/MessageOutline.svelte')).replace(/\/\*[\s\S]*?\*\//g, '');
  const bars = [...css.matchAll(/\.marker(?:\.active)?\s+i\s*\{([^{}]*)\}/g)].map((match) => match[1]!);
  expect(bars.length).toBeGreaterThan(1);
  for (const body of bars) {
    expect(body).not.toMatch(/(?:^|;)\s*width\s*:\s*calc/);
    expect(body).not.toMatch(/transition\s*:[^;]*\b(?:width|height|margin|padding)\b/);
  }
});
