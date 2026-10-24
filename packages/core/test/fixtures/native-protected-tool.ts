// An ordinary untrusted program. It has no knowledge of Boite's implementation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [outside, credential, inheritedFd, hostPid] = process.argv.slice(2);
const reads = [outside!, credential!, '.env', 'private.key', 'innocent.txt', 'outside-link', 'secret-link', 'hard-link', `/proc/${hostPid}/root${outside}`, `/proc/${hostPid}/fd/${inheritedFd}`, `/proc/self/fd/${inheritedFd}`];
const exposed = reads.filter(path => {
  try { return readFileSync(path, 'utf8').includes('SYNTHETIC_PROTECTED'); } catch { return false; }
});
const child = spawnSync('/bin/sh', ['-c', 'cat "$1" .env secret-link hard-link 2>/dev/null', 'fixture', outside!], {encoding: 'utf8'});
if (child.stdout?.includes('SYNTHETIC_PROTECTED')) exposed.push('child');
if (Object.values(process.env).some(value => value?.includes('SYNTHETIC_PROTECTED'))) exposed.push('environment');
writeFileSync('answer.js', readFileSync('answer.js', 'utf8').replace('return 41', 'return 42'));
const build = spawnSync(process.execPath, ['build', 'answer.js', '--outdir', 'dist', '--target', 'bun'], {encoding: 'utf8'});
const check = spawnSync(process.execPath, ['test', 'answer.test.js'], {encoding: 'utf8'});
const nested = spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', 'true'], {encoding: 'utf8'});
const nestedNamespaceDenied = nested.status === 1 && nested.stderr.includes('Operation not permitted');
const unix = spawnSync('/usr/bin/python3', ['-c', 'import socket\ntry: socket.socket(socket.AF_UNIX); print(0)\nexcept OSError as error: print(error.errno)'], {encoding: 'utf8'});
const unixSocketDenied = unix.status === 0 && unix.stdout.trim() === '1';
console.log(JSON.stringify({exposed, built: build.status === 0 && existsSync('dist/answer.js'), tested: check.status === 0, nestedNamespaceDenied, unixSocketDenied}));
if (build.status || check.status) console.error(build.stderr, check.stderr);
