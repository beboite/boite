/*
 * A project's icon, read from its folder.
 *
 * First an image: a logo, app icon or favicon found by name in a fixed list of
 * folders (each read once, never recursively), then the well-known icons of a
 * few ecosystems (a Tauri bundle, an Android launcher, an IDE's project icon),
 * then what a manifest declares (`<link rel=icon>` in an `index.html`, a web
 * app manifest's `icons`, `bundle.icon` of `tauri.conf.json`, the `icon` field
 * of `package.json`). The lowest score wins, the larger file on a tie. Without
 * an image, a stack recognised from its marker files (`package.json`
 * dependencies, `Cargo.toml`, `go.mod` and so on).
 *
 * Bounded on every side: an image is at most `ICON_MAX_BYTES`, is one of five
 * types checked by its first bytes, and is never a link; a manifest is read
 * only under `MANIFEST_MAX_BYTES`; a folder listing stops at `DIR_MAX_ENTRIES`;
 * an href that leaves the folder is ignored. Nothing here runs at start: the
 * project store calls it after a project is added, once for a project never
 * checked, and on `projects.refreshIcon`.
 */
import { createHash } from 'node:crypto';
import { lstat, opendir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, parse } from 'node:path';
import type { TechIconId } from '@boite/contracts';

/** The largest image kept, before base64. */
export const ICON_MAX_BYTES = 256 * 1024;
/** The largest `index.html`, manifest or `package.json` parsed for a declared icon or a stack. */
export const MANIFEST_MAX_BYTES = 256 * 1024;
/** How many names one folder listing reads before it stops. */
export const DIR_MAX_ENTRIES = 2_000;

export type DetectedIcon =
  | { kind: 'image'; mime: string; bytes: Uint8Array; version: string; source: string }
  | { kind: 'tech'; id: TechIconId }
  | { kind: 'none' };

/**
 * Folders listed (not walked) for files named like a logo, an icon or a
 * favicon. An earlier folder wins a tie.
 */
export const SCAN_DIRS: readonly string[] = [
  '', 'public', 'static', 'assets', 'docs', 'images', 'img', 'media', 'art', 'web', 'resources', 'branding',
  '.github', 'src', 'src/assets', 'src/app', 'app', 'static/img', 'public/images', 'public/img', 'public/icons',
  'docs/assets', 'docs/images', 'assets/images', 'assets/icons', 'buildResources', 'store',
  'fastlane/metadata/android/en-US/images', 'web/static', 'web/public', 'frontend/public', 'frontend/static',
  'client/public', 'client/static', 'site/static', 'www',
];

/** Icons of an ecosystem at a known path: they beat a favicon and lose to a file named logo or icon. */
const ECOSYSTEM_ICONS: readonly string[] = [
  'src-tauri/icons/128x128.png', 'src-tauri/icons/icon.png', 'src-tauri/icons/32x32.png', 'build/appicon.png',
  '.idea/icon.svg', '.idea/icon.png', 'web/icons/Icon-512.png', 'web/icons/Icon-192.png',
];
const ANDROID_RES = ['app/src/main/res', 'android/app/src/main/res'];
const ANDROID_DENSITIES = ['mipmap-xxxhdpi', 'mipmap-xxhdpi', 'mipmap-xhdpi', 'mipmap-hdpi', 'mipmap-mdpi'];
const ANDROID_NAMES = ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'];
const HTML_FILES = ['index.html', 'public/index.html', 'src/index.html', 'web/index.html'];
const WEB_MANIFESTS = [
  'manifest.json', 'site.webmanifest', 'manifest.webmanifest', 'public/manifest.json', 'public/site.webmanifest',
  'public/manifest.webmanifest', 'static/manifest.json', 'static/site.webmanifest', 'web/manifest.json',
];

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/** Tiers of the score: a name rank times this, an extension rank times a tenth of it, then the folder's index. */
const NAME_TIER = 1_000;
const EXT_TIER = 100;
const ECOSYSTEM_SCORE = 2_500;
const ANDROID_SCORE = 2_600;
const MANIFEST_SCORE = 3_000;

/** Lower is better; null for a name that is not a logo's. */
export function nameRank(file: string): number | null {
  const stem = parse(file).name.toLowerCase();
  if (stem === 'logo') return 0;
  if (['app-icon', 'appicon', 'app_icon', 'icon', 'brand', 'logotype'].includes(stem)) return 2;
  if (stem === 'favicon') return 4;
  if (stem.startsWith('logo')) return 1;
  if (stem.startsWith('icon')) return 3;
  if (stem.startsWith('favicon') || stem.startsWith('apple-touch-icon') || stem.startsWith('android-chrome')) return 5;
  if (stem.includes('logo')) return 6;
  if (stem.includes('icon')) return 7;
  return null;
}

