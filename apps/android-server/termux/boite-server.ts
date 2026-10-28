/**
 * `boite-server`: the Boite core on an Android phone, inside Termux.
 *
 * install.sh puts Bun and this file in ~/.boite-server and a `boite-server`
 * command on Termux's PATH. Everything else comes from a signed release:
 * `update` downloads `boite-server_<version>_android.zip`, checks its Minisign
 * signature against the key the desktop updater trusts, unpacks it beside the
 * previous one and switches `current`. A supervisor started detached from
 * Termux keeps the core running and starts it again when it exits. The Boite
 * Server app drives these commands through Termux's RUN_COMMAND intent and
 * reads their `--json` answers. docs/android-server.md.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync,
  realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, writeSync,
} from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { posix } from 'node:path';

// Android paths, also when the tests run on Windows.
const { dirname, join } = posix;

export const REPOSITORY = 'mtsu-dev/boite';
/** Where a release's files may live; GitHub redirects the old owner's addresses (packages/core/src/server-update/release.ts). */
const OWNERS = [`https://github.com/${REPOSITORY}`, 'https://github.com/beboite/boite'];
/** `plugins.updater.pubkey` of apps/shell/src-tauri/tauri.conf.json; boite-server.test.ts keeps the two equal. */
export const UPDATE_PUBLIC_KEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEIxQUMwNkU2MzREQjRFMTUKUldRVlR0czA1Z2Fzc1JuNTArSldvdXVsRi9NbGNrTWQ5QUFxcmdOZXllRnBKL1djRFVwMFg3MS8K';
/** The updater manifest's key for this bundle (scripts/ci/updater-manifest.ts). */
export const TARGET = 'android-aarch64-server';
const CLAUDE_RELEASES = 'https://downloads.claude.ai/claude-code-releases';
/** What Claude Code's glibc build names as its ELF interpreter. */
export const GLIBC_INTERPRETER = '/lib/ld-linux-aarch64.so.1';
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
/** The core's restart handoff waits up to 30 s for running turns (docs/restart-handoff.md). */
const STOP_GRACE_MS = 60_000;
/** Seconds between restarts of a core that keeps exiting within a minute of starting. */
const BACKOFF_S = [1, 2, 5, 10, 30, 60];
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const KEPT_RELEASES = 2;

const PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
const HOME = process.env.HOME || '/data/data/com.termux/files/home';
/** Everything this server owns; `BOITE_SERVER_HOME` is for tests. */
export const ROOT = process.env.BOITE_SERVER_HOME || join(HOME, '.boite-server');
const at = (...parts: string[]) => join(ROOT, ...parts);
export const PATHS = {
  config: at('config.json'),
  state: at('server.json'),
  log: at('core.log'),
  current: at('current'),
  releases: at('releases'),
  runtime: at('runtime'),
  bin: at('bin'),
  cli: at('cli'),
  agents: at('agents'),
  data: at('data'),
  controller: at('boite-server.ts'),
  downloads: at('downloads'),
};

// ---------------------------------------------------------------------------
// Configuration

export type Channel = 'stable' | 'nightly';
/** `lan`: every interface, so the Wi-Fi and Tailscale addresses both answer. `tailscale`: the tailnet address alone. `local`: this phone only. */
export type HostMode = 'lan' | 'tailscale' | 'local';
/** `name`: what other machines call the phone, null for its maker and model (`deviceName`). */
export interface Config { channel: Channel; host: HostMode; port: number; autostart: boolean; name: string | null }
export const DEFAULT_CONFIG: Config = { channel: 'stable', host: 'lan', port: 7337, autostart: true, name: null };

const CHANNELS: Channel[] = ['stable', 'nightly'];
const HOSTS: HostMode[] = ['lan', 'tailscale', 'local'];

export function parseConfig(text: string, file = PATHS.config): Config {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error(`${file} must hold a JSON object`); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file} must hold a JSON object`);
  const config = { ...DEFAULT_CONFIG, ...(raw as Partial<Config>) };
  if (!CHANNELS.includes(config.channel)) throw new Error(`${file}: channel must be ${CHANNELS.join(' or ')}, got ${JSON.stringify(config.channel)}`);
  if (!HOSTS.includes(config.host)) throw new Error(`${file}: host must be ${HOSTS.join(', ')}, got ${JSON.stringify(config.host)}`);
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error(`${file}: port must be an integer from 1024 to 65535, got ${JSON.stringify(config.port)}`);
  if (typeof config.autostart !== 'boolean') throw new Error(`${file}: autostart must be true or false, got ${JSON.stringify(config.autostart)}`);
  const name = typeof config.name === 'string' ? config.name.trim() : config.name;
  if (name !== null && (typeof name !== 'string' || name.length > 100)) throw new Error(`${file}: name must be text of at most 100 characters, or null for the phone's own, got ${JSON.stringify(config.name)}`);
  return { channel: config.channel, host: config.host, port: config.port, autostart: config.autostart, name: name || null };
}

