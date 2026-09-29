/*
 * A project's icon: what the folder is searched for and in which order, the
 * bounds on what is read, and that answering a list never reads a folder.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RpcErrorCode, type Project, type TechIconId } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { assertAllowed } from '../src/access.ts';
import type { Connection } from '../src/router.ts';
import { ICON_MAX_BYTES, assetCandidates, detectProjectIcon, htmlIconHrefs, type DetectedIcon } from '../src/project-icons.ts';
import { ProjectStore } from '../src/projects.ts';
import { startTestCore, waitFor } from './harness.ts';
import type { TestCore } from './harness.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';

const folders: string[] = [];

function folder(files: Record<string, string | Uint8Array> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'boite-icon-'));
  folders.push(root);
  for (const [rel, content] of Object.entries(files)) put(root, rel, content);
  return root;
}

function put(root: string, rel: string, content: string | Uint8Array): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A PNG of exactly `size` bytes: the signature, then padding. */
function pngOf(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(PNG);
  return bytes;
}

function source(icon: DetectedIcon): string {
  if (icon.kind !== 'image') throw new Error(`expected an image, got ${JSON.stringify(icon)}`);
  return icon.source.slice(icon.source.indexOf('boite-icon-')).split(/[\\/]/).slice(1).join('/');
}

