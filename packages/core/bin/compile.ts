/**
 * The compiled core: the Linux and macOS sidecar, and `dist/boite-core.exe` on
 * Windows, where the installer ships the signed runtime instead (stage-sidecar.ts).
 *
 * On x64 it embeds Bun's baseline runtime, which runs on CPUs without AVX2; the
 * default build stops with an illegal instruction there.
 */
const suffix = process.platform === 'win32' ? '.exe' : '';
const baseline: Record<string, string> = { win32: 'bun-windows-x64-baseline', linux: 'bun-linux-x64-baseline' };
const target = process.arch === 'x64' ? baseline[process.platform] : undefined;
const result = Bun.spawnSync([
  'bun', 'build', '--compile', ...(target ? [`--target=${target}`] : []),
  'src/main.ts', '--outfile', `dist/boite-core${suffix}`,
], {
  stdout: 'inherit', stderr: 'inherit', windowsHide: true,
});
process.exit(result.exitCode);
