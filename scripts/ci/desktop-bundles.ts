/**
 * Collects what one Linux or macOS runner publishes into a flat directory and
 * refuses a set a release could not use: a missing payload, a missing
 * signature or a stray file. The macOS updater archive is always named
 * `Boite.app.tar.gz`, so it takes the architecture from the DMG beside it;
 * the Intel and Apple Silicon archives would otherwise overwrite each other.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { shellTarget } from '../../apps/shell/scripts/targets';
import { targetOf } from './updater-manifest';

type Source = { from: string; to: string };

/** The updater targets each runner owns, by `process.platform` and `process.arch`. */
export const EXPECTED: Record<string, string[]> = {
  'linux-x64': ['linux-x86_64-deb', 'linux-x86_64-appimage'],
  'linux-arm64': ['linux-aarch64-deb', 'linux-aarch64-appimage'],
  'darwin-x64': ['darwin-x86_64'],
  'darwin-arm64': ['darwin-aarch64'],
};

const list = (directory: string) => (existsSync(directory) ? readdirSync(directory) : []);

/** Maps bundle outputs, as `<bundle kind>/<file>`, to the names they are published under. */
export function plan(host: string, files: string[]): Source[] {
  const expected = EXPECTED[host];
  if (!expected) throw new Error(`${host}: expected linux or darwin on x64 or arm64`);
  const sources: Source[] = [];
  if (host.startsWith('linux')) {
    for (const file of files) {
      if (/^(deb\/[^/]+\.deb|appimage\/[^/]+\.AppImage)(\.sig)?$/.test(file)) sources.push({ from: file, to: file.split('/')[1]! });
    }
  } else {
    const dmgs = files.filter((file) => /^dmg\/[^/]+\.dmg$/.test(file));
    if (dmgs.length !== 1) throw new Error(`expected one DMG, found ${dmgs.length}`);
    const base = dmgs[0]!.slice('dmg/'.length, -'.dmg'.length);
    sources.push({ from: dmgs[0]!, to: `${base}.dmg` });
    for (const file of files) {
      const archive = /^macos\/[^/]+\.app\.tar\.gz(\.sig)?$/.exec(file);
      if (archive) sources.push({ from: file, to: `${base}.app.tar.gz${archive[1] ?? ''}` });
    }
  }
  const names = sources.map((source) => source.to);
  for (const target of expected) {
    const payload = names.find((name) => targetOf(name) === target);
    if (!payload) throw new Error(`no ${target} payload among ${files.join(', ') || 'no files'}`);
    if (!names.includes(`${payload}.sig`)) throw new Error(`${payload}: missing updater signature`);
  }
  const stray = names.filter((name) => {
    const target = targetOf(name.replace(/\.sig$/, ''));
    return target ? !expected.includes(target) : !name.endsWith('.dmg');
  });
  if (stray.length) throw new Error(`unexpected bundle outputs: ${stray.join(', ')}`);
  if (new Set(names).size !== names.length) throw new Error(`two bundles share a name: ${names.join(', ')}`);
  return sources;
}

if (import.meta.main) {
  const output = process.argv[2];
  if (!output) throw new Error('usage: desktop-bundles.ts <output directory>');
  // A cross build (`BOITE_TARGET`) bundles under its triple and publishes for its architecture.
  const { triple, cross, arch } = shellTarget();
  const bundle = join(import.meta.dir, '../../apps/shell/src-tauri/target', ...(cross ? [triple] : []), 'release/bundle');
  const files = ['deb', 'appimage', 'dmg', 'macos'].flatMap((kind) => list(join(bundle, kind)).map((file) => `${kind}/${file}`));
  mkdirSync(output, { recursive: true });
  for (const { from, to } of plan(`${process.platform}-${arch}`, files)) {
    copyFileSync(join(bundle, from), join(output, to));
    console.log(`${from} -> ${to}`);
  }
}
