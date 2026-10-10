import type { ProviderInstall } from '@boite/contracts';

/** How long reading the publisher's version and manifest may take together. */
export const LATEST_TIMEOUT_MS = 15_000;
/** How old a publisher's answer may be before a provider list reads it again. */
export const LATEST_MAX_AGE_MS = 60 * 60 * 1000;
/** And before an install or a managed update does. */
export const INSTALL_LATEST_MAX_AGE_MS = 60 * 1000;
/** A manifest is a few kilobytes; anything far larger is not one. */
const MANIFEST_MAX_BYTES = 1024 * 1024;
/** A release version names a directory the installer deletes, so it is one plain path segment. */
export const PLAIN_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
export const SHA256_HEX = /^[a-fA-F0-9]{64}$/;

/** Newer, older or the same, reading the numbers first and a pre-release tag as older than none. */
export function compareVersions(a: string, b: string): number {
  const split = (value: string): { numbers: number[]; tag: string } => {
    const [core = '', ...rest] = value.split('-');
    return { numbers: core.split('.').map((part) => Number.parseInt(part, 10) || 0), tag: rest.join('-') };
  };
  const left = split(a), right = split(b);
  for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index += 1) {
    const delta = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (left.tag === right.tag) return 0;
  if (left.tag === '') return 1;
  if (right.tag === '') return -1;
  // beta.10 is after beta.2: a numeric part compares as a number.
  return left.tag.localeCompare(right.tag, 'en', { numeric: true }) < 0 ? -1 : 1;
}

/**
 * True when installing this block would fetch nothing new: it names what is
 * on disk, or, for a release that follows its publisher, an older one, the
 * pin it falls back to included. Such a release never goes back.
 */
export function upToDate(current: string | null, install: ProviderInstall): boolean {
  if (current === null) return false;
  return current === install.version || (install.latest !== undefined && compareVersions(current, install.version) > 0);
}

export type FetchText = (url: string, signal: AbortSignal) => Promise<string>;

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, redirect: 'follow' });
  // The manifest names the digest the download is checked against: a redirect off https would let anyone on the path name it.
  if (!response.url.startsWith('https://')) throw new Error(`${url} redirected to ${response.url}; a publisher stays on https`);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const tooBig = new Error(`${url} is more than ${MANIFEST_MAX_BYTES} bytes, larger than a release manifest`);
  if (Number(response.headers.get('content-length') ?? 0) > MANIFEST_MAX_BYTES) throw tooBig;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body?.getReader();
  for (let read = await reader?.read(); read !== undefined && !read.done; read = await reader?.read()) {
    bytes += read.value.byteLength;
    if (bytes > MANIFEST_MAX_BYTES) {
      void reader?.cancel().catch(() => {});
      throw tooBig;
    }
    chunks.push(read.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The release the publisher names as newest, as an install block the
 * installer takes like a pinned one: the manifest supplies the SHA-256 and the
 * size, so the download is checked exactly as before. The binary's name must
 * be the one the descriptor installs, since the executable candidates point at
 * it. A pinned block without `latest` comes back as it is.
 */
export async function resolveLatestInstall(
  install: ProviderInstall,
  read: FetchText = fetchText,
  timeoutMs = LATEST_TIMEOUT_MS,
): Promise<ProviderInstall> {
  const latest = install.latest;
  if (latest === undefined) return install;
  const signal = AbortSignal.timeout(timeoutMs);
  const version = (await read(latest.versionUrl, signal)).trim();
  if (!PLAIN_VERSION.test(version)) throw new Error(`${latest.versionUrl} named no plain version: ${JSON.stringify(version.slice(0, 80))}`);
  const manifestUrl = latest.manifest.split('{version}').join(version);
  let manifest: unknown;
  try {
    manifest = JSON.parse(await read(manifestUrl, signal));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${manifestUrl} is not JSON: ${error.message}`);
    throw error;
  }
  const record = manifest as { version?: unknown; platforms?: Record<string, unknown> } | null;
  if (typeof record !== 'object' || record === null) throw new Error(`${manifestUrl} is not a JSON object`);
  if (record.version !== undefined && record.version !== version) {
    throw new Error(`${manifestUrl} describes ${String(record.version)}, not ${version}`);
  }
  const binary = install.files[0];
  if (binary === undefined) throw new Error(`the install block of ${latest.versionUrl} names no file to install`);
  const entry = record.platforms?.[latest.platform] as { binary?: unknown; checksum?: unknown; size?: unknown } | undefined;
  if (typeof entry !== 'object' || entry === null) throw new Error(`${manifestUrl} has no ${latest.platform} entry`);
  if (entry.binary !== binary.path) {
    throw new Error(`${manifestUrl} names ${String(entry.binary)} for ${latest.platform}, expected ${binary.path}`);
  }
  if (typeof entry.checksum !== 'string' || !SHA256_HEX.test(entry.checksum)) {
    throw new Error(`${manifestUrl} carries no sha256 checksum for ${latest.platform}`);
  }
  if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
    throw new Error(`${manifestUrl} carries no positive size for ${latest.platform}`);
  }
  return {
    ...install,
    version,
    url: latest.url.split('{version}').join(version),
    sha256: entry.checksum.toLowerCase(),
    archiveBytes: entry.size,
    files: [{ ...binary, bytes: entry.size }],
  };
}
