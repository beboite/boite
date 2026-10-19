/**
 * The compiled core: the Linux and macOS sidecar, and `dist/boite-core.exe` on
 * Windows, where the installer ships the signed runtime instead (stage-sidecar.ts).
 * `build:linux` runs it with `--target=bun-linux-x64-baseline` and its own
 * `--outfile`, from any machine.
 *
 * On x64 it embeds Bun's baseline runtime, which runs on CPUs without AVX2; the
 * default build stops with an illegal instruction there. `--bytecode` needs ESM
 * output because the core has top-level awaits. Identifiers stay readable in
 * logged stacks: only whitespace and syntax are minified.
 */
import { bunTarget, shellTarget } from '../../../apps/shell/scripts/targets.ts';
import { requirePinnedBun } from '../../../scripts/ci/bun-version.ts';
import { bunRuntime } from './bun-runtime.ts';

/** A compile takes seconds; one past this is stuck, and says so before the job's own limit. */
const COMPILE_TIMEOUT_MS = 10 * 60_000;

// `bun build --compile` embeds the Bun it runs under, so it runs under this
// one, just checked, and not whichever `bun` comes first on PATH. A cross
// build (`BOITE_TARGET`, Intel macOS from Apple Silicon) embeds that same
// version's runtime for the other architecture.
requirePinnedBun('the compiled core');
const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const suffix = process.platform === 'win32' ? '.exe' : '';
const shell = shellTarget();
// A native build names a target only where it must pick the baseline runtime.
const target = option('target') ?? (shell.cross || (shell.arch === 'x64' && process.platform !== 'darwin') ? bunTarget(process.platform, shell.arch) : undefined);
// That runtime is fetched here, with deadlines and its checksum, and not by
// `bun build`, whose own download from npm has no deadline (bun-runtime.ts).
const runtime = target ? await bunRuntime(target).catch((error: unknown) => {
  console.error(`compile: the Bun runtime for ${target}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}) : undefined;
const result = Bun.spawnSync([
  process.execPath, 'build', '--compile', ...(target ? [`--target=${target}`, `--compile-executable-path=${runtime}`] : []),
  '--minify-whitespace', '--minify-syntax', '--bytecode', '--format=esm', '--env=BOITE_RELEASE_*',
  'src/compiled-main.ts', 'src/artifact-retention-worker.ts', 'src/platform/linux-tcp-worker.ts', '--outfile', option('outfile') ?? `dist/boite-core${suffix}`,
], {
  stdout: 'inherit', stderr: 'inherit', windowsHide: true, timeout: COMPILE_TIMEOUT_MS,
});
if (result.exitedDueToTimeout) console.error(`compile: bun build did not finish within ${COMPILE_TIMEOUT_MS / 60_000} minutes and was stopped`);
process.exit(result.exitCode ?? 1);
