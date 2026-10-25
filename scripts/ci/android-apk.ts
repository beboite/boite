import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The nightly APK is a Trusted Web Activity: its whole UI comes from the page
 * it opens, so a rebuild from an unchanged `apps/android/` gives the same app with a new
 * version number. `reuse` finds the APK of the latest published release and
 * keeps it when nothing that goes into it moved: the wrapper's sources, the
 * host it trusts and the key that signed it. The file keeps its original name,
 * which is the version it carries.
 *
 * The app has its own version, apart from Boite's. `apps/android/VERSION`
 * holds MAJOR.MINOR, raised by hand; a rebuild takes the next patch of the
 * last published APK, or patch 0 when VERSION moved past it.
 */

export const ASSETLINKS = 'packages/ui/public/.well-known/assetlinks.json';
export const WRAPPER = 'apps/android';
export const VERSION_FILE = `${WRAPPER}/VERSION`;
/** `boite-android-1.2.3.apk`, named after the app's own version. */
const APP_APK = /^boite-android-(\d+)\.(\d+)\.(\d+)\.apk$/;
/** `boite-2.0.0-nightly.20261001.1.apk`, named after Boite's release before the app had a version. */
const OLD_APK = /^boite-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\.apk$/;

export interface AppVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Android keeps versionCode under 2100000000; three digits per part keep the order. */
const PART = 1000;

/** The MAJOR.MINOR of `apps/android/VERSION`, or of `file`. */
export function parseBase(text: string, file = VERSION_FILE): { major: number; minor: number } {
  const match = /^(\d+)\.(\d+)$/.exec(text.trim());
  if (!match) throw new Error(`${file} must hold MAJOR.MINOR such as 1.0, got '${text.trim()}'`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  // Codes under 1000000 were the commit count of main; a lower code is an
  // update every installed app refuses.
  if (major < 1 || major > 999) throw new Error(`${file}: MAJOR must be 1 to 999, got ${major}`);
  if (minor >= PART) throw new Error(`${file}: MINOR must be under ${PART}, got ${minor}`);
  return { major, minor };
}

/** The app version an APK's file name carries; null for the older names. */
export function apkVersion(name: string): AppVersion | null {
  const match = APP_APK.exec(name);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

export function apkName(version: AppVersion): string {
  return `boite-android-${formatVersion(version)}.apk`;
}

export function formatVersion({ major, minor, patch }: AppVersion): string {
  return `${major}.${minor}.${patch}`;
}

export function versionCode({ major, minor, patch }: AppVersion): number {
  if (minor >= PART || patch >= PART) {
    throw new Error(`${formatVersion({ major, minor, patch })}: MINOR and PATCH must stay under ${PART} to keep versionCode ordered`);
  }
  return major * PART * PART + minor * PART + patch;
}

/**
 * The version of a rebuilt APK. Same MAJOR.MINOR as the last published APK:
 * its patch plus one. VERSION raised, or no earlier app version: patch 0.
 */
export function nextVersion(base: { major: number; minor: number }, previous: AppVersion | null, file = VERSION_FILE): AppVersion {
  let next: AppVersion = { ...base, patch: 0 };
  if (previous) {
    if (previous.major === base.major && previous.minor === base.minor) {
      next = { ...base, patch: previous.patch + 1 };
    } else if (previous.major > base.major || (previous.major === base.major && previous.minor > base.minor)) {
      throw new Error(`${file} holds ${base.major}.${base.minor}, below the published ${formatVersion(previous)}: phones would refuse the update`);
    }
  }
  versionCode(next);
  return next;
}

export interface Release {
  tag_name: string;
  draft: boolean;
  assets: { name: string }[];
}

/**
 * What the release attaches: the reused APK under its original name, so its
 * version does not move, or a rebuild named after its next version.
 */
export function releaseApk(
  base: { major: number; minor: number },
  previous: string | null,
  reused: boolean,
): { name: string; version: AppVersion | null } {
  if (reused) {
    if (!previous) throw new Error('nothing to reuse without a previous APK');
    return { name: previous, version: apkVersion(previous) };
  }
  const version = nextVersion(base, previous ? apkVersion(previous) : null);
  return { name: apkName(version), version };
}

/** Newest first, as the releases API lists them; a draft is this run's own. */
export function previousApk(releases: Release[]): { tag: string; name: string } | null {
  for (const release of releases) {
    if (release.draft) continue;
    const asset = release.assets.find((candidate) => (APP_APK.test(candidate.name) || OLD_APK.test(candidate.name)) && !candidate.name.endsWith('-unsigned.apk'));
    if (asset) return { tag: release.tag_name, name: asset.name };
  }
  return null;
}

/** `aapt2 dump resources` prints the value on the line after the resource. */
export function apkHost(dump: string): string | null {
  const lines = dump.split('\n');
  const at = lines.findIndex((line) => line.trimEnd().endsWith(' string/hostName'));
  if (at < 0) return null;
  return /"([^"]*)"/.exec(lines[at + 1] ?? '')?.[1] ?? null;
}

export function digest(value: string): string {
  return value.replace(/[:\s]/g, '').toLowerCase();
}

/**
 * `Signer #1 certificate SHA-256 digest:` on build-tools 35, `V3.0 Signer:
 * certificate SHA-256 digest:` on 37. The first scheme printed is the one
 * every Android reads.
 */
