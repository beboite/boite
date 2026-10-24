/**
 * Secret values in the macOS Keychain and the Linux Secret Service, through
 * the system's own tools (`security`, `secret-tool`). The value goes in on
 * stdin, hex-encoded, and never in a command line a process listing shows.
 */
import type { SecretVault } from './types.ts';

const SERVICE = 'boite-secret';
const TOOL_TIMEOUT_MS = 15_000;
const HEX = new TextEncoder().encode('0123456789abcdef');

/** The hex text of `bytes`, as bytes the caller zeroes: no JS string holds it. */
export function hexBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length * 2);
  for (let index = 0; index < bytes.length; index += 1) {
    out[index * 2] = HEX[bytes[index]! >> 4]!;
    out[index * 2 + 1] = HEX[bytes[index]! & 15]!;
  }
  return out;
}

/** The bytes back from hex text, whitespace ignored; null when it is not hex. */
export function fromHexBytes(text: Uint8Array): Uint8Array | null {
  const digits: number[] = [];
  for (const byte of text) {
    if (byte === 10 || byte === 13 || byte === 32) continue;
    const value = byte >= 48 && byte <= 57 ? byte - 48 : byte >= 97 && byte <= 102 ? byte - 87 : byte >= 65 && byte <= 70 ? byte - 55 : -1;
    if (value < 0) { digits.fill(0); return null; }
    digits.push(value);
  }
  if (digits.length % 2 !== 0) { digits.fill(0); return null; }
  const out = new Uint8Array(digits.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = (digits[index * 2]! << 4) | digits[index * 2 + 1]!;
  digits.fill(0);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** One run of a system tool, killed by the pid this call holds when it hangs on a prompt. */
async function tool(cmd: string[], input: Uint8Array | null): Promise<{ code: number; stdout: Uint8Array }> {
  const child = Bun.spawn({ cmd, stdin: input === null ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => child.kill(), TOOL_TIMEOUT_MS);
  try {
    if (input !== null && child.stdin) {
      child.stdin.write(input);
      await child.stdin.end();
    }
    const [stdout, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
    return { code, stdout: new Uint8Array(stdout) };
  } finally {
    clearTimeout(timer);
  }
}

function checkId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(id)) throw new Error(`secret id: expected letters, digits, _ or -, got ${id.length} characters`);
  return id;
}

/** `security -i` reads its commands on stdin, so the value never shows in argv. */
export class KeychainVault implements SecretVault {
  readonly kind = 'keychain' as const;
  readonly persistent = true;

  async put(id: string, value: Uint8Array): Promise<void> {
    const hex = hexBytes(value);
    const line = concat([new TextEncoder().encode(`add-generic-password -U -a ${checkId(id)} -s ${SERVICE} -l "Boite secret" -w `), hex, new TextEncoder().encode('\n')]);
    hex.fill(0);
    try {
      const { code } = await tool(['security', '-i'], line);
      if (code !== 0) throw new Error(`the Keychain refused the value (security exited ${code})`);
    } finally {
      line.fill(0);
    }
  }

  async take(id: string): Promise<Uint8Array | null> {
    const { code, stdout } = await tool(['security', 'find-generic-password', '-a', checkId(id), '-s', SERVICE, '-w'], null);
    try {
      return code === 0 ? fromHexBytes(stdout) : null;
    } finally {
      stdout.fill(0);
    }
  }

  async delete(id: string): Promise<void> {
    await tool(['security', 'delete-generic-password', '-a', checkId(id), '-s', SERVICE], null);
  }
}

/** `secret-tool store` reads the value on stdin; `lookup` prints it on stdout. */
export class SecretServiceVault implements SecretVault {
  readonly kind = 'libsecret' as const;
  readonly persistent = true;

  async put(id: string, value: Uint8Array): Promise<void> {
    const hex = hexBytes(value);
    try {
      const { code } = await tool(['secret-tool', 'store', '--label=Boite secret', 'service', SERVICE, 'id', checkId(id)], hex);
      if (code !== 0) throw new Error(`the Secret Service refused the value (secret-tool exited ${code})`);
    } finally {
      hex.fill(0);
    }
  }

  async take(id: string): Promise<Uint8Array | null> {
    const { code, stdout } = await tool(['secret-tool', 'lookup', 'service', SERVICE, 'id', checkId(id)], null);
    try {
      return code === 0 && stdout.length > 0 ? fromHexBytes(stdout) : null;
    } finally {
      stdout.fill(0);
    }
  }

  async delete(id: string): Promise<void> {
    await tool(['secret-tool', 'clear', 'service', SERVICE, 'id', checkId(id)], null);
  }
}

/** A vault that stores, reads back and erases one probe value: the session may have no keyring unlocked. */
export async function answers(vault: SecretVault): Promise<boolean> {
  const id = `probe-${crypto.randomUUID()}`;
  const probe = crypto.getRandomValues(new Uint8Array(16));
  try {
    await vault.put(id, probe);
    const back = await vault.take(id);
    const same = back !== null && back.length === probe.length && back.every((byte, index) => byte === probe[index]);
    back?.fill(0);
    return same;
  } catch {
    return false;
  } finally {
    await vault.delete(id).catch(() => undefined);
  }
}
