/**
 * The Bun runtime a compiled core embeds when it is not the running Bun's own
 * build: the baseline one on x64, the other architecture in a cross build.
 *
 * `bun build --compile --target` fetches that runtime from npm itself, with no
 * deadline: a stalled download hung a launcher test past its 60 s timeout on a
 * Windows runner (2026-10-15), and would hold a release build until its job is
 * cancelled. Here it comes from the release of the running Bun on GitHub, read
 * with a deadline for each stretch without data and for the whole download,
 * checked against that release's SHASUMS256.txt, and kept under
 * `node_modules/.cache/boite-bun-runtime/<target>-v<version>`, the directory
 * `apps/shell/scripts/stage-sidecar.ts` keeps the Windows runtime in.
 * `compile.ts` passes it to `bun build --compile-executable-path`.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface RuntimeOptions {
  version?: string;
  cacheRoot?: string;
  /** Where the release files are: `<releases>/bun-v<version>/<file>`. */
  releases?: string;
  /** How long a download may go without receiving a byte. */
  stallMs?: number;
  /** How long one file may take in all. */
  totalMs?: number;
}

const REPO = join(import.meta.dir, '..', '..', '..');
export const RUNTIME_CACHE = join(REPO, 'node_modules', '.cache', 'boite-bun-runtime');
const RELEASES = 'https://github.com/oven-sh/bun/releases/download';
const STALL_MS = 30_000;
const TOTAL_MS = 300_000;

/** The release archive of a `bun build --target`: `bun-linux-arm64` ships as `bun-linux-aarch64.zip`. */
export function runtimeAsset(target: string): string {
  if (!/^bun-(linux|darwin|windows)-(x64|arm64)(-baseline)?$/.test(target)) throw new Error(`no Bun release archive is known for --target=${target}`);
  return target.replace('-arm64', '-aarch64');
}

/** The cached runtime for `target`, downloaded and checked first when it is missing. */
export async function bunRuntime(target: string, options: RuntimeOptions = {}): Promise<string> {
  const version = options.version ?? Bun.version;
  const asset = runtimeAsset(target);
  const exe = target.includes('-windows-') ? 'bun.exe' : 'bun';
  const dir = join(options.cacheRoot ?? RUNTIME_CACHE, `${target}-v${version}`);
  const cached = join(dir, exe);
  if (existsSync(cached)) return cached;

  const release = `${options.releases ?? RELEASES}/bun-v${version}`;
  const limits = { stallMs: options.stallMs ?? STALL_MS, totalMs: options.totalMs ?? TOTAL_MS };
  const sums = new TextDecoder().decode(await download(`${release}/SHASUMS256.txt`, limits));
  const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(([, file]) => file === `${asset}.zip`)?.[0];
  if (expected === undefined) throw new Error(`${release}/SHASUMS256.txt lists no ${asset}.zip`);
  const zip = await download(`${release}/${asset}.zip`, limits);
  const actual = new Bun.CryptoHasher('sha256').update(zip).digest('hex');
  if (actual !== expected) throw new Error(`${release}/${asset}.zip has SHA-256 ${actual}, SHASUMS256.txt says ${expected}`);

  // Unpacked beside the cache entry and renamed into it, so a cut run never counts as cached.
  const scratch = `${dir}.partial`;
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    const archive = join(scratch, `${asset}.zip`);
    await Bun.write(archive, zip);
    unzip(archive, scratch);
    const extracted = join(scratch, asset, exe);
    if (!existsSync(extracted)) throw new Error(`${asset}.zip has no ${asset}/${exe}`);
    if (process.platform !== 'win32') chmodSync(extracted, 0o755);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    renameSync(extracted, cached);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return cached;
}

/** A whole file, refused once `stallMs` pass with no byte or `totalMs` in all. */
async function download(url: string, { stallMs, totalMs }: { stallMs: number; totalMs: number }): Promise<Uint8Array> {
  const controller = new AbortController();
  const stop = (why: string) => controller.abort(new Error(why));
  const total = setTimeout(() => stop(`it took more than ${totalMs / 1000} s`), totalMs);
  let stall: ReturnType<typeof setTimeout> | undefined;
  const waiting = () => {
    clearTimeout(stall);
    stall = setTimeout(() => stop(`nothing arrived for ${stallMs / 1000} s`), stallMs);
  };
  waiting();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || response.body === null) throw new Error(`it answered ${response.status}`);
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    for (;;) {
      waiting();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    throw new Error(`could not download ${url}: ${reason instanceof Error ? reason.message : String(reason)}`);
  } finally {
    clearTimeout(total);
    clearTimeout(stall);
  }
}

function unzip(archive: string, into: string): void {
  // Windows' own bsdtar reads zip archives; a Git for Windows tar earlier on PATH does not.
  const command = process.platform === 'win32'
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), '-xf', archive, '-C', into]
    : ['unzip', '-q', '-o', archive, '-d', into];
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: 120_000 });
  if (result.exitCode !== 0) throw new Error(`${command[0]} could not unpack ${archive}: ${result.stderr.toString().slice(0, 500) || `exit ${result.exitCode}`}`);
}
