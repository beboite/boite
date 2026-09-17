const suffix = process.platform === 'win32' ? '.exe' : '';
const result = Bun.spawnSync(['bun', 'build', '--compile', 'src/main.ts', '--outfile', `dist/boite-core${suffix}`], {
  stdout: 'inherit', stderr: 'inherit', windowsHide: true,
});
process.exit(result.exitCode);
