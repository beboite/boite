// Read-only directory-name measurements, plus a synthetic build in the private checkout.
import {dlopen, FFIType, ptr} from 'bun:ffi';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

const kernel = dlopen('kernel32.dll', {
  GetCurrentDirectoryW: {args: [FFIType.u32, FFIType.ptr], returns: FFIType.u32},
  CreateFileW: {args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr},
  GetFinalPathNameByHandleW: {args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32},
  GetLastError: {args: [], returns: FFIType.u32},
  CloseHandle: {args: [FFIType.ptr], returns: FFIType.i32},
});
const wide = (text: string) => Buffer.from(`${text}\0`, 'utf16le');
const current = Buffer.alloc(65536), length = kernel.symbols.GetCurrentDirectoryW(current.length / 2, ptr(current));
const cwdError = length ? 0 : kernel.symbols.GetLastError();
const cwd = length && length < current.length / 2 ? current.toString('utf16le', 0, length * 2) : null;
const paths = ['.', ...(cwd ? [cwd] : []), join(process.env.SystemRoot!, 'System32')];
const observations = [];
for (const path of paths) for (const access of [0x100080, 0x100001]) {
  const name = wide(path), handle = kernel.symbols.CreateFileW(ptr(name), access, 7, null, 3, 0x02000000, null);
  const opened = !!handle && Number(handle) !== -1 && Number(handle) !== Number(0xffffffffffffffffn);
  const error = opened ? 0 : kernel.symbols.GetLastError();
  const names = [];
  if (opened) try {
    for (const flags of [0, 2, 4]) {
      const buffer = Buffer.alloc(65536), used = kernel.symbols.GetFinalPathNameByHandleW(handle, ptr(buffer), buffer.length / 2, flags);
      const error = used ? 0 : kernel.symbols.GetLastError();
      names.push({flags, used, error, path: used && used < buffer.length / 2 ? buffer.toString('utf16le', 0, used * 2) : null});
    }
  } finally {if (!kernel.symbols.CloseHandle(handle)) throw new Error('directory probe handle did not close');}
  observations.push({path, access, opened, error, names});
}
kernel.close();
const build = spawnSync(process.execPath, ['build', 'answer.js', '--outdir', 'volume-dist', '--target', 'bun'], {encoding: 'utf8'});
console.log(JSON.stringify({cwd, cwdError, systemRoot: process.env.SystemRoot, version: Bun.version, revision: Bun.revision,
  observations, build: {status: build.status, error: build.error?.message ?? null, stderr: build.stderr, output: existsSync('volume-dist/answer.js')}}));
