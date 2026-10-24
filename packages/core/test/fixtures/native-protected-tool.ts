// An ordinary untrusted program. It has no knowledge of Boite's implementation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [outside, credential, inheritedFd, hostPid] = process.argv.slice(2);
if (process.platform === 'win32') {
  const {dlopen, FFIType, ptr} = await import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    GetCurrentProcess: {args: [], returns: FFIType.ptr},
    OpenProcess: {args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr},
    CloseHandle: {args: [FFIType.ptr], returns: FFIType.i32},
    ReadFile: {args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32},
  });
  const advapi = dlopen('advapi32.dll', {
    OpenProcessToken: {args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32},
    GetTokenInformation: {args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32},
  });
  const exposed: string[] = [];
  for (const path of [outside!, credential!, '.env', 'private.key', 'innocent.txt', 'outside-link', 'secret-link', 'hard-link', 'outside-junction/secret']) {
    try {if (readFileSync(path, 'utf8').includes('SYNTHETIC_PROTECTED')) exposed.push(path);} catch {}
  }
  const bytes = Buffer.alloc(256), used = Buffer.alloc(4);
  if (kernel.symbols.ReadFile(Number(inheritedFd), ptr(bytes), bytes.length, ptr(used), null) && bytes.includes('SYNTHETIC_PROTECTED')) exposed.push('inherited-handle');
  const host = kernel.symbols.OpenProcess(0x10 | 0x40, 0, Number(hostPid));
  const hostProcessDenied = !host;
  if (host) {exposed.push('host-process'); kernel.symbols.CloseHandle(host);}
  const heldToken = Buffer.alloc(8), state = Buffer.alloc(4), returned = Buffer.alloc(4);
  const opened = advapi.symbols.OpenProcessToken(kernel.symbols.GetCurrentProcess(), 8, ptr(heldToken));
  const handle = Number(heldToken.readBigUInt64LE());
  const lowbox = !!opened && !!advapi.symbols.GetTokenInformation(handle, 29, ptr(state), 4, ptr(returned)) && state.readUInt32LE() === 1;
  if (handle) kernel.symbols.CloseHandle(BigInt(handle));
  const child = spawnSync(process.execPath, ['-e', `try {console.log(require('fs').readFileSync(${JSON.stringify(outside)}, 'utf8'))} catch {}`], {encoding: 'utf8'});
  if (child.stdout?.includes('SYNTHETIC_PROTECTED')) exposed.push('child');
  if (Object.values(process.env).some(value => value?.includes('SYNTHETIC_PROTECTED'))) exposed.push('environment');
  writeFileSync('answer.js', readFileSync('answer.js', 'utf8').replace('return 41', 'return 42'));
  const build = spawnSync(process.execPath, ['build', 'answer.js', '--outdir', 'dist', '--target', 'bun'], {encoding: 'utf8'});
  const check = spawnSync(process.execPath, ['test', 'answer.test.js'], {encoding: 'utf8'});
  console.log(JSON.stringify({exposed, built: build.status === 0 && existsSync('dist/answer.js'), tested: check.status === 0, lowbox, hostProcessDenied}));
  if (build.status || check.status) console.error(build.stderr, check.stderr);
  kernel.close(); advapi.close();
} else {
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
}