/** Lower is better; null for a type that is not kept. */
export function extRank(file: string): number | null {
  const ext = extname(file).toLowerCase();
  const order = ['.svg', '.png', '.webp', '.jpg', '.ico'];
  if (ext === '.jpeg') return 3;
  const index = order.indexOf(ext);
  return index < 0 ? null : index;
}

/** Whether the bytes are what the extension says, so a text file named logo.png is not sent as an image. */
export function looksLike(mime: string, bytes: Uint8Array): boolean {
  const at = (i: number) => bytes[i];
  switch (mime) {
    case 'image/png': return at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47;
    case 'image/jpeg': return at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
    case 'image/x-icon': return at(0) === 0 && at(1) === 0 && at(2) === 1 && at(3) === 0;
    case 'image/webp': return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP';
    case 'image/svg+xml': return /<svg[\s>]/i.test(new TextDecoder().decode(bytes));
    default: return false;
  }
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

/** The names of a folder, at most `DIR_MAX_ENTRIES`, or none when it cannot be read. */
async function listNames(folder: string): Promise<string[]> {
  const names: string[] = [];
  try {
    const dir = await opendir(folder);
    for await (const entry of dir) {
      if (entry.isFile() || entry.isSymbolicLink()) names.push(entry.name);
      else if (entry.isDirectory()) names.push(`${entry.name}/`);
      if (names.length >= DIR_MAX_ENTRIES) break;
    }
  } catch {
    return names;
  }
  return names;
}

async function readSmall(path: string, max = MANIFEST_MAX_BYTES): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > max) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await readSmall(path);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The files an href or a manifest `src` can name inside the project. Anything
 * with a scheme or a drive (`:`), a protocol-relative `//` or a `..` names
 * something outside it and is dropped. A path starting with `/` is how a dev
 * server spells its public folder, so those are tried too.
 */
export function assetCandidates(root: string, base: string, href: string): string[] {
  const raw = href.trim();
  if (raw.length === 0 || raw.includes(':') || raw.startsWith('//') || raw.includes('..') || raw.includes('\\')) return [];
  const clean = raw.split(/[?#]/)[0] ?? '';
  const rel = clean.replace(/^\/+/, '');
  if (rel.length === 0) return [];
  const tries = [join(base, rel), join(root, rel)];
  if (clean.startsWith('/')) tries.push(join(root, 'public', rel), join(root, 'static', rel), join(root, 'web', rel));
  return [...new Set(tries)];
}

/** The `href` of each `<link>` whose `rel` names an icon, a mask icon left out. */
export function htmlIconHrefs(html: string): string[] {
  const hrefs: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = attribute(tag, 'rel')?.toLowerCase() ?? '';
    if (!rel.split(/\s+/).some((word) => word === 'icon' || word === 'apple-touch-icon') || rel.includes('mask-icon')) continue;
    const href = attribute(tag, 'href');
    if (href) hrefs.push(href);
  }
  return hrefs;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

/** Icons the project's manifests declare, in the order they are tried. */
async function declaredIcons(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const file of HTML_FILES) {
    const html = await readSmall(join(root, file));
    if (html === null) continue;
    for (const href of htmlIconHrefs(html)) found.push(...assetCandidates(root, dirname(join(root, file)), href));
  }
  for (const file of WEB_MANIFESTS) {
    const manifest = await readJson(join(root, file));
    const icons = manifest?.['icons'];
    if (!Array.isArray(icons)) continue;
    const entries = icons
      .map((icon) => {
        if (typeof icon !== 'object' || icon === null) return null;
        const { src, sizes } = icon as { src?: unknown; sizes?: unknown };
        if (typeof src !== 'string') return null;
        const size = typeof sizes === 'string' ? Number.parseInt(sizes.split(/[x ]/)[0] ?? '', 10) : 0;
        return { src, size: Number.isFinite(size) ? size : 0 };
      })
      .filter((entry): entry is { src: string; size: number } => entry !== null)
      .sort((a, b) => b.size - a.size);
    for (const entry of entries) found.push(...assetCandidates(root, dirname(join(root, file)), entry.src));
  }
  const tauri = await readJson(join(root, 'src-tauri', 'tauri.conf.json'));
  const bundleIcons = (tauri?.['bundle'] as { icon?: unknown } | undefined)?.icon;
  if (Array.isArray(bundleIcons)) {
    for (const icon of bundleIcons) {
      if (typeof icon === 'string' && /\.(png|ico)$/i.test(icon)) found.push(...assetCandidates(root, join(root, 'src-tauri'), icon));
    }
  }
  const pkg = await readJson(join(root, 'package.json'));
  if (typeof pkg?.['icon'] === 'string') found.push(...assetCandidates(root, root, pkg['icon']));
  return found;
}

interface Candidate {
  path: string;
  score: number;
  size: number;
}

/** The best image in the project, or null. */
async function findImage(root: string, rootNames: string[]): Promise<DetectedIcon | null> {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const push = async (path: string, score: number) => {
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(key)) return;
    seen.add(key);
    if (extRank(path) === null) return;
    try {
      // A link could point anywhere on the machine: only plain files count.
      const info = await lstat(path);
      if (!info.isFile() || info.size === 0 || info.size > ICON_MAX_BYTES) return;
      candidates.push({ path, score, size: info.size });
    } catch {
      /* not there */
    }
  };

  for (const [index, dir] of SCAN_DIRS.entries()) {
    const folder = dir === '' ? root : join(root, dir);
    const names = dir === '' ? rootNames : await listNames(folder);
    for (const name of names) {
      if (name.endsWith('/')) continue;
      const rank = nameRank(name);
      const ext = extRank(name);
      if (rank === null || ext === null) continue;
      await push(join(folder, name), rank * NAME_TIER + ext * EXT_TIER + index);
    }
  }
  for (const [index, rel] of ECOSYSTEM_ICONS.entries()) await push(join(root, rel), ECOSYSTEM_SCORE + index);
  for (const base of ANDROID_RES) {
    for (const [index, density] of ANDROID_DENSITIES.entries()) {
      for (const name of ANDROID_NAMES) await push(join(root, base, density, name), ANDROID_SCORE + index);
    }
  }
  for (const [index, path] of (await declaredIcons(root)).entries()) await push(path, MANIFEST_SCORE + index);

  candidates.sort((a, b) => a.score - b.score || b.size - a.size);
  for (const candidate of candidates) {
    const mime = MIME[extname(candidate.path).toLowerCase()];
    if (mime === undefined) continue;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(candidate.path));
    } catch {
      continue;
    }
    // Read again, not trusted from the listing: the file may have grown since.
    if (bytes.length === 0 || bytes.length > ICON_MAX_BYTES || !looksLike(mime, bytes)) continue;
    const version = createHash('sha1').update(bytes).digest('hex').slice(0, 12);
    return { kind: 'image', mime, bytes, version, source: candidate.path };
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Dependencies of `package.json` checked in this order: the first one present names the stack. */
const PACKAGE_STACKS: readonly [string, TechIconId][] = [
  ['electron', 'electron'],
  ['next', 'next'],
  ['nuxt', 'nuxt'],
  ['@sveltejs/kit', 'svelte'],
  ['svelte', 'svelte'],
  ['@angular/core', 'angular'],
  ['react-native', 'react'],
  ['react', 'react'],
];

