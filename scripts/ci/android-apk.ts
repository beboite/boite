import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The nightly APK is a Trusted Web Activity: its whole UI comes from the core,
 * so a rebuild from an unchanged `apps/android/` gives the same app with a new
 * version number. `reuse` finds the APK of the latest published release and
 * keeps it when nothing that goes into it moved: the wrapper's sources, the
 * host it trusts and the key that signed it. The file keeps its original name,
 * which is the version it carries.
 */

export const ASSETLINKS = 'packages/ui/public/.well-known/assetlinks.json';
export const WRAPPER = 'apps/android';
const APK = /^boite-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\.apk$/;

export interface Release {
  tag_name: string;
  draft: boolean;
  assets: { name: string }[];
}

/** Newest first, as the releases API lists them; a draft is this run's own. */
export function previousApk(releases: Release[]): { tag: string; name: string } | null {
  for (const release of releases) {
    if (release.draft) continue;
    const asset = release.assets.find((candidate) => APK.test(candidate.name) && !candidate.name.endsWith('-unsigned.apk'));
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

function run(command: string[], quiet = false): { ok: boolean; out: string } {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: quiet ? 'pipe' : 'inherit' });
  return { ok: result.exitCode === 0, out: result.stdout.toString() };
}

function buildTool(name: string): string {
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

function reuse(releasesFile: string, host: string, dir: string): { reuse: boolean; reason: string; name?: string } {
  const previous = previousApk(JSON.parse(readFileSync(releasesFile, 'utf8')).flat());
  if (!previous) return { reuse: false, reason: 'no published release carries a signed APK yet' };
  const { tag, name } = previous;
  if (!run(['git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}`], true).ok) {
    return { reuse: false, reason: `the tag ${tag} of ${name} is not in this checkout` };
  }
  if (!run(['git', 'diff', '--quiet', tag, 'HEAD', '--', WRAPPER]).ok) {
    return { reuse: false, reason: `${WRAPPER} changed since ${tag}` };
  }
  if (!run(['gh', 'release', 'download', tag, '--pattern', name, '--dir', dir]).ok) {
    return { reuse: false, reason: `${name} could not be downloaded from ${tag}` };
  }
  const apk = join(dir, name);
  const built = apkHost(run([buildTool('aapt2'), 'dump', 'resources', apk]).out);
  if (built !== host) {
    Bun.spawnSync(['rm', '-f', apk]);
    return { reuse: false, reason: `${name} opens ${built ?? 'no host'}, this build opens ${host}` };
  }
  const signer = checkSigner(apk);
  if (signer) {
    Bun.spawnSync(['rm', '-f', apk]);
    return { reuse: false, reason: signer };
  }
  return { reuse: true, reason: `${WRAPPER}, host and key unchanged since ${tag}`, name };
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'reuse') {
    const [releases, dir] = args;
    const host = process.env.ANDROID_HOST ?? '';
    if (!releases || !dir || !host) throw new Error('usage: ANDROID_HOST=<host> android-apk.ts reuse <releases.json> <dir>');
    const decision = reuse(releases, host, dir);
    console.log(decision.reuse ? `reusing ${decision.name}: ${decision.reason}` : `building: ${decision.reason}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${decision.reuse}\n`);
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
    throw new Error('usage: android-apk.ts reuse <releases.json> <dir> | verify <apk>');
  }
}
