// An ordinary untrusted program. It has no knowledge of Boite's implementation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type {Pointer} from 'bun:ffi';

const [outside, credential, inheritedFd, hostPid] = process.argv.slice(2);
if (process.platform === 'win32') {
  const {dlopen, FFIType, ptr} = await import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    OpenProcess: {args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr},
    CloseHandle: {args: [FFIType.ptr], returns: FFIType.i32},
    CreateProcessW: {args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32},
    TerminateProcess: {args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32},
    GetLastError: {args: [], returns: FFIType.u32},
  });
  const advapi = dlopen('advapi32.dll', {
    OpenProcessToken: {args: [FFIType.i64, FFIType.u32, FFIType.ptr], returns: FFIType.i32},
    GetTokenInformation: {args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32},
  });
  const exposed: string[] = [];
  for (const path of [outside!, credential!, '.env', 'private.key', 'innocent.txt', 'outside-link', 'secret-link', 'hard-link', 'outside-junction/secret']) {
    try {if (readFileSync(path, 'utf8').includes('SYNTHETIC_PROTECTED')) exposed.push(path);} catch {}
  }
  const host = kernel.symbols.OpenProcess(0x10 | 0x40, 0, Number(hostPid));
  const hostProcessDenied = !host;
  if (host) {exposed.push('host-process'); kernel.symbols.CloseHandle(host);}
  const heldToken = Buffer.alloc(8), state = Buffer.alloc(4), returned = Buffer.alloc(4);
  const opened = advapi.symbols.OpenProcessToken(-1n, 8, ptr(heldToken));
  const handle = Number(heldToken.readBigUInt64LE()) as Pointer;
  const lowbox = !!opened && !!advapi.symbols.GetTokenInformation(handle, 29, ptr(state), 4, ptr(returned)) && state.readUInt32LE() === 1;
  if (handle) kernel.symbols.CloseHandle(handle);
  const startup = Buffer.alloc(104), processInfo = Buffer.alloc(24);
  startup.writeUInt32LE(104);
  const line = Buffer.from(`"${process.execPath}" -e "setInterval(()=>{},1000)"\0`, 'utf16le');
  const escaped = kernel.symbols.CreateProcessW(null, ptr(line), null, null, 0, 0x01000000 | 0x08000000, null, null, ptr(startup), ptr(processInfo));
  const breakawayDenied = !escaped && kernel.symbols.GetLastError() === 5;
  if (escaped) {
    const childHandle = Number(processInfo.readBigUInt64LE()) as Pointer, threadHandle = Number(processInfo.readBigUInt64LE(8)) as Pointer;
    kernel.symbols.TerminateProcess(childHandle, 125);
    kernel.symbols.CloseHandle(threadHandle); kernel.symbols.CloseHandle(childHandle);
  }
  const child = spawnSync(process.execPath, ['-e', `try {console.log(require('fs').readFileSync(${JSON.stringify(outside)}, 'utf8'))} catch {}`], {encoding: 'utf8'});
  if (child.stdout?.includes('SYNTHETIC_PROTECTED')) exposed.push('child');
  if (Object.values(process.env).some(value => value?.includes('SYNTHETIC_PROTECTED'))) exposed.push('environment');
  writeFileSync('answer.js', readFileSync('answer.js', 'utf8').replace('return 41', 'return 42'));
  const build = spawnSync(process.execPath, ['build', 'answer.js', '--outdir', 'dist', '--target', 'bun'], {encoding: 'utf8'});
  const check = spawnSync(process.execPath, ['test', 'answer.test.js'], {encoding: 'utf8'});
  console.log(JSON.stringify({exposed, built: build.status === 0 && existsSync('dist/answer.js'), tested: check.status === 0, lowbox, hostProcessDenied, breakawayDenied}));
  if (build.status !== 0 || check.status !== 0) console.error(build.error, build.stderr, check.error, check.stderr);
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
