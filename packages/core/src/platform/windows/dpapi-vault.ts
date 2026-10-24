/**
 * Secret values under DPAPI: `CryptProtectData` encrypts with a key Windows
 * derives from the user's logon, so the blob files under the data directory
 * open only for this Windows user on this machine. The plaintext buffer
 * Windows hands back is zeroed before it is freed.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dlopen, FFIType, ptr, read, toArrayBuffer } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import type { SecretVault } from '../types.ts';

/** Never show a prompt: the core runs without anyone to answer one. */
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
/** `DATA_BLOB` on x64: a DWORD length, four bytes of padding, then the pointer. */
const BLOB_BYTES = 16;

type Symbols = ReturnType<typeof open>;

function open() {
  const crypt32 = dlopen('crypt32.dll', {
    CryptProtectData: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    CryptUnprotectData: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
  const kernel32 = dlopen('kernel32.dll', {
    LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
  });
  return { crypt32, kernel32 };
}

function blobOf(bytes: Uint8Array): Uint8Array {
  const blob = new Uint8Array(BLOB_BYTES);
  const view = new DataView(blob.buffer);
  view.setUint32(0, bytes.length, true);
  view.setBigUint64(8, BigInt(ptr(bytes)), true);
  return blob;
}

/** Copies the output blob into JS memory, zeroes Windows' copy and frees it. */
function takeOutput(symbols: Symbols, out: Uint8Array): Uint8Array {
  const view = new DataView(out.buffer);
  const length = view.getUint32(0, true);
  const address = Number(view.getBigUint64(8, true)) as Pointer;
  if (address === 0) return new Uint8Array(0);
  const native = new Uint8Array(toArrayBuffer(address, 0, length));
  const copy = native.slice();
  native.fill(0);
  // Read back one byte so the write above cannot be dropped as dead.
  if (length > 0) void read.u8(address, 0);
  symbols.kernel32.symbols.LocalFree(address);
  return copy;
}

/** Each blob is bound to its id: a file renamed onto another id does not open. */
function entropyOf(id: string): Uint8Array {
  return new TextEncoder().encode(`boite-secret:${id}`);
}

export class DpapiVault implements SecretVault {
  readonly kind = 'dpapi' as const;
  readonly persistent = true;
  #symbols: Symbols | null = null;

  constructor(private readonly dir: string) {}

  private symbols(): Symbols {
    this.#symbols ??= open();
    return this.#symbols;
  }

  private file(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(id)) throw new Error(`secret id: expected letters, digits, _ or -, got ${id.length} characters`);
    return join(this.dir, `${id}.bin`);
  }

  async put(id: string, value: Uint8Array): Promise<void> {
    const symbols = this.symbols();
    const input = blobOf(value);
    const entropyBytes = entropyOf(id);
    const entropy = blobOf(entropyBytes);
    const out = new Uint8Array(BLOB_BYTES);
    const ok = symbols.crypt32.symbols.CryptProtectData(ptr(input), null, ptr(entropy), null, null, CRYPTPROTECT_UI_FORBIDDEN, ptr(out));
    void entropyBytes;
    if (ok === 0) throw new Error('DPAPI refused to protect the value (CryptProtectData failed)');
    const sealed = takeOutput(symbols, out);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(id), sealed, { mode: 0o600 });
  }

  async take(id: string): Promise<Uint8Array | null> {
    let sealed: Uint8Array;
    try { sealed = readFileSync(this.file(id)); } catch { return null; }
    if (sealed.length === 0) return null;
    const symbols = this.symbols();
    const input = blobOf(sealed);
    // Held in a variable until the call returns: the blob keeps only its address.
    const entropyBytes = entropyOf(id);
    const entropy = blobOf(entropyBytes);
    const out = new Uint8Array(BLOB_BYTES);
    const ok = symbols.crypt32.symbols.CryptUnprotectData(ptr(input), null, ptr(entropy), null, null, CRYPTPROTECT_UI_FORBIDDEN, ptr(out));
    void entropyBytes;
    if (ok === 0) throw new Error('DPAPI refused to open the stored value (CryptUnprotectData failed): another Windows user, or a damaged file');
    return takeOutput(symbols, out);
  }

  async delete(id: string): Promise<void> {
    rmSync(this.file(id), { force: true });
  }

  async ids(): Promise<string[]> {
    try {
      return readdirSync(this.dir).filter(name => name.endsWith('.bin')).map(name => name.slice(0, -4));
    } catch {
      return [];
    }
  }
}
