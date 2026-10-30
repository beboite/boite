/**
 * What `boite window read` and `point` cost through `bun:ffi` on the core's
 * thread. Windows only. Measures the module's import and load, the first read
 * of a window's controls (COM and UI Automation's setup included), the median
 * of `warm` reads, the first box drawn and the median of `warm` moves of it,
 * and the RSS growth over `leak` reads.
 *
 * The window is the largest one not minimized whose process contains `match`,
 * or the taskbar when `match` is `taskbar`. Nothing is focused, raised or
 * restored; the box sits over the window's top-left corner for the run.
 *
 *   bun bench/window-guide.ts [match='taskbar'] [warm=20] [leak=200]
 */
import type { NativeWindow } from '../packages/core/src/platform/types.ts';

if (process.platform !== 'win32') throw new Error('window-guide: Windows only');
const match = process.argv[2] ?? 'taskbar';
const warm = Number(process.argv[3] ?? 20);
const leak = Number(process.argv[4] ?? 200);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

async function timed<T>(run: () => Promise<T> | T): Promise<[T, number]> {
  const start = performance.now();
  const value = await run();
  return [value, performance.now() - start];
}

const ms = (value: number) => `${value.toFixed(1)} ms`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const capture = await import('../packages/core/src/platform/windows/window-capture.ts');
const listing = await capture.loadWindowCapture();
if ('unavailable' in listing) throw new Error(listing.unavailable);
const [backend, importMs] = await timed(() => import('../packages/core/src/platform/windows/window-guide.ts'));
const [loaded, loadMs] = await timed(() => backend.loadWindowGuide());
if ('unavailable' in loaded) throw new Error(loaded.unavailable);
const target = (await listing.list())
  .filter((window: NativeWindow) => !window.minimized && (match === 'taskbar' ? window.className === 'Shell_TrayWnd' : window.process.toLowerCase().includes(match.toLowerCase())))
  .sort((a: NativeWindow, b: NativeWindow) => b.width * b.height - a.width * a.height)[0];
if (target === undefined) throw new Error(`no window matches '${match}'`);

const [first, firstMs] = await timed(() => loaded.controls(target.id, 2000));
const reads: number[] = [];
for (let index = 0; index < warm; index += 1) reads.push((await timed(() => loaded.controls(target.id, 2000)))[1]);

const frame = loaded.frame(target.id)!.rect;
const box = { left: frame.left + 8, top: frame.top + 8, width: 120, height: 32 };
const [drawn, drawMs] = await timed(() => loaded.point(box, 'Benchmark'));
const moves: number[] = [];
for (let index = 0; index < warm; index += 1) moves.push((await timed(() => drawn.move({ ...box, left: box.left + (index % 2) })))[1]);
drawn.close();

Bun.gc(true);
const rssBefore = process.memoryUsage().rss;
for (let index = 0; index < leak; index += 1) await loaded.controls(target.id, 2000);
Bun.gc(true);
const rssAfter = process.memoryUsage().rss;

console.log(`window: ${target.process} ${target.width}x${target.height}, ${first.total} controls`);
console.log(`import ${ms(importMs)}, load ${ms(loadMs)}`);
console.log(`first read ${ms(firstMs)}, later read (median of ${warm}) ${ms(median(reads))}`);
console.log(`first box ${ms(drawMs)}, move (median of ${warm}) ${ms(median(moves))}`);
console.log(`RSS over ${leak} reads: ${mb(rssAfter - rssBefore)}`);
