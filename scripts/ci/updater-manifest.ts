import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export function updaterManifest(version: string, repository: string, file: string, signature: string, notes: string, date: string) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('expected a semantic version');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('expected owner/repository');
  if (!file.endsWith('.exe') || basename(file) !== file) throw new Error('expected an installer filename');
  if (!signature.trim() || !/^[A-Za-z0-9+/=\s]+$/.test(signature)) throw new Error('expected a base64 updater signature');
  if (!Number.isFinite(Date.parse(date))) throw new Error('expected an ISO publication date');
  return {
    version, notes, pub_date: date,
    platforms: { 'windows-x86_64': {
      signature: signature.trim(),
      url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(file)}`,
    } },
  };
}

if (import.meta.main) {
  const directory = process.argv[2] ?? 'artifacts';
  const installers = readdirSync(directory).filter(file => file.endsWith('.exe'));
  if (installers.length !== 1) throw new Error(`expected one Windows installer, found ${installers.length}`);
  const file = installers[0]!;
  const result = updaterManifest((process.env.RELEASE_TAG ?? '').replace(/^v/, ''), process.env.GITHUB_REPOSITORY ?? '',
    file, readFileSync(join(directory, `${file}.sig`), 'utf8'), readFileSync(join(directory, 'release-notes.md'), 'utf8'), new Date().toISOString());
  writeFileSync(join(directory, 'latest.json'), JSON.stringify(result, null, 2) + '\n');
}
