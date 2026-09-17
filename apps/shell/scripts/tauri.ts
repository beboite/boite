/** Use the host's maintained ELF tools when packaging Linux sidecars. */
import { resolve } from 'node:path';
import { chmodSync } from 'node:fs';

const env = { ...process.env };
if (process.platform === 'linux') {
  const patchelf = env.PATCHELF || Bun.which('patchelf');
  if (!patchelf) throw new Error('Linux packaging requires patchelf on PATH');
  env.PATCHELF = patchelf;
  if (process.arch === 'arm64') {
    const wrapper = resolve(import.meta.dir, 'patchelf-sidecar.sh');
    chmodSync(wrapper, 0o755);
    env.BOITE_PATCHELF = patchelf;
    env.PATCHELF = wrapper;
  }
}
const child = Bun.spawn(['bun', 'run', '--cwd', resolve(import.meta.dir, '..'), 'tauri', ...process.argv.slice(2)], {
  env, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit', windowsHide: true,
});
process.exit(await child.exited);
