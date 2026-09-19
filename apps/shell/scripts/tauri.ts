/** The Tauri CLI with what each platform's packaging needs: the host's maintained ELF tools on Linux, the core bundle overlay on Windows. */
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
// The Windows sidecar is the runtime plus a `core` directory (stage-sidecar.ts): a build that bundles names it too.
const args = process.argv.slice(2);
const bundleConfig = args.findIndex((arg) => arg.endsWith('tauri.bundle.conf.json'));
if (process.platform === 'win32' && bundleConfig !== -1) {
  args.splice(bundleConfig + 1, 0, '--config', 'src-tauri/tauri.bundle.windows.conf.json');
}
const child = Bun.spawn(['bun', 'run', '--cwd', resolve(import.meta.dir, '..'), 'tauri', ...args], {
  env, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit', windowsHide: true,
});
process.exit(await child.exited);
