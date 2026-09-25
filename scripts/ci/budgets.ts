/**
 * Size budgets for what the desktop job just built: the UI's entry chunk, the
 * whole UI without its precompressed copies, and the core bundle. Sizes are
 * deterministic for a commit, unlike timings on a shared runner, so they can
 * fail a pull request. Each limit in budgets.json sits about 10% above the
 * size measured when it was set; raise one in the same change that explains
 * the growth.
 *
 * Run: bun scripts/ci/budgets.ts (after build:ui and build:core)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Budgets {
  /** bytes */
  uiEntryChunk: number;
  uiDist: number;
  coreBundle: number;
}

const ROOT = join(import.meta.dir, '..', '..');

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/** The entry chunk is the one script index.html loads. */
export function entryChunk(indexHtml: string): string {
  const match = /<script[^>]+type="module"[^>]+src="(?:\.?\/)?([^"]+\.js)"/.exec(indexHtml);
  if (!match) throw new Error('packages/ui/dist/index.html: no module script, expected <script type="module" src="assets/index-*.js">');
  return match[1]!;
}

export function measure(root = ROOT): Budgets {
  const ui = join(root, 'packages', 'ui', 'dist');
  const core = join(root, 'packages', 'core', 'dist', 'main.js');
  for (const [path, build] of [[join(ui, 'index.html'), 'bun run build:ui'], [core, 'bun run build:core']] as const) {
    if (!existsSync(path)) throw new Error(`${path}: missing, run ${build} first`);
  }
  const chunk = entryChunk(readFileSync(join(ui, 'index.html'), 'utf8'));
  return {
    uiEntryChunk: statSync(join(ui, chunk)).size,
    uiDist: files(ui).filter((file) => !/\.(?:br|gz)$/.test(file)).reduce((sum, file) => sum + statSync(file).size, 0),
    coreBundle: statSync(core).size,
  };
}

export function overBudget(measured: Budgets, limits: Budgets): string[] {
  return (Object.keys(limits) as (keyof Budgets)[])
    .filter((key) => measured[key] > limits[key])
    .map((key) => `${key}: ${measured[key]} bytes, above its ${limits[key]}-byte budget in scripts/ci/budgets.json`);
}

if (import.meta.main) {
  const limits = JSON.parse(readFileSync(join(import.meta.dir, 'budgets.json'), 'utf8')) as Budgets;
  const measured = measure();
  for (const key of Object.keys(limits) as (keyof Budgets)[]) {
    const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
    console.log(`${key.padEnd(14)} ${kb(measured[key]).padStart(10)} of ${kb(limits[key])}`);
  }
  const errors = overBudget(measured, limits);
  if (errors.length) throw new Error(`Size budget exceeded:\n${errors.join('\n')}`);
}
