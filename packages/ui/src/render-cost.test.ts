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
 * A loop on screen keeps the compositor drawing every frame at the monitor's
 * rate, whoever looks: sixteen working threads, a spinner on each row, cost a
 * GPU process near a core while Boite sat beside a game. Each one plays
 * `var(--loops)`, which `lib/at-rest.ts` pauses while the page is hidden or
 * another application is in front of its window.
 */
/**
 * Loops that play while seen whatever the user does, holding by their own
 * rule when not: a tour picture plays like a GIF, never stopped for
 * performance (.agents/DESIGN.md, 2026-10-16), and runs only while its scene
 * is on screen in a shown window.
 */
const SEEN_LOOPS = new Map([['components/OnboardingScene.svelte', new Set(['glow'])]]);

test('every endless animation pauses with the window at rest', () => {
  const css = readFileSync(join(SRC, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  expect(css).toMatch(/:root\s*\{\s*--loops\s*:\s*running\s*;\s*\}/);
  expect(css).toMatch(/:root\[data-at-rest\]\s*\{\s*--loops\s*:\s*paused\s*;\s*\}/);
  const running: string[] = [];
  for (const path of sources(SRC)) {
    for (const body of blocks(styleOf(path))) {
      for (const declaration of body.matchAll(/(?:^|[;\s])animation\s*:\s*([^;]+)/g)) {
        const value = declaration[1]!;
        if (SEEN_LOOPS.get(relative(path))?.has(value.trim().split(/\s+/)[0]!)) continue;
        if (/\binfinite\b/.test(value) && !/var\(--loops\)/.test(value)) running.push(`${relative(path)}: ${value.trim()}`);
      }
      // A play state forced to run would undo it; pausing one more stays allowed.
      if (/animation-play-state\s*:\s*running/.test(body)) running.push(`${relative(path)}: animation-play-state: running`);
    }
  }
  expect(running).toEqual([]);
});

/**
 * The loops on screen while agents work: a row of the list, the open thread's
 * tools, terminals and browser. Eased smoothly, each draws a frame on every
 * refresh of the monitor, and sixteen rows out of phase leave none idle.
 */
const WORKING_LOOPS = [
  'components/BrowserNav.svelte', 'components/BrowserSurface.svelte', 'components/Sidebar.svelte',
  'components/StatusMark.svelte', 'components/SurfaceSwitch.svelte', 'components/TerminalDrawer.svelte',
  'components/TerminalView.svelte', 'components/ThinkingPart.svelte', 'components/ThreadActivity.svelte',
  'components/ThreadLoading.svelte', 'components/ThreadState.svelte', 'components/ToolCard.svelte',
  'components/ToolGroup.svelte', 'components/TurnSummary.svelte',
];

/** Where each keyframe interval of `@keyframes name` starts and ends, as fractions of the loop. */
function intervals(css: string, name: string): number[] {
  const start = css.search(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
  if (start < 0) return [];
  let at = css.indexOf('{', start) + 1;
  for (let depth = 1; depth > 0 && at < css.length; at += 1) depth += css[at] === '{' ? 1 : css[at] === '}' ? -1 : 0;
  const body = css.slice(css.indexOf('{', start), at);
  const offsets = [...body.matchAll(/(?:^|[{},])\s*((?:from|to|[\d.]+%)(?:\s*,\s*(?:from|to|[\d.]+%))*)\s*\{/g)]
    .flatMap((match) => match[1]!.split(',').map((offset) => offset.trim()))
    .map((offset) => offset === 'from' ? 0 : offset === 'to' ? 1 : Number.parseFloat(offset) / 100);
  const sorted = [...new Set([0, 1, ...offsets])].sort((a, b) => a - b);
  return sorted.slice(1).map((end, index) => end - sorted[index]!);
}

/**
 * Each of them steps a whole number of 60ths of a second, in `steps()` or
 * down a `--loop-*` staircase of app.css, and `lib/loop-phase.ts` starts them
 * all on the same grid: together they draw 60 frames a second, not one a
 * refresh of a 144 Hz monitor.
 */
test('a loop on screen while agents work changes on the shared 60 Hz grid', () => {
  const app = readFileSync(join(SRC, 'app.css'), 'utf8');
  const stairs = new Map([...app.matchAll(/--loop-([\w-]+)-(\d+)\s*:\s*linear\(([^)]*)\)/g)].map((match) => [`${match[1]}-${match[2]}`, Number(match[2])]));
  for (const [token, steps] of stairs) {
    const points = app.match(new RegExp(`--loop-${token}\\s*:\\s*linear\\(([^)]*)\\)`))![1]!.split(',');
    expect(points.length, `--loop-${token}`).toBe(steps);
  }
  const off: string[] = [];
  for (const file of WORKING_LOOPS) {
    const css = styleOf(join(SRC, file));
    for (const body of blocks(css)) {
      for (const declaration of body.matchAll(/(?:^|[;\s])animation\s*:\s*([^;]+)/g)) {
        const value = declaration[1]!;
        if (!/\binfinite\b/.test(value)) continue;
        const duration = /(\d*\.?\d+)(m?s)\b/.exec(value);
        const seconds = duration ? Number(duration[1]) / (duration[2] === 'ms' ? 1000 : 1) : NaN;
        const name = value.trim().split(/\s+/)[0]!;
        const stepped = /steps\((\d+)/.exec(value);
        const stair = /var\(--loop-([\w-]+-\d+)\)/.exec(value);
        // A tick of the grid per step: steps() over the whole loop, a staircase over each keyframe interval.
        const ticks = stepped ? [seconds * 60 / Number(stepped[1])]
          : stair && stairs.has(stair[1]!) ? intervals(css.includes(`@keyframes ${name}`) ? css : app, name).map((part) => seconds * part * 60 / stairs.get(stair[1]!)!)
          : [];
        if (ticks.length === 0 || ticks.some((tick) => Math.abs(tick - Math.round(tick)) > 1e-6 || Math.round(tick) < 1)) off.push(`${file}: ${value.trim()}`);
      }
    }
  }
  expect(off).toEqual([]);
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

/**
 * A fold builds its body on the first open and keeps it, so the close can
 * animate. Closed, that body is styled and laid out on every layout of its row
 * unless it skips its content once the close has run. The transition belongs
 * to the closed state alone: on the open one it would hold the body hidden for
 * a frame.
 */
test('a closed fold skips its body once the close has run, and an open one shows it at once', () => {
  const css = readFileSync(join(SRC, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const closed = /@supports\s*\(transition-behavior:\s*allow-discrete\)\s*\{\s*\.disclosure-fold:not\(\.open\)\s*>\s*\*\s*\{([^{}]*)\}/.exec(css)?.[1] ?? '';
  expect(closed).toMatch(/content-visibility\s*:\s*hidden/);
  expect(closed).toMatch(/transition\s*:\s*content-visibility\s+var\(--dur-3\)\s+allow-discrete/);
});