export function signerDigest(printCerts: string): string | null {
  const match = /certificate SHA-256 digest:\s*([0-9a-fA-F:]+)/.exec(printCerts);
  return match ? digest(match[1]!) : null;
}

export function assetlinksDigest(json: string, packageName = 'com.boite.two'): string {
  const statements = JSON.parse(json) as { target?: { package_name?: string; sha256_cert_fingerprints?: string[] } }[];
  const target = statements.find((statement) => statement.target?.package_name === packageName)?.target;
  const fingerprint = target?.sha256_cert_fingerprints?.[0];
  if (!fingerprint) throw new Error(`${ASSETLINKS} names no certificate for ${packageName}`);
  return digest(fingerprint);
}

export function run(command: string[], quiet = false): { ok: boolean; out: string } {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: quiet ? 'pipe' : 'inherit' });
  return { ok: result.exitCode === 0, out: result.stdout.toString() };
}

export function buildTool(name: string): string {
  const home = process.env.ANDROID_HOME;
  if (!home) throw new Error('ANDROID_HOME is unset');
  const versions = readdirSync(join(home, 'build-tools')).sort((a, b) => Bun.semver.order(a, b));
  const newest = versions.at(-1);
  if (!newest) throw new Error(`no build-tools under ${home}`);
  return join(home, 'build-tools', newest, name);
}

/** The certificate an APK carries, refused unless it is the one assetlinks.json publishes. */
export function checkSigner(apk: string): string | null {
  const got = signerDigest(run([buildTool('apksigner'), 'verify', '--print-certs', apk]).out);
  const want = assetlinksDigest(readFileSync(ASSETLINKS, 'utf8'));
  if (got === want) return null;
  return `${apk} is signed with ${got ?? 'no certificate'} but ${ASSETLINKS} publishes ${want}: the app would open with an address bar`;
}

interface Decision {
  reuse: boolean;
  reason: string;
  /** The reused file's name. */
  name?: string;
  /** The version a rebuild carries. */
  version?: AppVersion;
}

function reuse(releasesFile: string, host: string, dir: string, base: { major: number; minor: number }): Decision {
  const previous = previousApk(JSON.parse(readFileSync(releasesFile, 'utf8')).flat());
  if (!previous) return { reuse: false, reason: 'no published release carries a signed APK yet', version: releaseApk(base, null, false).version! };
  const { tag, name } = previous;
  const build = (reason: string): Decision => ({ reuse: false, reason, version: releaseApk(base, name, false).version! });
  if (!run(['git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}`], true).ok) {
    return build(`the tag ${tag} of ${name} is not in this checkout`);
  }
  if (!run(['git', 'diff', '--quiet', tag, 'HEAD', '--', WRAPPER]).ok) {
    return build(`${WRAPPER} changed since ${tag}`);
  }
  if (!run(['gh', 'release', 'download', tag, '--pattern', name, '--dir', dir]).ok) {
    return build(`${name} could not be downloaded from ${tag}`);
  }
  const apk = join(dir, name);
  const built = apkHost(run([buildTool('aapt2'), 'dump', 'resources', apk]).out);
  if (built !== host) {
    Bun.spawnSync(['rm', '-f', apk]);
    return build(`${name} opens ${built ?? 'no host'}, this build opens ${host}`);
  }
  const signer = checkSigner(apk);
  if (signer) {
    Bun.spawnSync(['rm', '-f', apk]);
    return build(signer);
  }
  return { reuse: true, reason: `${WRAPPER}, host and key unchanged since ${tag}`, name };
}

function output(lines: string[]) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.map((line) => `${line}\n`).join(''));
}

function versionOutput(version: AppVersion): string[] {
  return [`version=${formatVersion(version)}`, `code=${versionCode(version)}`];
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const base = () => parseBase(readFileSync(VERSION_FILE, 'utf8'));
  if (command === 'version') {
    // A build that publishes nothing: no earlier APK to count from.
    const version = nextVersion(base(), null);
    console.log(`app version ${formatVersion(version)}, code ${versionCode(version)}`);
    output(versionOutput(version));
  } else if (command === 'reuse') {
    const [releases, dir] = args;
    const host = process.env.ANDROID_HOST ?? '';
    if (!releases || !dir || !host) throw new Error('usage: ANDROID_HOST=<host> android-apk.ts reuse <releases.json> <dir>');
    const decision = reuse(releases, host, dir, base());
    if (decision.reuse) {
      console.log(`reusing ${decision.name}: ${decision.reason}`);
      output(['reuse=true']);
    } else {
      const version = decision.version!;
      console.log(`building ${apkName(version)}: ${decision.reason}`);
      output(['reuse=false', ...versionOutput(version)]);
    }
  } else if (command === 'verify') {
    const [apk] = args;
    if (!apk) throw new Error('usage: android-apk.ts verify <apk>');
    const problem = checkSigner(apk);
    if (problem) {
      console.error(`::error::${problem}`);
      process.exit(1);
    }
    console.log(`${apk} carries the certificate ${ASSETLINKS} publishes`);
  } else {
    throw new Error('usage: android-apk.ts version | reuse <releases.json> <dir> | verify <apk>');
  }
}
