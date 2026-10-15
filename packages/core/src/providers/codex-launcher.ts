import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { currentOs } from '../paths.ts';
import { Remembered } from './which.ts';

/** The platform package and target triple npm's Codex launcher picks on this machine. */
function platformTarget(): { pkg: string; triple: string } | null {
  const os = currentOs();
  const arch = process.arch;
  if (os === 'linux' && arch === 'x64') return { pkg: 'codex-linux-x64', triple: 'x86_64-unknown-linux-musl' };
  if (os === 'linux' && arch === 'arm64') return { pkg: 'codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' };
  if (os === 'macos' && arch === 'x64') return { pkg: 'codex-darwin-x64', triple: 'x86_64-apple-darwin' };
  if (os === 'macos' && arch === 'arm64') return { pkg: 'codex-darwin-arm64', triple: 'aarch64-apple-darwin' };
  return null;
}

function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function vendorBinary(found: string): string | null {
  if (currentOs() === 'windows' || basename(found) !== 'codex') return null;
  let real: string;
  try {
    real = realpathSync(found);
  } catch {
    return null;
  }
  // `<root>/@openai/codex/bin/codex.js`: the launcher itself, not a wrapper around it.
  if (basename(real) !== 'codex.js' || basename(dirname(real)) !== 'bin') return null;
  const packageDir = dirname(dirname(real));
  if (basename(packageDir) !== 'codex' || basename(dirname(packageDir)) !== '@openai') return null;
  const target = platformTarget();
  if (target === null) return null;
  const tail = ['vendor', target.triple, 'bin', 'codex'];
  for (const path of [
    // npm nests the platform package under the launcher's own; pnpm and Bun hoist it beside.
    join(packageDir, 'node_modules', '@openai', target.pkg, ...tail),
    join(dirname(packageDir), target.pkg, ...tail),
    join(packageDir, ...tail),
  ]) {
    if (executableFile(path)) return path;
  }
  return null;
}

const vendors = new Remembered<string | null>();

/**
 * The native Codex binary npm's `codex.js` launcher would start, when PATH
 * resolves `codex` to that launcher on Linux or macOS. The launcher is a Node
 * process that stays up beside every Codex process to forward signals (about
 * 50 MB of memory and 80 ms per start); Windows already runs the binary
 * directly. Null for anything else on PATH, a wrapper script included: it is
 * there for a reason of its own, so it keeps being run.
 */
export function codexBehindLauncher(found: string): string | null {
  return vendors.get(found, () => vendorBinary(found), (binary) => binary === null || executableFile(binary));
}

/** What npm's launcher tells the binary, kept for the updater as on Windows. */
export const CODEX_NPM_ENV: Record<string, string> = { CODEX_MANAGED_BY_NPM: '1' };