/** The stack the folder reads as, from marker files at its root. */
export async function detectTech(root: string, rootNames?: string[]): Promise<TechIconId | null> {
  const names = rootNames ?? (await listNames(root));
  const has = (rel: string) => exists(join(root, rel));
  const hasExt = (ext: string) => names.some((name) => extname(name.replace(/\/$/, '')).toLowerCase() === ext);

  if (await has('ProjectSettings/ProjectVersion.txt')) return 'unity';
  if (hasExt('.uproject')) return 'unreal';
  if (await has('project.godot')) return 'godot';
  if (await has('pubspec.yaml')) return (await readSmall(join(root, 'pubspec.yaml')))?.includes('flutter') ? 'flutter' : 'dart';
  const pkg = await readJson(join(root, 'package.json'));
  if (pkg !== null) {
    const deps = new Set<string>();
    for (const section of ['dependencies', 'devDependencies']) {
      const value = pkg[section];
      if (typeof value === 'object' && value !== null) for (const name of Object.keys(value)) deps.add(name);
    }
    for (const [dep, id] of PACKAGE_STACKS) if (deps.has(dep)) return id;
  }
  if ((await has('settings.gradle')) || (await has('settings.gradle.kts'))
    || ((await has('gradlew')) && ((await has('build.gradle')) || (await has('build.gradle.kts'))))) return 'android';
  if ((await has('Package.swift')) || hasExt('.xcodeproj')) return 'swift';
  if (await has('Cargo.toml')) return 'rust';
  if (await has('go.mod')) return 'go';
  if ((await has('pyproject.toml')) || (await has('requirements.txt')) || (await has('setup.py'))) return 'python';
  if (hasExt('.sln') || hasExt('.csproj')) return 'dotnet';
  if (await has('pom.xml')) return 'java';
  if (await has('CMakeLists.txt')) return 'cpp';
  if (pkg !== null || (await has('package.json'))) return 'node';
  return null;
}

/** The icon of the project at `root`: an image, else a stack, else none. */
export async function detectProjectIcon(root: string): Promise<DetectedIcon> {
  const rootNames = await listNames(root);
  const image = await findImage(root, rootNames);
  if (image !== null) return image;
  const tech = await detectTech(root, rootNames);
  return tech === null ? { kind: 'none' } : { kind: 'tech', id: tech };
}