function readConfig(): Config {
  return existsSync(PATHS.config) ? parseConfig(readFileSync(PATHS.config, 'utf8')) : { ...DEFAULT_CONFIG };
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** `config <key> <value>`, the value spelled as a person types it. */
export function withSetting(config: Config, key: string, value: string): Config {
  switch (key) {
    case 'channel': return parseConfig(JSON.stringify({ ...config, channel: value }), 'channel');
    case 'host': return parseConfig(JSON.stringify({ ...config, host: value }), 'host');
    case 'port': return parseConfig(JSON.stringify({ ...config, port: /^\d+$/.test(value) ? Number(value) : value }), 'port');
    case 'autostart': {
      const on = ['on', 'true', 'yes', '1'].includes(value) ? true : ['off', 'false', 'no', '0'].includes(value) ? false : value;
      return parseConfig(JSON.stringify({ ...config, autostart: on }), 'autostart');
    }
    // An empty name gives the phone its maker and model back.
    case 'name': return parseConfig(JSON.stringify({ ...config, name: value }), 'name');
    default: throw new Error(`config key must be channel, host, port, autostart or name, got ${JSON.stringify(key)}`);
  }
}

/**
 * The phone's maker and model as Android reports them, `OnePlus GM1913`.
 * Every app's host name is `localhost`, and the name given to the phone in
 * its settings is out of Termux's reach.
 */
export function deviceName(read: (property: string) => string = getprop): string | null {
  const maker = read('ro.product.manufacturer').trim();
  const model = read('ro.product.model').trim();
  if (!model) return maker || null;
  return maker && !model.toLowerCase().startsWith(maker.toLowerCase()) ? `${maker} ${model}` : model;
}

function getprop(property: string): string {
  const result = spawnSync('getprop', [property], { encoding: 'utf8', timeout: 5_000 });
  return result.status === 0 ? result.stdout : '';
}

// ---------------------------------------------------------------------------
// Addresses

export type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

function ipv4(interfaces: Interfaces): { name: string; address: string }[] {
  return Object.entries(interfaces).flatMap(([name, entries]) => (entries ?? [])
    .filter((entry) => (entry.family === 'IPv4' || (entry.family as unknown) === 4) && !entry.internal && !entry.address.startsWith('169.254.'))
    .map((entry) => ({ name, address: entry.address })));
}

/**
 * The tailnet's IPv4 address, on Tailscale's VPN interface (`tun0` on Android).
 * Carriers number mobile data in the same 100.64.0.0/10, so the range alone
 * would take the phone's carrier address for its tailnet one.
 */
export function tailscaleAddress(interfaces: Interfaces = networkInterfaces()): string | null {
  return ipv4(interfaces).find(({ name, address }) => {
    const [a, b] = address.split('.').map(Number);
    return /^(tun|tailscale)\d*$/.test(name) && a === 100 && b! >= 64 && b! <= 127;
  })?.address ?? null;
}

/** The address the core binds; null while Tailscale is not connected. */
export function bindAddress(mode: HostMode, interfaces: Interfaces = networkInterfaces()): string | null {
  if (mode === 'local') return '127.0.0.1';
  if (mode === 'lan') return '0.0.0.0';
  return tailscaleAddress(interfaces);
}

/** The addresses another machine dials, Wi-Fi first: a phone's mobile data sits behind its carrier. */
export function reachableAt(mode: HostMode, port: number, interfaces: Interfaces = networkInterfaces()): string[] {
  const url = (address: string) => `http://${address}:${port}`;
  if (mode === 'local') return [url('127.0.0.1')];
  const tailnet = tailscaleAddress(interfaces);
  if (mode === 'tailscale') return tailnet ? [url(tailnet)] : [];
  const found = ipv4(interfaces).filter(({ name }) => !/^(r_)?rmnet|^ccmni|^v4-rmnet/.test(name));
  found.sort((a, b) => Number(!a.name.startsWith('wlan')) - Number(!b.name.startsWith('wlan')));
  return found.map(({ address }) => url(address));
}

/**
 * The core's pairing link on each address another device dials. The core
 * names one LAN address, which can be the carrier's on mobile data; the
 * grant itself is good on any of them.
 */
export function pairingLinks(url: string, reachable: string[]): string[] {
  const link = new URL(url);
  const links = reachable.map((origin) => `${origin}${link.pathname}${link.search}${link.hash}`);
  return links.length ? links : [url];
}

// ---------------------------------------------------------------------------
// Processes

/** Field 22 of /proc/<pid>/stat: when the process started, in clock ticks since boot. A reused PID has another. */
export function startTimeOf(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  return stat.slice(close + 2).split(' ')[19] ?? null;
}

function startedAt(pid: number): string | null {
  try { return startTimeOf(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return null; }
}

interface Recorded { pid: number; started: string }
interface CoreRecord extends Recorded { version: string; host: string; port: number; since: number }
interface ServerState { supervisor?: Recorded; core?: CoreRecord }

/** Only a PID this server recorded at spawn, still with the start time it had then. */
function alive(record: Recorded | undefined): record is Recorded {
  return record !== undefined && startedAt(record.pid) === record.started;
}

function readState(): ServerState {
  try { return JSON.parse(readFileSync(PATHS.state, 'utf8')) as ServerState; } catch { return {}; }
}

function record(pid: number): Recorded {
  const started = startedAt(pid);
  if (started === null) throw new Error(`process ${pid} left before it could be recorded`);
  return { pid, started };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Signals a recorded process; one that exited after `alive` saw it is already where the signal would put it. */
function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Termux's wake lock keeps the CPU and Wi-Fi up with the screen off, and its service in the foreground. */
function wakeLock(on: boolean): void {
  spawnSync(join(PREFIX, 'bin', on ? 'termux-wake-lock' : 'termux-wake-unlock'), [], { stdio: 'ignore', timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Releases

export interface Release { version: string; dir: string; bun: Runtime }
export interface Runtime { version: string; sha256: string }

export function parseRelease(text: string, file: string): { version: string; bun: Runtime } {
  const raw = JSON.parse(text) as { version?: unknown; bun?: { version?: unknown; sha256?: unknown } };
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) throw new Error(`${file}: version must be a semantic version`);
  const bun = raw.bun;
  if (!bun || typeof bun.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(bun.version) || typeof bun.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(bun.sha256)) {
    throw new Error(`${file}: bun must name a version and the sha256 of bun-linux-aarch64-android.zip`);
  }
  return { version: raw.version, bun: { version: bun.version, sha256: bun.sha256 } };
}

function readRelease(dir: string): Release {
  const file = join(dir, 'server-release.json');
  return { ...parseRelease(readFileSync(file, 'utf8'), file), dir };
}

function currentRelease(): Release | null {
  try { return readRelease(realpathSync(PATHS.current)); } catch { return null; }
}

/** Points `link` at `target` in one rename, so a reader never finds it missing. */
function relink(link: string, target: string): void {
  const temporary = `${link}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, link);
}

interface GithubRelease { tag_name?: unknown; draft?: unknown; assets?: { name?: unknown }[] }
export interface Offer { version: string; url: string; signature: string }

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

/** The newest release of the channel that carries the Android bundle: nightlies are the `-nightly.` tags, as for the desktop. */
export function pickRelease(releases: GithubRelease[], channel: Channel): string | null {
  const nightly = channel === 'nightly';
  const versions = releases
    .filter((release) => release.draft !== true && typeof release.tag_name === 'string' && release.tag_name.startsWith('v')
      && VERSION.test(release.tag_name.slice(1)) && release.tag_name.includes('-nightly.') === nightly)
    .filter((release) => release.assets?.some((asset) => asset.name === bundleName((release.tag_name as string).slice(1))))
    .map((release) => (release.tag_name as string).slice(1));
  versions.sort((a, b) => Bun.semver.order(b, a));
  return versions[0] ?? null;
}

export const bundleName = (version: string) => `boite-server_${version}_android.zip`;

/** The signed payload `latest.json` lists for this bundle, refused unless it is this release's own file. */
export function offerOf(manifest: unknown, version: string): Offer {
  const { version: listed, platforms } = (manifest ?? {}) as { version?: unknown; platforms?: Record<string, { url?: unknown; signature?: unknown }> };
  if (listed !== version) throw new Error(`latest.json of v${version} names version ${JSON.stringify(listed)}`);
  const payload = platforms?.[TARGET];
  const url = OWNERS.map((owner) => `${owner}/releases/download/v${version}/${bundleName(version)}`).find((expected) => payload?.url === expected);
  if (!url || typeof payload?.signature !== 'string' || payload.signature.length > 8192) {
    throw new Error(`latest.json of v${version} must list the signed ${bundleName(version)} under ${TARGET}`);
  }
  return { version, url, signature: payload.signature };
}

/** Release pages read before giving up: the nightlies can push a stable release past the first hundred. */
const RELEASE_PAGES = 10;

/**
 * `pickRelease` over GitHub's release list, newest first, one page of 100 after another until one matches.
 * Not `releases/latest`: a stable `-beta.` release is published as a prerelease (release.yml), which it never returns.
 */
export async function newestRelease(channel: Channel, page: (n: number) => Promise<unknown>): Promise<string | null> {
  for (let n = 1; n <= RELEASE_PAGES; n++) {
    const releases = await page(n);
    if (!Array.isArray(releases)) throw new Error('the GitHub release list is not an array');
    const version = pickRelease(releases, channel);
    if (version || releases.length < 100) return version;
  }
  return null;
}

async function findOffer(channel: Channel): Promise<Offer> {
  const version = await newestRelease(channel, (n) => fetchJson(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${n}`));
  if (!version) {
    throw new Error(channel === 'stable'
      ? 'no stable release carries the Android server yet: choose the nightly channel (boite-server config channel nightly)'
      : 'no nightly release carries the Android server yet');
  }
  return offerOf(await fetchJson(`https://github.com/${REPOSITORY}/releases/download/v${version}/latest.json`), version);
}

interface Minisign { prehashed: boolean; key: KeyObject; signed: Buffer; comment: string; global: Buffer }

/** Tauri's base64 Minisign packet, its trusted comment included (packages/core/src/server-update/release.ts). */
export function readSignature(signature: string, publicKey = UPDATE_PUBLIC_KEY): Minisign {
  const lines = Buffer.from(signature, 'base64').toString('utf8').trim().split('\n');
  const keyLines = Buffer.from(publicKey, 'base64').toString('utf8').trim().split('\n');
  const key = Buffer.from(keyLines[1] ?? '', 'base64');
  const packet = Buffer.from(lines[1] ?? '', 'base64');
  const comment = lines[2]?.replace(/^trusted comment: /, '');
  const global = Buffer.from(lines[3] ?? '', 'base64');
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed' || packet.length !== 74
    || !key.subarray(2, 10).equals(packet.subarray(2, 10)) || lines.length !== 4
    || !lines[2]?.startsWith('trusted comment: ') || comment === undefined || global.length !== 64) {
    throw new Error('the bundle signature is not a Minisign packet from the release key');
  }
  const algorithm = packet.subarray(0, 2).toString();
  if (algorithm !== 'ED' && algorithm !== 'Ed') throw new Error('the bundle signature must be Ed25519');
  const signingKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  return { prehashed: algorithm === 'ED', key: signingKey, signed: packet.subarray(10), comment, global };
}

/** `data` is the whole payload, or its BLAKE2b-512 digest for a prehashed packet. */
export function checkSignature(minisign: Minisign, data: Uint8Array): void {
  const { key, signed, comment, global } = minisign;
  if (!verify(null, data, key, signed) || !verify(null, Buffer.concat([signed, Buffer.from(comment)]), key, global)) {
    throw new Error('the bundle signature does not match: nothing was installed');
  }
}

export function verifyFile(file: string, signature: string, publicKey = UPDATE_PUBLIC_KEY): void {
  const minisign = readSignature(signature, publicKey);
  const bytes = readFileSync(file);
  checkSignature(minisign, minisign.prehashed ? createHash('blake2b512').update(bytes).digest() : bytes);
}

/** Streams `url` to `file` and returns its SHA-256; a transfer that stalls for two minutes fails. */
async function download(url: string, file: string, say: (line: string) => void): Promise<string> {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const stalled = new AbortController();
  let timer = setTimeout(() => stalled.abort(), 120_000);
  const response = await fetch(url, { signal: stalled.signal, headers: { 'accept-encoding': 'identity' } });
  if (!response.ok || !response.body) throw new Error(`${url} answered HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  const out = openSync(file, 'w', 0o600);
  let received = 0;
  let shown = 0;
  try {
    for await (const chunk of response.body) {
      clearTimeout(timer);
      timer = setTimeout(() => stalled.abort(), 120_000);
      hash.update(chunk);
      writeSync(out, chunk);
      received += chunk.length;
      if (total && received - shown > total / 10) {
        shown = received;
        say(`  ${Math.round((received / total) * 100)} % of ${(total / 1048576).toFixed(0)} MB`);
      }
    }
  } finally {
    clearTimeout(timer);
    closeSync(out);
  }
  if (total && received !== total) throw new Error(`${url} ended after ${received} of ${total} bytes`);
  return hash.digest('hex');
}

/** Entry names of a zip, refused when one would land outside its directory. */
export function checkEntries(names: string[]): void {
  for (const name of names) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => part === '..')) {
      throw new Error(`the bundle holds an unsafe path: ${name}`);
    }
  }
}

/** Why a command failed: its stderr, or, when it never started (no `unzip` on PATH), the spawn error. */
function failure(result: SpawnSyncReturns<string>): string {
  return result.stderr?.trim() || result.error?.message || `exit status ${result.status}`;
}

function unzip(file: string, directory: string): void {
  const listing = spawnSync('unzip', ['-Z1', file], { encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(`unzip could not read ${file}: ${failure(listing)}`);
  checkEntries(listing.stdout.split('\n').filter(Boolean));
  rmSync(directory, { recursive: true, force: true });
  const result = spawnSync('unzip', ['-q', file, '-d', directory], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`unzip failed on ${file}: ${failure(result)}`);
}

/** The Bun build for Android a release asks for, downloaded once and checked against the release's digest. */
async function ensureRuntime(bun: Runtime, say: (line: string) => void): Promise<string> {
  const dir = join(PATHS.runtime, `bun-${bun.version}`);
  const binary = join(dir, 'bun');
  if (!existsSync(binary)) {
    say(`Bun ${bun.version} for Android`);
    const zip = join(PATHS.downloads, `bun-${bun.version}.zip`);
    const digest = await download(`https://github.com/oven-sh/bun/releases/download/bun-v${bun.version}/bun-linux-aarch64-android.zip`, zip, say);
    if (digest !== bun.sha256) throw new Error(`bun-linux-aarch64-android.zip ${bun.version} hashes to ${digest}, the release expects ${bun.sha256}`);
    const staging = `${dir}.tmp`;
    unzip(zip, staging);
    chmodSync(join(staging, 'bun-linux-aarch64-android', 'bun'), 0o755);
    mkdirSync(dir, { recursive: true });
    renameSync(join(staging, 'bun-linux-aarch64-android', 'bun'), binary);
    rmSync(staging, { recursive: true, force: true });
    rmSync(zip, { force: true });
  }
  return binary;
}

export interface Prepared { staging: string; release: Release; runtime: string; controller: Uint8Array }

/** Downloads, checks and unpacks a release beside the running one, which keeps serving meanwhile. */
async function prepareRelease(source: { offer: Offer } | { bundle: string }, say: (line: string) => void): Promise<Prepared> {
  mkdirSync(PATHS.releases, { recursive: true, mode: 0o700 });
  let zip: string;
  if ('offer' in source) {
    zip = join(PATHS.downloads, bundleName(source.offer.version));
    say(`Boite ${source.offer.version}`);
    await download(source.offer.url, zip, say);
    verifyFile(zip, source.offer.signature);
  } else {
    // A bundle built by hand: the person who copied it into Termux vouches for it.
    zip = source.bundle;
    say(`Boite from ${zip} (local bundle, signature not checked)`);
  }
  const staging = join(PATHS.releases, `.staging-${process.pid}`);
  unzip(zip, staging);
  if ('offer' in source) rmSync(zip, { force: true });
  const release = readRelease(staging);
  if ('offer' in source && release.version !== source.offer.version) {
    throw new Error(`the signed bundle of v${source.offer.version} says it is ${release.version}`);
  }
  for (const required of ['core/main.js', 'ui/index.html', 'boite-server.ts']) {
    if (!existsSync(join(staging, required))) throw new Error(`the bundle of ${release.version} has no ${required}`);
  }
  return { staging, release, runtime: await ensureRuntime(release.bun, say), controller: readFileSync(join(staging, 'boite-server.ts')) };
}

/** Where the installed generation is selected: the release directories, `current`, the Bun link and this controller. */
export type Layout = Pick<typeof PATHS, 'releases' | 'current' | 'bin' | 'controller'>;
/** The changes an activation makes and undoes, so a test can fail any one of them. */
export const FILES = {
  rename: renameSync,
  link: relink,
  unlink: (file: string) => rmSync(file, { force: true }),
  write: (file: string, bytes: Uint8Array) => { writeFileSync(`${file}.tmp`, bytes); renameSync(`${file}.tmp`, file); },
};

const targetOf = (link: string) => { try { return readlinkSync(link); } catch { return null; } };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Moving a prepared release into place, as one transaction planned before the core stops: `apply` points `current`,
 * Bun and this controller at it, `rollback` puts each back exactly (a reinstall's replaced copy too), `commit` keeps it.
 */
export function planActivation({ staging, release, runtime, controller }: Prepared, layout: Layout = PATHS, files = FILES) {
  const dir = join(layout.releases, release.version);
  const aside = `${dir}.replaced-${randomUUID()}`;
  const bun = join(layout.bin, 'bun');
  const before = { bun: targetOf(bun), current: targetOf(layout.current), controller: existsSync(layout.controller) ? readFileSync(layout.controller) : null };
  const back = (link: string, target: string | null) => () => target === null ? files.unlink(link) : files.link(link, target);
  const undo: (() => void)[] = [];
  const step = (change: () => void, revert: () => void) => { change(); undo.push(revert); };
  const rollback = () => {
    const failed: string[] = [];
    for (const revert of undo.splice(0).reverse()) {
      try { revert(); } catch (error) { failed.push(messageOf(error)); }
    }
    if (failed.length) throw new Error(`the previous installation is only partly back: ${failed.join('; ')}`);
  };
  const apply = (): Release => {
    mkdirSync(layout.bin, { recursive: true, mode: 0o700 });
    // Reinstalling a version: the old copy steps aside until the new one has started.
    if (existsSync(dir)) step(() => files.rename(dir, aside), () => files.rename(aside, dir));
    step(() => files.rename(staging, dir), () => files.rename(dir, staging));
    step(() => files.link(bun, runtime), back(bun, before.bun));
    step(() => files.link(layout.current, dir), back(layout.current, before.current));
    // The controller comes with the release it runs.
    const previous = before.controller;
    step(() => files.write(layout.controller, controller), () => previous === null ? files.unlink(layout.controller) : files.write(layout.controller, previous));
    return readRelease(dir);
  };
  return { apply, rollback, commit: () => { undo.length = 0; rmSync(aside, { recursive: true, force: true }); } };
}

/** Keeps the current release and the one before it, for `rollback`. */
function pruneReleases(keep: string[]): void {
  const entries = readdirSync(PATHS.releases, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  // What an interrupted update left behind.
  for (const entry of entries) {
    if (entry.name.startsWith('.staging-') || entry.name.includes('.replaced-')) rmSync(join(PATHS.releases, entry.name), { recursive: true, force: true });
  }
  const older = entries
    .filter((entry) => VERSION.test(entry.name) && !keep.includes(join(PATHS.releases, entry.name)))
    .map((entry) => entry.name)
    .sort((a, b) => Bun.semver.order(b, a));
  for (const name of older.slice(Math.max(0, KEPT_RELEASES - keep.length))) rmSync(join(PATHS.releases, name), { recursive: true, force: true });
  const kept = new Set([...keep, ...older.slice(0, Math.max(0, KEPT_RELEASES - keep.length)).map((name) => join(PATHS.releases, name))]);
  const used = [...kept].map((dir) => { try { return `bun-${readRelease(dir).bun.version}`; } catch { return ''; } });
  for (const entry of readdirSync(PATHS.runtime, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('bun-') && !used.includes(entry.name)) {
      rmSync(join(PATHS.runtime, entry.name), { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Claude Code

/**
 * Claude Code ships no Android build. Its glibc build runs once its ELF
 * interpreter names the glibc loader Termux's glibc-runner installs. That
 * path must fit in the 26 bytes the original takes, so a link beside the app's
 * data directory, `/data/data/com.termux/ld`, stands in for it.
 */
export function loaderLink(prefix = PREFIX): string {
  return join(dirname(dirname(prefix)), 'ld');
}

/** Rewrites PT_INTERP in place; the program headers and every offset stay as they were. */
export function patchInterpreter(file: string, interpreter: string): 'patched' | 'already' {
  const fd = openSync(file, 'r+');
  try {
    const header = Buffer.alloc(64);
    readSync(fd, header, 0, 64, 0);
    if (header.readUInt32BE(0) !== 0x7f454c46 || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 183) {
      throw new Error(`${file} is not a 64-bit little-endian ARM ELF executable`);
    }
    const phoff = Number(header.readBigUInt64LE(32));
    const phentsize = header.readUInt16LE(54);
    const phnum = header.readUInt16LE(56);
    for (let index = 0; index < phnum; index += 1) {
      const entry = Buffer.alloc(phentsize);
      readSync(fd, entry, 0, phentsize, phoff + index * phentsize);
      if (entry.readUInt32LE(0) !== 3) continue;
      const offset = Number(entry.readBigUInt64LE(8));
      const size = Number(entry.readBigUInt64LE(32));
      const old = Buffer.alloc(size);
      readSync(fd, old, 0, size, offset);
      const named = old.toString('latin1').replace(/\0+$/, '');
      if (named === interpreter) return 'already';
      if (named !== GLIBC_INTERPRETER) throw new Error(`${file} names the interpreter ${named}, expected ${GLIBC_INTERPRETER}`);
      const next = Buffer.alloc(size);
      if (Buffer.byteLength(interpreter) >= size) throw new Error(`${interpreter} does not fit the ${size - 1} bytes of ${file}'s interpreter`);
      next.write(interpreter, 'latin1');
      writeSync(fd, next, 0, size, offset);
      return 'patched';
    }
    throw new Error(`${file} names no interpreter`);
  } finally {
    closeSync(fd);
  }
}

function withoutPreload(): NodeJS.ProcessEnv {
  const { LD_PRELOAD: _preload, ...rest } = process.env;
  return rest;
}

/** The installed Claude Code: `current` names the directory of the version that passed its `--version` check. */
function claudeVersion(): string | null {
  try {
    const version = readlinkSync(join(PATHS.agents, 'claude', 'current')).split('/').pop() ?? '';
    return VERSION.test(version) && existsSync(join(PATHS.agents, 'claude', version, 'claude')) ? version : null;
  } catch {
    return null;
  }
}

function codexVersion(): string | null {
  const result = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  return result.status === 0 ? (/\d+\.\d+\.\d+/.exec(result.stdout)?.[0] ?? null) : null;
}

/** An account's status as the core reports it (`AccountStatus`). */
export type SignIn = 'ok' | 'unknown' | 'error' | 'unauthenticated';
const SIGN_INS: SignIn[] = ['ok', 'unknown', 'error', 'unauthenticated'];

/**
 * Each provider's best account in `boite-core accounts --json`: one signed-in
 * account is enough for its agent to answer. A provider with no account at
 * all is absent, as signed out as can be.
 */
export function signIns(accounts: unknown): Record<string, SignIn> {
  if (!Array.isArray(accounts)) throw new Error('boite-core accounts gave no list');
  const best: Record<string, SignIn> = {};
  for (const account of accounts as { providerId?: unknown; status?: unknown }[]) {
    const status = SIGN_INS.find((known) => known === account?.status);
    if (typeof account?.providerId !== 'string' || !status) continue;
    const current = best[account.providerId];
    if (!current || SIGN_INS.indexOf(status) < SIGN_INS.indexOf(current)) best[account.providerId] = status;
  }
  return best;
}

/** What the running core says of its accounts; `refresh` adopts a CLI login made since it started. */
function coreSignIns(release: Release, refresh: boolean): Record<string, SignIn> {
  const result = spawnSync(join(PATHS.bin, 'bun'), [join(release.dir, 'core', 'main.js'), 'accounts', '--json', ...(refresh ? ['--refresh'] : [])], {
    // A refresh starts each agent once to ask it, seconds apiece on a slow phone.
    encoding: 'utf8', env: coreEnv(release), timeout: refresh ? 180_000 : 30_000,
  });
  if (result.status !== 0) throw new Error(failure(result).replace(/^boite-core accounts: /, ''));
  return signIns(JSON.parse(result.stdout));
}

/** The command each agent signs in with, run in a Termux terminal: both print a link to open. */
const SIGN_IN_COMMANDS: Record<string, { name: string; command: () => string[] }> = {
  claude: { name: 'Claude Code', command: () => [join(PATHS.bin, 'claude'), 'auth', 'login'] },
  codex: { name: 'Codex', command: () => ['codex', 'login', '--device-auth'] },
};

/**
 * `sign-in claude|codex`: the agent's own login, in the terminal the person
 * types in, into the login the core's default account reads. A running core
 * then reloads its providers to adopt it; a stopped one reads it at start.
 */
function signIn(args: Args, say: (line: string) => void): { ok: true; agent: string; signedIn: boolean | null } {
  const agent = args.positionals()[0] ?? '';
  const known = SIGN_IN_COMMANDS[agent];
  if (!known) throw new Error(`sign-in takes ${Object.keys(SIGN_IN_COMMANDS).join(' or ')}, got ${agent || 'nothing'}`);
  if ((agent === 'claude' ? claudeVersion() : codexVersion()) === null) {
    throw new Error(`${known.name} is not installed: ${agent === 'claude' ? 'boite-server agents' : 'pkg install codex'}`);
  }
  const [command, ...rest] = known.command();
  // With --json the agent's own lines go to stderr: stdout holds the one answer line.
  const login = spawnSync(command!, rest, { stdio: ['inherit', args.flag('--json') ? 2 : 'inherit', 'inherit'] });
  if (login.status !== 0) throw new Error(`${known.name}'s sign-in stopped: ${login.error?.message ?? `exit status ${login.status}`}`);
  const release = currentRelease();
  if (!release || !alive(readState().core)) return { ok: true, agent, signedIn: null };
  say('Telling Boite…');
  try {
    return { ok: true, agent, signedIn: coreSignIns(release, true)[agent] === 'ok' };
  } catch (error) {
    // The login went through all the same: the core reads it when it starts again.
    say(`Boite did not answer: ${messageOf(error)}`);
    return { ok: true, agent, signedIn: null };
  }
}

/** The latest Claude Code, checked against Anthropic's manifest as the core's own installer does. */
async function installClaude(say: (line: string) => void): Promise<{ version: string; changed: boolean }> {
  const loader = join(PREFIX, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
  if (!existsSync(loader)) throw new Error(`${loader} is missing: run pkg install glibc-repo, then pkg install glibc-runner`);
  const link = loaderLink();
  if (Buffer.byteLength(link) > GLIBC_INTERPRETER.length) throw new Error(`${link} is longer than the ${GLIBC_INTERPRETER.length} bytes Claude Code's interpreter path holds`);
  let linked = false;
  try { linked = realpathSync(link) === realpathSync(loader); } catch { /* Missing or dangling. */ }
  if (!linked) relink(link, loader);
  const response = await fetch(`${CLAUDE_RELEASES}/latest`, { signal: AbortSignal.timeout(30_000) });
  const version = (await response.text()).trim();
  if (!response.ok || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${CLAUDE_RELEASES}/latest gave no version`);
  const installed = claudeVersion();
  if (installed === version) {
    writeClaudeWrapper();
    return { version, changed: false };
  }
  const manifest = await fetchJson(`${CLAUDE_RELEASES}/${version}/manifest.json`) as { platforms?: Record<string, { checksum?: unknown; size?: unknown }> };
  const platform = manifest.platforms?.['linux-arm64'];
  if (typeof platform?.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(platform.checksum)) throw new Error(`the manifest of Claude Code ${version} has no linux-arm64 checksum`);
  say(`Claude Code ${version}`);
  const dir = join(PATHS.agents, 'claude', version);
  const part = join(dir, 'claude.part');
  const digest = await download(`${CLAUDE_RELEASES}/${version}/linux-arm64/claude`, part, say);
  if (digest !== platform.checksum) {
    rmSync(part, { force: true });
    throw new Error(`Claude Code ${version} hashes to ${digest}, its manifest says ${platform.checksum}`);
  }
  patchInterpreter(part, link);
  chmodSync(part, 0o755);
  const check = spawnSync(part, ['--version'], { encoding: 'utf8', env: withoutPreload(), timeout: 60_000 });
  if (check.status !== 0 || !check.stdout.includes(version)) {
    throw new Error(`Claude Code ${version} does not start on this phone: ${(check.stderr || check.stdout || String(check.error)).trim().slice(0, 400)}`);
  }
  renameSync(part, join(dir, 'claude'));
  relink(join(PATHS.agents, 'claude', 'current'), dir);
  writeClaudeWrapper();
  for (const entry of readdirSync(join(PATHS.agents, 'claude'))) {
    if (entry !== version && entry !== installed && entry !== 'current') rmSync(join(PATHS.agents, 'claude', entry), { recursive: true, force: true });
  }
  return { version, changed: true };
}

/**
 * Termux's exec hook is a Bionic library a glibc program cannot load, so the
 * wrapper drops LD_PRELOAD. Without the hook a `#!/usr/bin/env` script finds
 * no /usr on Android: the shell Claude Code runs its commands in is Termux's
 * bash with the hook loaded again. Claude Code's own updater would fetch an
 * unpatched binary: it stays off, and the core's `claude update` lands here.
 */
function writeClaudeWrapper(): void {
  mkdirSync(PATHS.bin, { recursive: true });
  const shell = join(ROOT, 'shell', 'bash');
  mkdirSync(dirname(shell), { recursive: true });
  writeFileSync(shell, [
    `#!${PREFIX}/bin/sh`,
    '# Written by boite-server: Termux\'s bash with its exec hook, for Claude Code\'s commands.',
    'if [ -n "${BOITE_TERMUX_PRELOAD:-}" ]; then export LD_PRELOAD="$BOITE_TERMUX_PRELOAD"; fi',
    'unset BOITE_TERMUX_PRELOAD',
    `exec "${PREFIX}/bin/bash" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const script = [
    `#!${PREFIX}/bin/sh`,
    '# Written by boite-server: Claude Code\'s glibc build, run through Termux\'s glibc loader.',
    `if [ "$#" -eq 1 ] && [ "$1" = update ]; then exec "${PREFIX}/bin/boite-server" claude-update; fi`,
    'if [ -n "${LD_PRELOAD:-}" ]; then export BOITE_TERMUX_PRELOAD="$LD_PRELOAD"; fi',
    'unset LD_PRELOAD',
    'export DISABLE_AUTOUPDATER=1',
    `export SHELL="${shell}" CLAUDE_CODE_SHELL="${shell}"`,
    `exec "${join(PATHS.agents, 'claude', 'current', 'claude')}" "$@"`,
    '',
  ].join('\n');
  writeFileSync(join(PATHS.bin, 'claude'), script, { mode: 0o755 });
}

/** The `boite` command agents run, and the one a Termux session finds on PATH. */
function writeCliShim(): void {
  mkdirSync(PATHS.cli, { recursive: true });
  const script = [
    `#!${PREFIX}/bin/sh`,
    '# Written by boite-server.',
    `export BOITE_DATA_DIR="\${BOITE_DATA_DIR:-${PATHS.data}}"`,
    `exec "${join(PATHS.bin, 'bun')}" "${join(PATHS.current, 'core', 'main.js')}" cli "$@"`,
    '',
  ].join('\n');
  writeFileSync(join(PATHS.cli, 'boite'), script, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// The core

export function coreEnv(release: Release, config = readConfig(), name = config.name ?? deviceName()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${PATHS.bin}:${PATHS.cli}:${process.env.PATH ?? `${PREFIX}/bin`}`,
    BOITE_DATA_DIR: PATHS.data,
    BOITE_UI_DIR: join(release.dir, 'ui'),
    BOITE_CLI_DIR: PATHS.cli,
    NODE_ENV: 'production',
  };
  // Without it the core takes the host name, `localhost` on every phone. One
  // exported in Termux's shell would outlast `config name ""`.
  if (name) env.BOITE_MACHINE_NAME = name;
  else delete env.BOITE_MACHINE_NAME;
  return env;
}

/** What `/health` at `url` answers, unread: `judgeCoreHealth` decides whose answer it is. */
async function health(url: string): Promise<unknown> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Null when a `/health` answer comes from the launched core (its PID, its release's version), else why not: another Boite may hold the port. */
export function judgeCoreHealth(expected: { pid: number; version: string }, answer: unknown): string | null {
  const body = answer !== null && typeof answer === 'object' ? answer as { ok?: unknown; pid?: unknown; version?: unknown } : null;
  if (body?.ok !== true) return 'no core answers';
  if (body.pid !== expected.pid) return `the answer comes from process ${JSON.stringify(body.pid)}, not the core started as ${expected.pid}`;
  if (body.version !== expected.version) return `the core answers as ${JSON.stringify(body.version)}, not ${expected.version}`;
  return null;
}

/** Null once the core `state` records answers as itself and still runs after the probe, else why not. */
export async function coreReadiness(core: CoreRecord | undefined, ask = health, running: (core: CoreRecord) => boolean = alive): Promise<string | null> {
  if (!core || !running(core)) return 'no core runs';
  const verdict = judgeCoreHealth(core, await ask(probeUrl(core.host, core.port)));
  return verdict ?? (running(core) ? null : `core ${core.pid} exited while it answered`);
}

/** The address this phone itself reaches the core on. */
function probeUrl(host: string, port: number): string {
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
}

function line(text: string): void {
  process.stdout.write(`${new Date().toISOString()} boite-server: ${text}\n`);
}

/** Runs the core and starts it again whenever it exits, until SIGTERM. Started detached by `start`. */
async function supervise(): Promise<void> {
  const state = readState();
  if (alive(state.supervisor) && state.supervisor.pid !== process.pid) {
    line(`supervisor ${state.supervisor.pid} already runs`);
    return;
  }
  const self = record(process.pid);
  writeJson(PATHS.state, { supervisor: self });
  let stopping = false;
  let child: ChildProcess | null = null;
  let wake: (() => void) | null = null;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    wake?.();
    const running = child;
    if (running && running.exitCode === null && running.signalCode === null) {
      running.kill('SIGTERM');
      setTimeout(() => { if (running.exitCode === null && running.signalCode === null) running.kill('SIGKILL'); }, STOP_GRACE_MS).unref();
    }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', () => {});
  let quick = 0;
  while (!stopping) {
    const launched = Date.now();
    try {
      const release = currentRelease();
      if (!release) throw new Error('no release is installed: run boite-server update');
      const config = readConfig();
      let host = bindAddress(config.host);
      while (host === null && !stopping) {
        line('waiting for Tailscale to connect');
        await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 15_000); });
        host = bindAddress(config.host);
      }
      if (stopping || host === null) break;
      rotateLog();
      const core = spawn(join(PATHS.bin, 'bun'), [join(release.dir, 'core', 'main.js'), '--host', host, '--port', String(config.port)], {
        cwd: HOME, env: coreEnv(release, config), stdio: ['ignore', 'inherit', 'inherit'],
      });
      child = core;
      const exited = new Promise<string>((resolve) => {
        core.once('error', (error) => resolve(error.message));
        core.once('exit', (code, signal) => resolve(signal ? `signal ${signal}` : `code ${code}`));
      });
      if (core.pid !== undefined) {
        try {
          writeJson(PATHS.state, { supervisor: self, core: { ...record(core.pid), version: release.version, host, port: config.port, since: launched } });
        } catch { /* It exited at once; `exited` says how. */ }
        line(`core ${release.version} started as ${core.pid} on ${host}:${config.port}`);
      }
      line(`core exited with ${await exited}`);
    } catch (error) {
      line(`core did not start: ${messageOf(error)}`);
    }
    child = null;
    writeJson(PATHS.state, { supervisor: self });
    if (stopping) break;
    quick = Date.now() - launched > 60_000 ? 0 : quick + 1;
    const delay = BACKOFF_S[Math.min(quick, BACKOFF_S.length - 1)]!;
    await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, delay * 1000); });
  }
  if (readState().supervisor?.pid === process.pid) writeJson(PATHS.state, {});
  line('stopped');
  process.exit(0);
}

/**
 * Moves a log past `max` bytes to `<log>.1`. Copied then emptied, not renamed: the supervisor and the core
 * keep writing through the append-mode descriptor `start` opened, which then writes at the new end.
 */
export function rotateLog(file = PATHS.log, max = MAX_LOG_BYTES): void {
  try {
    if (statSync(file).size <= max) return;
    copyFileSync(file, `${file}.1`);
    truncateSync(file, 0);
  } catch { /* No log yet. */ }
}

function tail(file: string, lines: number): string[] {
  try {
    const text = readFileSync(file, 'utf8');
    return text.split('\n').filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

/** Waits for the launched core to answer as itself; why not once `gone` says the supervisor has exited and none runs, or at the deadline. */
async function waitHealthy(timeoutMs: number, gone: () => boolean): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let reason = 'no core started';
  while (Date.now() < deadline) {
    const state = readState();
    if (alive(state.core)) {
      const verdict = await coreReadiness(state.core);
      if (verdict === null) return null;
      reason = verdict;
    } else if (gone() && !alive(state.supervisor)) {
      return reason;
    }
    await sleep(500);
  }
  return reason;
}

/** Starts the supervisor unless it runs, then waits for the core to answer unless `wait` is false. */
async function startServer(wait = true): Promise<void> {
  if (!currentRelease()) throw new Error('Boite is not installed: run boite-server update');
  writeCliShim();
  if (claudeVersion()) writeClaudeWrapper();
  // A supervisor that was already running is the one to watch; a new one records itself once started.
  let gone = () => true;
  if (!alive(readState().supervisor)) {
    wakeLock(true);
    mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const log = openSync(PATHS.log, 'a', 0o600);
    // Its own session: the supervisor outlives the Termux session or task that started it.
    const supervisor = spawn(join(PATHS.bin, 'bun'), [PATHS.controller, 'supervise'], { cwd: HOME, detached: true, stdio: ['ignore', log, log], env: process.env });
    closeSync(log);
    let exited = false;
    supervisor.once('exit', () => { exited = true; });
    supervisor.once('error', () => { exited = true; });
    supervisor.unref();
    gone = () => exited;
  }
  const reason = wait ? await waitHealthy(90_000, gone) : null;
  if (reason !== null) throw new Error(`the core did not answer within 90 s (${reason}); the end of ${PATHS.log}:\n${tail(PATHS.log, 15).join('\n')}`);
}

async function stopServer(): Promise<void> {
  const state = readState();
  // The supervisor stops its core; a core whose supervisor was killed is stopped directly.
  const first = alive(state.supervisor) ? state.supervisor : alive(state.core) ? state.core : null;
  if (first) {
    signal(first.pid, 'SIGTERM');
    const deadline = Date.now() + STOP_GRACE_MS + 15_000;
    while (Date.now() < deadline && (alive(state.supervisor) || alive(state.core))) await sleep(250);
    for (const left of [state.core, state.supervisor]) if (alive(left)) signal(left.pid, 'SIGKILL');
  }
  writeJson(PATHS.state, {});
  wakeLock(false);
}

// ---------------------------------------------------------------------------
// Commands

interface Status {
  ok: true;
  installed: boolean;
  version: string | null;
  running: boolean;
  healthy: boolean;
  channel: Channel;
  host: HostMode;
  port: number;
  autostart: boolean;
  /** What this phone dials, for the app's own checks. */
  probe: string | null;
  /** What another machine dials. */
  urls: string[];
  since: number | null;
  /** Absent when not checked: `codex --version` takes seconds on a slow phone. */
  claude?: string | null;
  codex?: string | null;
  /** Each provider's best account, checked with the versions; null when the core did not answer. */
  signIns?: Record<string, SignIn> | null;
}

async function status(agents = true): Promise<Status> {
  const config = readConfig();
  const release = currentRelease();
  const state = readState();
  const core = alive(state.core) ? state.core : null;
  const probe = core ? probeUrl(core.host, core.port) : null;
  const healthy = core !== null && await coreReadiness(core) === null;
  let accounts: Record<string, SignIn> | null = null;
  if (agents && healthy && release) {
    try { accounts = coreSignIns(release, false); } catch { /* Shown as not known. */ }
  }
  return {
    ok: true,
    installed: release !== null,
    version: release?.version ?? null,
    running: alive(state.supervisor) || core !== null,
    healthy,
    channel: config.channel,
    host: config.host,
    port: config.port,
    autostart: config.autostart,
    probe,
    urls: core ? reachableAt(config.host, core.port) : [],
    since: core?.since ?? null,
    ...(agents ? { claude: claudeVersion(), codex: codexVersion(), signIns: accounts } : {}),
  };
}

function describe(state: Status): string {
  const signedIn = Object.entries(state.signIns ?? {}).filter(([, status]) => status === 'ok').map(([provider]) => provider);
  const lines = [
    state.installed ? `Boite ${state.version}, ${state.channel} channel` : 'Boite is not installed',
    state.running ? (state.healthy ? 'running' : 'starting or not answering') : 'stopped',
    `listens: ${state.host}, port ${state.port}${state.autostart ? ', starts with the phone' : ''}`,
    ...state.urls.map((url) => `reach it at ${url}`),
    ...('claude' in state ? [`Claude Code: ${state.claude ?? 'not installed'}, Codex: ${state.codex ?? 'not installed'}`] : []),
    ...(state.signIns ? [signedIn.length ? `signed in: ${signedIn.join(', ')}` : 'no agent is signed in: boite-server sign-in claude, or codex'] : []),
  ];
  return lines.join('\n');
}

async function update(args: Args, say: (line: string) => void): Promise<Record<string, unknown>> {
  const config = readConfig();
  const before = currentRelease();
  const bundle = args.value('--bundle');
  let source: { offer: Offer } | { bundle: string };
  if (bundle) {
    source = { bundle };
  } else {
    const offer = await findOffer(config.channel);
    if (before?.version === offer.version && !args.flag('--force')) return { ok: true, version: offer.version, changed: false };
    if (args.flag('--check')) return { ok: true, version: before?.version ?? null, available: offer.version, changed: false };
    source = { offer };
  }
  const prepared = await prepareRelease(source, say);
  // Everything that can fail without touching what runs comes before the core stops.
  const activation = planActivation(prepared);
  writeCliShim();
  const wasRunning = alive(readState().supervisor) || alive(readState().core);
  if (wasRunning) await stopServer();
  let installed: Release | null = null;
  try {
    installed = activation.apply();
    if (wasRunning) await startServer();
  } catch (error) {
    const failed = `Boite ${prepared.release.version} ${installed ? 'did not start' : 'could not be installed'}`;
    const previous = before?.version ?? 'no installation';
    say(`${failed}, going back to ${previous}`);
    try {
      if (installed) await stopServer();
      activation.rollback();
      if (wasRunning) await startServer();
    } catch (recovery) {
      throw new Error(`${failed}, and going back to ${previous} failed: ${messageOf(recovery)}. ${messageOf(error)}`);
    }
    throw new Error(`${failed}; ${before ? `${previous} ${wasRunning ? 'runs' : 'is in place'} again` : 'nothing else was installed'}. ${messageOf(error)}`);
  }
  activation.commit();
  const previous = before && before.version !== installed.version ? before : null;
  pruneReleases([installed.dir, ...(previous ? [previous.dir] : [])]);
  return { ok: true, version: installed.version, previous: previous?.version ?? null, changed: true };
}

async function pair(args: Args): Promise<{ ok: true; url: string; urls: string[]; role: string; expiresAt: string | null }> {
  const release = currentRelease();
  if (!release) throw new Error('Boite is not installed');
  // As `boite-core pair`: a browser by default, `--owner` for a computer that drives this core.
  const role = args.flag('--owner') ? 'owner' : 'device';
  const result = spawnSync(join(PATHS.bin, 'bun'), [join(release.dir, 'core', 'main.js'), 'pair', ...(role === 'owner' ? ['--owner'] : [])], {
    encoding: 'utf8', env: coreEnv(release), timeout: 30_000,
  });
  const url = (result.stdout ?? '').trim();
  if (result.status !== 0 || !url) throw new Error((result.stderr || result.error?.message || 'the core gave no pairing link').trim().replace(/^boite-core pair: /, ''));
  const config = readConfig();
  const urls = pairingLinks(url, reachableAt(config.host, readState().core?.port ?? config.port));
  return { ok: true, url: urls[0]!, urls, role, expiresAt: /until (\S+)/.exec(result.stderr)?.[1] ?? null };
}

function uninstall(args: Args): Record<string, unknown> {
  // Removes the software; the journal in data/ stays unless --purge says otherwise.
  const keep = args.flag('--purge') ? [] : ['data'];
  for (const entry of existsSync(ROOT) ? readdirSync(ROOT) : []) if (!keep.includes(entry)) rmSync(join(ROOT, entry), { recursive: true, force: true });
  rmSync(join(PREFIX, 'bin', 'boite-server'), { force: true });
  const link = loaderLink();
  try { if (lstatSync(link).isSymbolicLink() && readlinkSync(link).startsWith(PREFIX)) rmSync(link); } catch { /* Never made. */ }
  return { ok: true, kept: keep.length ? PATHS.data : null };
}

class Args {
  constructor(readonly list: string[]) {}
  flag(name: string): boolean { return this.list.includes(name); }
  value(name: string): string | undefined {
    const index = this.list.indexOf(name);
    if (index < 0) return undefined;
    const value = this.list[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} expects a value`);
    return value;
  }
  positionals(): string[] {
    const out: string[] = [];
    for (let index = 0; index < this.list.length; index += 1) {
      const item = this.list[index]!;
      if (item === '--bundle' || item === '--channel') index += 1;
      else if (!item.startsWith('--')) out.push(item);
    }
    return out;
  }
}

const USAGE = `usage: boite-server <command> [--json]
  install [--channel stable|nightly] [--bundle <zip>] [--no-claude]
  start | stop | restart | status [--quick]
  pair [--owner]           a one-time link for a browser (or, with --owner, a computer that drives this server)
  update [--check] [--force] [--bundle <zip>]
  agents                   install or update Claude Code
  sign-in claude|codex     the agent's sign-in, typed in this terminal; Boite then uses it
  config [<key> <value>]   channel stable|nightly, host lan|tailscale|local, port <n>, autostart on|off, name <text> ("" for the phone's own)
  logs [<lines>]
  uninstall [--purge]      --purge also deletes the conversations in ${PATHS.data}`;

async function main(argv: string[]): Promise<void> {
  const [command = 'status', ...rest] = argv;
  const args = new Args(rest);
  const json = args.flag('--json');
  const say = (text: string) => { if (!json) process.stderr.write(`${text}\n`); };
  const answer = (value: Record<string, unknown>, text: string) => {
    process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${text}\n`);
  };
  switch (command) {
    case 'supervise':
      return supervise();
    case 'status': {
      // `--quick` leaves out the agents' versions, for the app's polling.
      const state = await status(!args.flag('--quick'));
      return answer({ ...state }, describe(state));
    }
    case 'start': {
      await startServer();
      const state = await status(false);
      return answer({ ...state }, describe(state));
    }
    case 'stop':
      await stopServer();
      return answer({ ...await status(false) }, 'stopped');
    case 'restart': {
      await stopServer();
      await startServer();
      const state = await status(false);
      return answer({ ...state }, describe(state));
    }
    case 'boot': {
      // Sent by the app once the phone has started. It does not wait: Tailscale may connect minutes later.
      if (!readConfig().autostart || !currentRelease()) return answer({ ok: true, started: false }, 'autostart is off');
      await startServer(false);
      return answer({ ok: true, started: true }, 'started');
    }
    case 'install': {
      const channel = args.value('--channel');
      const config = channel ? withSetting(readConfig(), 'channel', channel) : readConfig();
      writeJson(PATHS.config, config);
      const result = await update(new Args([...rest, '--force']), say);
      if (!args.flag('--no-claude')) await installClaude(say);
      // Started after the agents, so the core finds them on its first scan.
      await stopServer();
      await startServer();
      const state = await status();
      return answer({ ...state, changed: result.changed }, describe(state));
    }
    case 'update': {
      const result = await update(args, say);
      return answer(result, result.changed ? `Boite ${result.version} installed` : result.available ? `Boite ${result.available} is available` : `Boite ${result.version} is up to date`);
    }
    case 'agents':
    case 'claude-update': {
      const claude = await installClaude(say);
      return answer({ ok: true, claude: claude.version, changed: claude.changed }, claude.changed ? `Claude Code updated to ${claude.version}` : `Claude Code ${claude.version} is up to date`);
    }
    case 'pair': {
      const grant = await pair(args);
      return answer(grant, grant.url);
    }
    case 'sign-in': {
      const result = signIn(args, say);
      const name = SIGN_IN_COMMANDS[result.agent]!.name;
      return answer(result, result.signedIn === null ? `${name} is signed in; Boite reads it at its next start.`
        : result.signedIn ? `${name} is signed in. You can go back to Boite Server.`
          : `Boite still reads ${name} as signed out: see Settings, Providers in Boite.`);
    }
    case 'config': {
      const [key, value] = args.positionals();
      let config = readConfig();
      if (key !== undefined) {
        if (value === undefined) throw new Error(`config ${key} expects a value`);
        config = withSetting(config, key, value);
        writeJson(PATHS.config, config);
      }
      const shown = { ...config, name: config.name ?? `${deviceName() ?? 'localhost'} (the phone's own)` };
      return answer({ ok: true, ...config }, Object.entries(shown).map(([name, setting]) => `${name} ${setting}`).join('\n'));
    }
    case 'logs': {
      const count = Number(args.positionals()[0] ?? 80);
      const lines = tail(PATHS.log, Number.isInteger(count) && count > 0 ? count : 80);
      return answer({ ok: true, lines }, lines.join('\n'));
    }
    case 'uninstall':
      await stopServer();
      return answer(uninstall(args), args.flag('--purge') ? 'Boite server removed with its data' : `Boite server removed; the conversations stay in ${PATHS.data}`);
    case 'version':
      return answer({ ok: true, version: currentRelease()?.version ?? null }, currentRelease()?.version ?? 'not installed');
    case 'help':
    case '--help':
      return answer({ ok: true, usage: USAGE }, USAGE);
    default:
      throw new Error(`unknown command ${command}\n${USAGE}`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  main(argv).catch((error: unknown) => {
    const message = messageOf(error);
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    else process.stderr.write(`boite-server: ${message}\n`);
    process.exit(1);
  });
}
