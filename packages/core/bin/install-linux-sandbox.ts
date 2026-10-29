/** Build the pinned userspace helper without installing packages or changing host policy. */
import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join} from 'node:path';
import {Bus} from '../src/bus.ts';
import {Journal} from '../src/journal.ts';
import {ProcRegistry} from '../src/procs.ts';

const version = '0.13.1';
const sha256 = '0e85c8702248b8dd64144f594147553650cdd0e4c951690345faace79c217c4d';
const [output, libcapPrefix] = process.argv.slice(2);
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || !output || !isAbsolute(output)) throw new Error('usage: bun packages/core/bin/install-linux-sandbox.ts /absolute/path/to/bwrap [libcap-development-prefix] (Linux x64/arm64)');
const scratch = mkdtempSync(join(tmpdir(), 'boite-build-bwrap-'));
const journal = new Journal(join(scratch, 'journal.db'));
const procs = new ProcRegistry(journal, new Bus());
async function run(command: string, args: string[], cwd = scratch): Promise<string> {
  const child = procs.spawnPiped('install-linux-sandbox', command, args, {cwd, env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}, agentRoot: false});
  child.proc.stdin.end();
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
  if (code) throw new Error(`${command}: helper build failed (${code}): ${stderr}`);
  return stdout.trim();
}
try {
  const response = await fetch(`https://github.com/containers/bubblewrap/releases/download/v${version}/bubblewrap-${version}.tar.xz`);
  if (!response.ok) throw new Error(`bubblewrap source: download returned ${response.status}`);
  const archive = new Uint8Array(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== sha256) throw new Error('bubblewrap source: SHA-256 differs from pinned upstream release');
  const tarball = join(scratch, 'source.tar.xz');
  writeFileSync(tarball, archive);
  await run('tar', ['-xJf', tarball, '-C', scratch]);
  const source = join(scratch, `bubblewrap-${version}`);
  // Equivalent to upstream's minimal Meson build, with optional SELinux integration disabled.
  writeFileSync(join(source, 'config.h'), `#define PACKAGE_STRING "bubblewrap ${version}"\n`);
  const cap = libcapPrefix ? [join(libcapPrefix, 'usr/lib', process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu', 'libcap.a')]: ['-lcap'];
  await run('cc', ['-O2', '-D_GNU_SOURCE', '-I.', ...(libcapPrefix ? [`-I${join(libcapPrefix, 'usr/include')}`] : []),
    'bubblewrap.c', 'bind-mount.c', 'network.c', 'utils.c', 'chroot_realpath.c', 'safe_openat.c', ...cap, '-o', 'bwrap'], source);
  const built = join(source, 'bwrap');
  const actual = await run(built, ['--version']);
  if (actual !== `bubblewrap ${version}`) throw new Error('bubblewrap build: expected the pinned version');
  mkdirSync(dirname(output), {recursive: true});
  copyFileSync(built, output);
  console.log(`${actual}; source SHA-256 verified; helper ${output}`);
} finally {
  await procs.killAll();
  await procs.close();
  journal.close();
  rmSync(scratch, {recursive: true, force: true});
}
