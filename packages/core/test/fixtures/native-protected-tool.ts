// An ordinary untrusted program. It has no knowledge of Boite's implementation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type {Pointer} from 'bun:ffi';

const [outside, credential, inheritedFd, hostPid, generationProbe] = process.argv.slice(2);
if (process.platform === 'win32') {
  const {dlopen, FFIType, ptr} = await import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    OpenProcess: {args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr},
    CloseHandle: {args: [FFIType.ptr], returns: FFIType.i32},
    CreateProcessW: {args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32},
    ResumeThread: {args: [FFIType.ptr], returns: FFIType.u32},
    TerminateProcess: {args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32},
    GetLastError: {args: [], returns: FFIType.u32},
    WaitForSingleObject: {args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32},
    GetExitCodeProcess: {args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32},
    CreateFileW: {args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr},
    CreateNamedPipeW: {args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr},
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
  const line = Buffer.from(`"${process.execPath}" -e "process.exit(0)"\0`, 'utf16le');
  const created = kernel.symbols.CreateProcessW(null, ptr(line), null, null, 0,
    0x01000000 | 0x08000000 | 4, null, null, ptr(startup), ptr(processInfo));
  const creationError = created ? 0 : kernel.symbols.GetLastError();
  let breakaway: {created: boolean; denied: boolean; pid: number; waited: boolean; exit: number | null; closed: boolean};
  if (!created) breakaway = {created: false, denied: creationError === 5, pid: 0, waited: false, exit: null, closed: true};
  else {
    const childHandle = Number(processInfo.readBigUInt64LE()) as Pointer, threadHandle = Number(processInfo.readBigUInt64LE(8)) as Pointer;
    const pid = processInfo.readUInt32LE(16), tid = processInfo.readUInt32LE(20);
    if (!childHandle || !threadHandle || !pid || !tid) throw new Error('Breakaway creation did not return its process/thread identity');
    // The broker checks this actual CREATE_PROCESS against its private job and
    // LPAC/package before continuing it. Keep the returned object handle until
    // it has exited normally, while this fixture root is still running.
    const resumed = kernel.symbols.ResumeThread(threadHandle) === 1;
    const waited = resumed && kernel.symbols.WaitForSingleObject(childHandle, 15000) === 0;
    const status = Buffer.alloc(4);
    const known = waited && !!kernel.symbols.GetExitCodeProcess(childHandle, ptr(status));
    if (!waited) {
      kernel.symbols.TerminateProcess(childHandle, 125);
      kernel.symbols.WaitForSingleObject(childHandle, 3000);
    }
    const threadClosed = !!kernel.symbols.CloseHandle(threadHandle), processClosed = !!kernel.symbols.CloseHandle(childHandle);
    breakaway = {created: true, denied: false, pid, waited, exit: known ? status.readUInt32LE() : null, closed: threadClosed && processClosed};
    if (!resumed || !waited || !known || breakaway.exit !== 0 || !breakaway.closed) throw new Error(`Breakaway lifetime incomplete: ${JSON.stringify(breakaway)}`);
  }
  // A descendant must retain LPAC, including exclusion of ambient application
  // package grants. The launcher's preflight checks only the first process.
  const child = spawnSync(process.execPath, ['-e', `const fs=require('fs'),p=require('path');
try {console.log(fs.readFileSync(${JSON.stringify(outside)}, 'utf8'))} catch {}
try {fs.readFileSync(p.join(p.dirname(p.dirname(process.execPath)),'ambient-probe'));console.log('ambient-readable')} catch {}
console.log('child-checked');`], {encoding: 'utf8'});
  if (child.status !== 0 || !child.stdout?.includes('child-checked')) {
    // Keep native failure evidence: libuv maps several distinct Win32 stages to
    // EPERM, so compare direct creation with inherited, ignored and piped stdio.
    for (const access of [1, 2, 8, 0xb]) {
      heldToken.fill(0);
      const allowed = advapi.symbols.OpenProcessToken(-1n, access, ptr(heldToken));
      const error = allowed ? 0 : kernel.symbols.GetLastError();
      console.error(JSON.stringify({probe: 'self-token', access, allowed, error}));
      const captured = Number(heldToken.readBigUInt64LE()) as Pointer;
      if (allowed) kernel.symbols.CloseHandle(captured);
    }
    const valid = (value: Pointer | bigint | null) => !!value && Number(value) !== Number(0xffffffffffffffffn);
    const nul = Buffer.from('NUL\0', 'utf16le');
    for (const access of [0x80000000, 0x40000000]) {
      const file = kernel.symbols.CreateFileW(ptr(nul), access, 3, null, 3, 0, null);
      console.error(JSON.stringify({probe: 'NUL', access, allowed: valid(file), error: valid(file) ? 0 : kernel.symbols.GetLastError()}));
      if (valid(file)) kernel.symbols.CloseHandle(file);
    }
    const pipeName = Buffer.from(`\\\\.\\pipe\\LOCAL\\boite-native-${process.pid}\0`, 'utf16le');
    const server = kernel.symbols.CreateNamedPipeW(ptr(pipeName), 3, 0, 1, 4096, 4096, 0, null);
    console.error(JSON.stringify({probe: 'pipe-create', allowed: valid(server), error: valid(server) ? 0 : kernel.symbols.GetLastError()}));
    if (valid(server)) {
      const client = kernel.symbols.CreateFileW(ptr(pipeName), 0xc0000000, 0, null, 3, 0, null);
      console.error(JSON.stringify({probe: 'pipe-open', allowed: valid(client), error: valid(client) ? 0 : kernel.symbols.GetLastError()}));
      if (valid(client)) kernel.symbols.CloseHandle(client);
      kernel.symbols.CloseHandle(server);
    }
    for (const stdio of ['inherit', 'ignore', 'pipe'] as const) {
      const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {stdio});
      console.error(JSON.stringify({probe: 'stdio', stdio, status: result.status, error: result.error?.message}));
    }
    const rawLine = Buffer.from(`"${process.execPath}" -e "process.exit(0)"\0`, 'utf16le');
    processInfo.fill(0);
    const created = kernel.symbols.CreateProcessW(null, ptr(rawLine), null, null, 0, 0x08000000, null, null, ptr(startup), ptr(processInfo));
    const creationError = kernel.symbols.GetLastError();
    let status: number | null = null;
    if (created) {
      const root = Number(processInfo.readBigUInt64LE()) as Pointer, thread = Number(processInfo.readBigUInt64LE(8)) as Pointer;
      if (kernel.symbols.WaitForSingleObject(root, 3000) !== 0) kernel.symbols.TerminateProcess(root, 125);
      const exit = Buffer.alloc(4); kernel.symbols.GetExitCodeProcess(root, ptr(exit)); status = exit.readUInt32LE();
      kernel.symbols.CloseHandle(thread); kernel.symbols.CloseHandle(root);
    }
    console.error(JSON.stringify({probe: 'CreateProcessW', created, creationError, status}));
    throw new Error(`Native child probe failed: ${child.error ?? child.stderr}`);
  }
  if (child.stdout?.includes('SYNTHETIC_PROTECTED')) exposed.push('child');
  if (child.stdout?.includes('ambient-readable')) exposed.push('child-ambient-grant');
  if (Object.values(process.env).some(value => value?.includes('SYNTHETIC_PROTECTED'))) exposed.push('environment');
  // More than the prototype's cumulative 32-process table, without concurrent
  // heavyweight runtimes. Every generation must finish before the next starts.
  let generations = 0;
  for (; generations < (generationProbe === 'grow-ledger' ? 40 : 0); generations++) {
    const next = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {encoding: 'utf8'});
    if (next.status !== 0) throw new Error(`Descendant generation ${generations}: ${next.error ?? next.stderr}`);
  }
  writeFileSync('answer.js', readFileSync('answer.js', 'utf8').replace('return 41', 'return 42'));
  const build = spawnSync(process.execPath, ['build', 'answer.js', '--outdir', 'dist', '--target', 'bun'], {encoding: 'utf8'});
  const check = spawnSync(process.execPath, ['test', 'answer.test.js'], {encoding: 'utf8'});
  console.log(JSON.stringify({exposed, built: build.status === 0 && existsSync('dist/answer.js'), tested: check.status === 0, lowbox, hostProcessDenied, breakaway, generations}));
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
