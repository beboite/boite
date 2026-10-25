import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSETLINKS,
  type AppVersion,
  type Release,
  assetlinksDigest,
  buildTool,
  formatVersion,
  nextVersion,
  parseBase,
  run,
  signerDigest,
  versionCode,
} from './android-apk.ts';

/**
 * Boite Server (`apps/android-server/app`) is a native app: its screens are in
 * the APK, and the core it drives arrives in the release bundle. It counts its
 * version like the Boite app (scripts/ci/android-apk.ts): `VERSION` holds
 * MAJOR.MINOR, a rebuild takes the next patch of the last published APK. The
 * nightly signs it with the same key. `reuse` keeps the latest published APK
 * when nothing that goes into it moved: everything under `apps/android-server`
 * except `termux/`, which ships in the bundle, and the key that signed it.
 */

export const APP = 'apps/android-server';
export const VERSION_FILE = `${APP}/VERSION`;
/** `termux/` is the bundle's: the APK reads nothing from it. */
export const SOURCES = [APP, `:(exclude)${APP}/termux`];
/** `boite-server-android-1.0.3.apk`, named after the app's own version. */
const SERVER_APK = /^boite-server-android-(\d+)\.(\d+)\.(\d+)\.apk$/;

export function serverApkVersion(name: string): AppVersion | null {
  const match = SERVER_APK.exec(name);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

export function serverApkName(version: AppVersion): string {
  return `boite-server-android-${formatVersion(version)}.apk`;
}

/** Newest first, as the releases API lists them; a draft is this run's own. */
export function previousServerApk(releases: Release[]): { tag: string; name: string } | null {
  for (const release of releases) {
    if (release.draft) continue;
    const asset = release.assets.find((candidate) => SERVER_APK.test(candidate.name));
    if (asset) return { tag: release.tag_name, name: asset.name };
  }
  return null;
}

/** The version a rebuild carries: the patch after the published APK's, or patch 0. */
export function serverNextVersion(base: { major: number; minor: number }, previous: string | null): AppVersion {
  return nextVersion(base, previous ? serverApkVersion(previous) : null, VERSION_FILE);
}

/**
 * An update signed with another key is one Android refuses, so a reused or
 * rebuilt APK must carry the certificate the Boite app does: the one
 * assetlinks.json publishes.
 */
export function checkServerSigner(apk: string): string | null {
  const got = signerDigest(run([buildTool('apksigner'), 'verify', '--print-certs', apk]).out);
  const want = assetlinksDigest(readFileSync(ASSETLINKS, 'utf8'));
  if (got === want) return null;
  return `${apk} is signed with ${got ?? 'no certificate'} but ${ASSETLINKS} publishes ${want}: phones would refuse it as an update`;
}

interface Decision {
  reuse: boolean;
  reason: string;
  /** The reused file's name. */
  name?: string;
  /** The version a rebuild carries. */
  version?: AppVersion;
}

function reuse(releasesFile: string, dir: string, base: { major: number; minor: number }): Decision {
  const previous = previousServerApk(JSON.parse(readFileSync(releasesFile, 'utf8')).flat());
  if (!previous) return { reuse: false, reason: 'no published release carries a signed Boite Server APK yet', version: serverNextVersion(base, null) };
  const { tag, name } = previous;
  const build = (reason: string): Decision => ({ reuse: false, reason, version: serverNextVersion(base, name) });
  if (!run(['git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}`], true).ok) {
    return build(`the tag ${tag} of ${name} is not in this checkout`);
  }
  if (!run(['git', 'diff', '--quiet', tag, 'HEAD', '--', ...SOURCES]).ok) {
    return build(`${APP} changed since ${tag}`);
  }
  if (!run(['gh', 'release', 'download', tag, '--pattern', name, '--dir', dir]).ok) {
    return build(`${name} could not be downloaded from ${tag}`);
  }
  const signer = checkServerSigner(join(dir, name));
  if (signer) {
    Bun.spawnSync(['rm', '-f', join(dir, name)]);
    return build(signer);
  }
  return { reuse: true, reason: `${APP} and the key unchanged since ${tag}`, name };
}

function output(lines: string[]) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.map((line) => `${line}\n`).join(''));
}

function versionOutput(version: AppVersion): string[] {
  return [`version=${formatVersion(version)}`, `code=${versionCode(version)}`];
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const base = () => parseBase(readFileSync(VERSION_FILE, 'utf8'), VERSION_FILE);
  if (command === 'version') {
    // A build that publishes nothing: no earlier APK to count from.
    const version = serverNextVersion(base(), null);
    console.log(`app version ${formatVersion(version)}, code ${versionCode(version)}`);
    output(versionOutput(version));
  } else if (command === 'reuse') {
    const [releases, dir] = args;
    if (!releases || !dir) throw new Error('usage: android-server-apk.ts reuse <releases.json> <dir>');
    const decision = reuse(releases, dir, base());
    if (decision.reuse) {
      console.log(`reusing ${decision.name}: ${decision.reason}`);
      output(['reuse=true']);
    } else {
      const version = decision.version!;
      console.log(`building ${serverApkName(version)}: ${decision.reason}`);
      output(['reuse=false', ...versionOutput(version)]);
    }
  } else if (command === 'verify') {
    const [apk] = args;
    if (!apk) throw new Error('usage: android-server-apk.ts verify <apk>');
    const problem = checkServerSigner(apk);
    if (problem) {
      console.error(`::error::${problem}`);
      process.exit(1);
    }
    console.log(`${apk} carries the certificate ${ASSETLINKS} publishes`);
  } else {
    throw new Error('usage: android-server-apk.ts version | reuse <releases.json> <dir> | verify <apk>');
  }
}