afterEach(() => {
  for (const root of folders.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('detection', () => {
  test('a file named logo beats a favicon, in any folder of the list', async () => {
    const root = folder({ 'public/favicon.ico': ICO, 'assets/logo.svg': SVG });
    const icon = await detectProjectIcon(root);
    expect(source(icon)).toBe('assets/logo.svg');
    expect(icon).toMatchObject({ kind: 'image', mime: 'image/svg+xml' });
  });

  test('on the same name, SVG beats PNG, and an earlier folder beats a later one', async () => {
    expect(source(await detectProjectIcon(folder({ 'logo.png': PNG, 'logo.svg': SVG })))).toBe('logo.svg');
    expect(source(await detectProjectIcon(folder({ 'static/logo.png': PNG, 'public/logo.png': PNG })))).toBe('public/logo.png');
  });

  test('a favicon alone is found', async () => {
    const icon = await detectProjectIcon(folder({ 'public/favicon.png': PNG }));
    expect(source(icon)).toBe('public/favicon.png');
  });

  test("an ecosystem's icon at its known path beats a favicon and loses to a logo", async () => {
    expect(source(await detectProjectIcon(folder({ 'public/favicon.ico': ICO, 'src-tauri/icons/128x128.png': PNG })))).toBe('src-tauri/icons/128x128.png');
    expect(source(await detectProjectIcon(folder({ 'logo.png': PNG, 'src-tauri/icons/128x128.png': PNG })))).toBe('logo.png');
    expect(source(await detectProjectIcon(folder({ 'app/src/main/res/mipmap-hdpi/ic_launcher.png': PNG })))).toBe('app/src/main/res/mipmap-hdpi/ic_launcher.png');
  });

  test('a file no name rule matches is found through the <link rel=icon> of index.html', async () => {
    const root = folder({
      'index.html': '<html><head><link rel="mask-icon" href="/mask.svg"><link href="/brand/mark.png" rel="icon"></head></html>',
      'public/brand/mark.png': PNG,
      'public/mask.svg': SVG,
    });
    expect(source(await detectProjectIcon(root))).toBe('public/brand/mark.png');
  });

  test("a web manifest's icons are tried largest first, and package.json's icon field is read", async () => {
    const manifest = JSON.stringify({ icons: [{ src: 'small.png', sizes: '48x48' }, { src: 'big.png', sizes: '512x512' }] });
    expect(source(await detectProjectIcon(folder({ 'site.webmanifest': manifest, 'small.png': PNG, 'big.png': PNG })))).toBe('big.png');
    expect(source(await detectProjectIcon(folder({ 'package.json': JSON.stringify({ icon: 'media/mark.png' }), 'media/mark.png': PNG })))).toBe('media/mark.png');
  });

  test('an href that leaves the folder or names a scheme is dropped', () => {
    expect(assetCandidates('/p', '/p', '../outside.png')).toEqual([]);
    expect(assetCandidates('/p', '/p', 'https://example.com/a.png')).toEqual([]);
    expect(assetCandidates('/p', '/p', 'C:/Windows/a.png')).toEqual([]);
    expect(assetCandidates('/p', '/p', '//cdn/a.png')).toEqual([]);
    expect(assetCandidates('/p', '/p', 'data:image/png;base64,AA')).toEqual([]);
    expect(htmlIconHrefs("<link rel='shortcut icon' href=fav.ico>")).toEqual(['fav.ico']);
  });

  test(`an image over ${ICON_MAX_BYTES} bytes is skipped for the next one`, async () => {
    const root = folder({ 'logo.png': pngOf(ICON_MAX_BYTES + 1), 'public/favicon.png': pngOf(ICON_MAX_BYTES) });
    const icon = await detectProjectIcon(root);
    expect(source(icon)).toBe('public/favicon.png');
    expect(icon.kind === 'image' && icon.bytes.length).toBe(ICON_MAX_BYTES);
    // Alone, too large means no image at all.
    expect(await detectProjectIcon(folder({ 'logo.png': pngOf(ICON_MAX_BYTES + 1) }))).toEqual({ kind: 'none' });
  });

  test('a file whose bytes are not what its extension says is skipped', async () => {
    expect(await detectProjectIcon(folder({ 'logo.png': 'not a png', 'logo.svg': 'no markup here' }))).toEqual({ kind: 'none' });
    expect(await detectProjectIcon(folder({ 'logo.gif': 'GIF89a' }))).toEqual({ kind: 'none' });
  });

  test('the version follows the bytes', async () => {
    const root = folder({ 'logo.svg': SVG });
    const first = await detectProjectIcon(root);
    put(root, 'logo.svg', SVG.replace('8"/>', '6"/>'));
    const second = await detectProjectIcon(root);
    expect(first.kind === 'image' && second.kind === 'image' && first.version !== second.version).toBe(true);
    expect(await detectProjectIcon(root)).toMatchObject({ version: second.kind === 'image' ? second.version : '' });
  });

  test('without an image, the stack is read from its marker files, in order', async () => {
    const cases: [Record<string, string>, TechIconId | null][] = [
      [{ 'package.json': JSON.stringify({ devDependencies: { svelte: '5', vite: '8' } }) }, 'svelte'],
      [{ 'package.json': JSON.stringify({ dependencies: { react: '19', 'react-dom': '19' } }) }, 'react'],
      [{ 'package.json': JSON.stringify({ dependencies: { next: '16', react: '19' } }) }, 'next'],
      [{ 'package.json': JSON.stringify({ dependencies: { express: '5' } }) }, 'node'],
      [{ 'Cargo.toml': '[package]' }, 'rust'],
      [{ 'go.mod': 'module x' }, 'go'],
      [{ 'pyproject.toml': '[project]' }, 'python'],
      [{ 'pubspec.yaml': 'dependencies:\n  flutter:\n' }, 'flutter'],
      [{ 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000' }, 'unity'],
      [{ 'Game.uproject': '{}' }, 'unreal'],
      [{ 'App.sln': '' }, 'dotnet'],
      [{ 'CMakeLists.txt': '' }, 'cpp'],
      // A package.json dependency wins over a Cargo.toml at the root, as in a desktop app.
      [{ 'package.json': JSON.stringify({ dependencies: { '@sveltejs/kit': '3' } }), 'Cargo.toml': '' }, 'svelte'],
      [{ 'README.md': '# nothing' }, null],
    ];
    for (const [files, expected] of cases) {
      const icon = await detectProjectIcon(folder(files));
      const want: DetectedIcon = expected === null ? { kind: 'none' } : { kind: 'tech', id: expected };
      expect({ files: Object.keys(files), icon }).toEqual({ files: Object.keys(files), icon: want });
    }
  });

  test('an image wins over the stack', async () => {
    const icon = await detectProjectIcon(folder({ 'Cargo.toml': '', 'logo.png': PNG }));
    expect(icon.kind).toBe('image');
  });
});

describe('the project store', () => {
  let harness: TestCore;
  let client: CoreClient;

  beforeEach(async () => {
    harness = await startTestCore();
    client = await harness.connect();
  });

  afterEach(async () => {
    await harness.stop();
  });

  test('a project added is answered at once, and its logo follows as project.updated', async () => {
    const root = folder({ 'public/logo.svg': SVG });
    const heard: Project[] = [];
    client.on('project.updated', (project) => heard.push(project));
    const added = await client.call('projects.add', { path: root });
    expect(added.icon).toBeUndefined();
    await waitFor(() => heard.some((p) => p.id === added.id && p.icon !== undefined));
    const icon = heard.find((p) => p.id === added.id)?.icon;
    expect(icon).toMatchObject({ kind: 'image' });
    const version = icon?.kind === 'image' ? icon.version : '';
    expect(version).toMatch(/^[0-9a-f]{12}$/);

    // The list carries the version only; the bytes are a call of their own.
    const listed = (await client.call('projects.list', {})).find((p) => p.id === added.id);
    expect(listed?.icon).toEqual({ kind: 'image', version });
    expect(JSON.stringify(listed).length).toBeLessThan(400);
    const image = await client.call('projects.icon', { projectId: added.id });
    expect(image.version).toBe(version);
    expect(image.dataUrl).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`);
  });

  test('a stack is announced by its id, and projects.icon refuses a project whose icon is no image', async () => {
    const root = folder({ 'go.mod': 'module x' });
    const added = await client.call('projects.add', { path: root });
    await waitFor(() => harness.core.journal.projectIcons().has(added.id));
    expect((await client.call('projects.list', {})).find((p) => p.id === added.id)?.icon).toEqual({ kind: 'tech', id: 'go' });
    try {
      await client.call('projects.icon', { projectId: added.id });
      throw new Error('answered');
    } catch (error) {
      const rpc = (error as { rpc: { code?: number; data?: Record<string, unknown> } }).rpc;
      expect(rpc.code).toBe(RpcErrorCode.Refused);
      expect(rpc.data).toMatchObject({ field: 'projectId', projectId: added.id });
    }
  });

  test('refreshIcon reads the folder again and announces only a change', async () => {
    const root = folder({ 'README.md': '# empty' });
    const added = await client.call('projects.add', { path: root });
    await waitFor(() => harness.core.journal.projectIcons().has(added.id));
    const heard: Project[] = [];
    client.on('project.updated', (project) => heard.push(project));

    expect((await client.call('projects.refreshIcon', { projectId: added.id })).icon).toBeUndefined();
    put(root, 'favicon.ico', ICO);
    const refreshed = await client.call('projects.refreshIcon', { projectId: added.id });
    expect(refreshed.icon).toMatchObject({ kind: 'image' });
    await waitFor(() => heard.length === 1);
    expect(heard[0]?.icon).toEqual(refreshed.icon);
    expect((await client.call('projects.icon', { projectId: added.id })).dataUrl.startsWith('data:image/x-icon;base64,')).toBe(true);

    // The same bytes again: no event.
    await client.call('projects.refreshIcon', { projectId: added.id });
    unlinkSync(join(root, 'favicon.ico'));
    put(root, 'Cargo.toml', '[package]');
    expect((await client.call('projects.refreshIcon', { projectId: added.id })).icon).toEqual({ kind: 'tech', id: 'rust' });
    await waitFor(() => heard.length === 2);
    expect(heard[1]?.icon).toEqual({ kind: 'tech', id: 'rust' });
    // The image went with it.
    expect(harness.core.journal.projectIconImage(added.id)).toBeNull();
  });

  test('a folder that does not answer in time is refused by name and keeps its icon', async () => {
    const root = folder({ 'go.mod': 'module x' });
    const added = await client.call('projects.add', { path: root });
    await waitFor(() => harness.core.journal.projectIcons().has(added.id));
    harness.core.projects.iconDetect = () => new Promise(() => undefined);
    harness.core.projects.iconWaitMs = 30;
    try {
      await client.call('projects.refreshIcon', { projectId: added.id });
      throw new Error('answered');
    } catch (error) {
      const rpc = (error as { rpc: { code?: number; data?: Record<string, unknown> } }).rpc;
      expect(rpc.code).toBe(RpcErrorCode.Refused);
      expect(rpc.data).toMatchObject({ field: 'projectId', path: root });
    }
    expect((await client.call('projects.list', {})).find((p) => p.id === added.id)?.icon).toEqual({ kind: 'tech', id: 'go' });
  });

  test('a list after a start reads icons from the journal and no folder; only unchecked projects are detected, afterwards', async () => {
    const withLogo = await client.call('projects.add', { path: folder({ 'logo.svg': SVG }) });
    const bare = await client.call('projects.add', { path: folder() });
    await waitFor(() => harness.core.journal.projectIcons().size === 2);
    const unchecked = await client.call('projects.add', { path: folder({ 'Cargo.toml': '' }) });
    // As a project from before this schema: no row yet.
    await waitFor(() => harness.core.journal.projectIcons().has(unchecked.id));
    harness.core.journal.db.query('DELETE FROM project_icons WHERE project_id = ?').run(unchecked.id);

    // A store as a fresh start builds it, with a detector that counts.
    const store = new ProjectStore(harness.core);
    const detected: string[] = [];
    store.iconDetect = async (path) => {
      detected.push(path);
      return detectProjectIcon(path);
    };
    const started = performance.now();
    const listed = await store.listFresh();
    const elapsed = performance.now() - started;
    expect(detected).toEqual([]);
    expect(listed.find((p) => p.id === withLogo.id)?.icon).toMatchObject({ kind: 'image' });
    expect(listed.find((p) => p.id === unchecked.id)?.icon).toBeUndefined();
    expect(elapsed).toBeLessThan(500);

    // Afterwards, in the background: the project never checked and the one where nothing was found.
    await waitFor(() => detected.length === 2);
    expect(detected.sort()).toEqual([bare.path, unchecked.path].sort());
    await waitFor(() => store.list().find((p) => p.id === unchecked.id)?.icon !== undefined);
    expect(store.list().find((p) => p.id === unchecked.id)?.icon).toEqual({ kind: 'tech', id: 'rust' });
    // Once per core: a second list queues nothing.
    await store.listFresh();
    await Bun.sleep(30);
    expect(detected).toHaveLength(2);
  });

  test('a removed project leaves no icon behind', async () => {
    const added = await client.call('projects.add', { path: folder({ 'logo.svg': SVG }) });
    await waitFor(() => harness.core.journal.projectIconImage(added.id) !== null);
    await client.call('projects.remove', { projectId: added.id });
    expect(harness.core.journal.projectIcons().has(added.id)).toBe(false);
  });

  test('a paired device reads an icon but cannot make the core read a folder', () => {
    const device: Connection = {
      id: 'con_test',
      subscriptions: new Set(),
      identity: { principal: 'session', sessionId: 'ses_test', threadId: null },
      sendEvent: () => undefined,
      close: () => undefined,
    };
    expect(() => assertAllowed('projects.icon', device, { projectId: 'prj_x' })).not.toThrow();
    expect(() => assertAllowed('projects.refreshIcon', device, { projectId: 'prj_x' })).toThrow();
  });
});
