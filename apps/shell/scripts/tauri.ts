/** Use the host's maintained ELF tools when packaging Linux sidecars. */
import { resolve } from 'node:path';

const env = { ...process.env };
if (process.platform === 'linux' && !env.PATCHELF) {
  const patchelf = Bun.which('patchelf');
  if (!patchelf) throw new Error('Linux packaging requires patchelf on PATH');
  env.PATCHELF = patchelf;
}
const child = Bun.spawn(['bun', 'run', '--cwd', resolve(import.meta.dir, '..'), 'tauri', ...process.argv.slice(2)], {
  env, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit', windowsHide: true,
});
process.exit(await child.exited);
