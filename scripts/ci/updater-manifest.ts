import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * The updater target each signed payload serves, keyed by the file name
 * Tauri gives it (the macOS archive is renamed per architecture in CI).
 * Linux keys carry the bundle type: the plugin looks up
 * `{os}-{arch}-{installer}` first, so an AppImage never receives a .deb.
 */
export const TARGETS: ReadonlyArray<readonly [string, RegExp]> = [
  ['windows-x86_64', /_x64-setup\.exe$/],
  ['linux-x86_64-appimage', /_amd64\.AppImage$/],
  ['linux-aarch64-appimage', /_aarch64\.AppImage$/],
  ['linux-x86_64-deb', /_amd64\.deb$/],
  ['linux-aarch64-deb', /_arm64\.deb$/],
  ['darwin-x86_64', /_x64\.app\.tar\.gz$/],
  ['darwin-aarch64', /_aarch64\.app\.tar\.gz$/],
];

/** Downloads a person installs by hand; the updater never fetches them. */
const MANUAL = [/_(x64|aarch64)\.dmg$/];

/** Files the publication job writes itself. */
const GENERATED = new Set(['release-notes.md', 'latest.json', 'SHA256SUMS.txt']);

export type Payload = { file: string; signature: string };

export function targetOf(file: string): string | undefined {
  return TARGETS.find(([, pattern]) => pattern.test(file))?.[0];
}

export function updaterManifest(version: string, repository: string, payloads: Payload[], notes: string, date: string) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('expected a semantic version');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('expected owner/repository');
  if (!Number.isFinite(Date.parse(date))) throw new Error('expected an ISO publication date');
  const platforms: Record<string, { signature: string; url: string }> = {};
  for (const { file, signature } of payloads) {
    if (basename(file) !== file) throw new Error(`${file}: expected an installer filename`);
    const target = targetOf(file);
    if (!target) throw new Error(`${file}: expected an installer filename matching one updater target`);
    if (platforms[target]) throw new Error(`${file}: a second payload for ${target}`);
    if (!signature.trim() || !/^[A-Za-z0-9+/=\s]+$/.test(signature)) throw new Error(`${file}: expected a base64 updater signature`);
    platforms[target] = {
      signature: signature.trim(),
      url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(file)}`,
    };
  }
  const missing = TARGETS.map(([target]) => target).filter((target) => !platforms[target]);
  if (missing.length) throw new Error(`missing signed payloads for ${missing.join(', ')}`);
  return { version, notes, pub_date: date, platforms };
}

/** Every file a release publishes, refusing anything the pipeline did not expect. */
export function releaseFiles(files: string[]) {
  const payloads: string[] = [];
  const downloads: string[] = [];
  for (const file of files) {
    if (GENERATED.has(file)) continue;
    if (file.endsWith('.sig')) {
      if (!targetOf(file.slice(0, -4))) throw new Error(`${file}: a signature without an updater payload`);
      continue;
    }
    if (targetOf(file)) payloads.push(file);
    else if (MANUAL.some((pattern) => pattern.test(file))) downloads.push(file);
    else throw new Error(`${file}: not a file a desktop release publishes`);
  }
  return { payloads: payloads.sort(), downloads: downloads.sort() };
}

if (import.meta.main) {
  const directory = process.argv[2] ?? 'artifacts';
  const { payloads } = releaseFiles(readdirSync(directory));
  const result = updaterManifest((process.env.RELEASE_TAG ?? '').replace(/^v/, ''), process.env.GITHUB_REPOSITORY ?? '',
    payloads.map((file) => ({ file, signature: readFileSync(join(directory, `${file}.sig`), 'utf8') })),
    readFileSync(join(directory, 'release-notes.md'), 'utf8'), new Date().toISOString());
  writeFileSync(join(directory, 'latest.json'), JSON.stringify(result, null, 2) + '\n');
}
