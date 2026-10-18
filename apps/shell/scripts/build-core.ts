/**
 * The core build `stage-sidecar.ts` stages, the first half of `stage:core`.
 *
 * On Windows the sidecar is Bun's signed runtime running the bundle of
 * `build:core`, so compiling `dist/boite-core.exe` there only cost time and a
 * 100 MB write nothing read. Everywhere else the sidecar is that compiled core,
 * from `build:core:exe`, which runs `build:core` first. The benches that time
 * the compiled core on Windows still build it on request: `bun run build:core:exe`.
 */
import { resolve } from 'node:path';

const script = process.platform === 'win32' ? 'build:core' : 'build:core:exe';
const child = Bun.spawn([process.execPath, 'run', script], {
  cwd: resolve(import.meta.dir, '..', '..', '..'), stdout: 'inherit', stderr: 'inherit', stdin: 'inherit', windowsHide: true,
});
process.exit(await child.exited);
