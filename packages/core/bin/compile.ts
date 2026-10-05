/**
 * The compiled core: the Linux and macOS sidecar, and `dist/boite-core.exe` on
 * Windows, where the installer ships the signed runtime instead (stage-sidecar.ts).
 *
 * On x64 it embeds Bun's baseline runtime, which runs on CPUs without AVX2; the
 * default build stops with an illegal instruction there. `--bytecode` needs ESM
 * output because the core has top-level awaits. Identifiers stay readable in
 * logged stacks: only whitespace and syntax are minified.
 */
import { bunTarget, shellTarget } from '../../../apps/shell/scripts/targets.ts';
import { requirePinnedBun } from '../../../scripts/ci/bun-version.ts';

// `bun build --compile` embeds the Bun it runs under, so it runs under this
// one, just checked, and not whichever `bun` comes first on PATH. A cross
// build (`BOITE_TARGET`, Intel macOS from Apple Silicon) embeds that same
// version's runtime for the other architecture.
requirePinnedBun('the compiled core');
const suffix = process.platform === 'win32' ? '.exe' : '';
const shell = shellTarget();
// A native build names a target only where it must pick the baseline runtime.
const target = shell.cross || (shell.arch === 'x64' && process.platform !== 'darwin') ? bunTarget(process.platform, shell.arch) : undefined;
const result = Bun.spawnSync([
  process.execPath, 'build', '--compile', ...(target ? [`--target=${target}`] : []),
  '--minify-whitespace', '--minify-syntax', '--bytecode', '--format=esm', '--env=BOITE_RELEASE_*',
  'src/compiled-main.ts', 'src/artifact-retention-worker.ts', 'src/platform/linux-tcp-worker.ts', '--outfile', `dist/boite-core${suffix}`,
], {
  stdout: 'inherit', stderr: 'inherit', windowsHide: true,
});
process.exit(result.exitCode);
