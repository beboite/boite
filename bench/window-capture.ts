/**
 * What a window picture costs through `bun:ffi`, against the least a helper
 * executable would cost per picture. Windows only. Measures the module's
 * import and load, the first capture (COM, factories and the D3D device
 * included), the median of `warm` captures through WGC and through PrintWindow,
 * the first and the following `frames().next()`, the RSS growth over `leak`
 * captures, and the median wall time of `Bun.spawn` of `cmd /c exit`.
 *
 * The window is the largest one not minimized whose process or title contains
 * `match`, or the largest of all. Nothing is focused, raised or restored.
 *
 *   bun bench/window-capture.ts [match=''] [warm=20] [leak=200]
 */
import type { NativeWindow } from '../packages/core/src/platform/types.ts';

if (process.platform !== 'win32') throw new Error('window-capture: Windows only');
const match = process.argv[2] ?? '';
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

const [backend, importMs] = await timed(() => import('../packages/core/src/platform/windows/window-capture.ts'));
const [loaded, loadMs] = await timed(() => backend.loadWindowCapture());
if ('unavailable' in loaded) throw new Error(loaded.unavailable);
const [windows, listMs] = await timed(() => loaded.list());
const target = windows
  .filter((window: NativeWindow) => !window.minimized && (match === '' || window.process.includes(match) || window.title.includes(match)))
  .sort((a: NativeWindow, b: NativeWindow) => b.width * b.height - a.width * a.height)[0];
if (target === undefined) throw new Error(`no window matches '${match}'`);

const [first, firstMs] = await timed(() => loaded.capture(target.id));
const captures: number[] = [];
for (let index = 0; index < warm; index += 1) captures.push((await timed(() => loaded.capture(target.id)))[1]);
const printed: number[] = [];
for (let index = 0; index < warm; index += 1) printed.push((await timed(() => backend.printWindow(target.id)))[1]);

const stream = loaded.frames(target.id);
const [, framesFirstMs] = await timed(() => stream.next());
const nexts: number[] = [];
for (let index = 0; index < warm; index += 1) nexts.push((await timed(() => stream.next()))[1]);
stream.close();

Bun.gc(true);
const rssBefore = process.memoryUsage().rss;
for (let index = 0; index < leak; index += 1) await loaded.capture(target.id);
Bun.gc(true);
const rssAfter = process.memoryUsage().rss;

const spawns: number[] = [];
for (let index = 0; index < warm; index += 1) {
  spawns.push((await timed(() => Bun.spawn(['cmd.exe', '/c', 'exit'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true }).exited))[1]);
}

console.log(`window: ${target.process} ${target.width}x${target.height}, first picture via ${first.via} ${first.width}x${first.height}`);
console.log(`import ${ms(importMs)}, load ${ms(loadMs)}, list ${ms(listMs)} (${windows.length} windows)`);
console.log(`first capture (cold) ${ms(firstMs)}`);
console.log(`capture median of ${warm}: ${ms(median(captures))}`);
console.log(`PrintWindow median of ${warm}: ${ms(median(printed))}`);
console.log(`frames: first next ${ms(framesFirstMs)}, next median of ${warm}: ${ms(median(nexts))}`);
console.log(`RSS over ${leak} captures: ${mb(rssBefore)} -> ${mb(rssAfter)} (${mb(rssAfter - rssBefore)})`);
console.log(`spawn of cmd /c exit, median of ${warm}: ${ms(median(spawns))}`);
