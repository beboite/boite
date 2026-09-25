import { requirePinnedBun } from '../../../scripts/ci/bun-version.ts';

// `bun build --compile` embeds the Bun it runs under, so it runs under this
// one, just checked, and not whichever `bun` comes first on PATH.
requirePinnedBun('the compiled core');
const suffix = process.platform === 'win32' ? '.exe' : '';
const result = Bun.spawnSync([process.execPath, 'build', '--compile', 'src/main.ts', '--outfile', `dist/boite-core${suffix}`], {
  stdout: 'inherit', stderr: 'inherit', windowsHide: true,
});
process.exit(result.exitCode);
