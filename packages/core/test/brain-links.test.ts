import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BrainLinks, type OwnedBrainLink } from '../src/brain-links.ts';

let root: string, home: string, brain: string, owned: OwnedBrainLink[], links: BrainLinks;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'boite-brain-links-'));
  home = join(root, 'home'); brain = join(root, 'brain');
  mkdirSync(home); mkdirSync(brain); writeFileSync(join(brain, 'AGENTS.md'), 'Shared rules');
  owned = [];
  links = new BrainLinks({ get: () => owned, set: next => { owned = next; } }, { home, env: {} });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test('all global profiles follow the source through an atomic Git-style replacement', () => {
  const result = links.apply(brain);
  expect(result.every(link => link.state === 'linked')).toBe(true);
  expect(result.map(link => link.name)).toEqual(['Claude Code', 'Codex', 'OpenCode', 'pi', 'Grok', 'Gemini / Antigravity', 'Muse']);
  for (const link of result) {
    expect(lstatSync(link.path).isSymbolicLink()).toBe(true);
    expect(readFileSync(link.path, 'utf8')).toBe('Shared rules');
  }
  writeFileSync(join(brain, 'new.md'), 'Updated by pull');
  renameSync(join(brain, 'new.md'), join(brain, 'AGENTS.md'));
  expect(result.every(link => readFileSync(link.path, 'utf8') === 'Updated by pull')).toBe(true);
  expect(links.apply(brain)).toEqual(result);
  expect(owned).toHaveLength(result.length);
  links.apply(null);
  expect(result.every(link => !existsSync(link.path))).toBe(true);
  expect(owned).toEqual([]);
});

test('existing files are backed up and restored, existing matching links stay user-owned', () => {
  const path = join(home, '.codex', 'AGENTS.md');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'Personal rules');
  const pi = join(home, '.pi', 'agent', 'AGENTS.md');
  mkdirSync(dirname(pi), { recursive: true }); symlinkSync(join(brain, 'AGENTS.md'), pi, 'file');
  expect(links.apply(brain).find(link => link.path === pi)?.state).toBe('existing');
  const backup = owned.find(link => link.path === path)!.backup!;
  expect(readFileSync(backup, 'utf8')).toBe('Personal rules');
  links.apply(null);
  expect(readFileSync(path, 'utf8')).toBe('Personal rules');
  expect(existsSync(backup)).toBe(false);
  expect(lstatSync(pi).isSymbolicLink()).toBe(true);
});

test('switching brains preserves the original backup and never overwrites a user replacement', () => {
  const path = join(home, '.grok', 'AGENTS.md');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'Original');
  links.apply(brain);
  const second = join(root, 'second'); mkdirSync(second); writeFileSync(join(second, 'AGENTS.md'), 'Second');
  links.apply(second);
  expect(readFileSync(path, 'utf8')).toBe('Second');
  const backup = owned.find(link => link.path === path)!.backup!;
  unlinkSync(path); writeFileSync(path, 'User replacement');
  expect(links.apply(null).find(link => link.path === path)?.state).toBe('blocked');
  expect(readFileSync(path, 'utf8')).toBe('User replacement');
  expect(readFileSync(backup, 'utf8')).toBe('Original');
});

test('profile environment overrides are honored and Codex override files remain visible', () => {
  const codex = join(root, 'custom-codex'), xdg = join(root, 'xdg');
  links = new BrainLinks({ get: () => owned, set: next => { owned = next; } }, { home, env: { CODEX_HOME: codex, XDG_CONFIG_HOME: xdg } });
  mkdirSync(codex); writeFileSync(join(codex, 'AGENTS.override.md'), 'Override');
  const result = links.apply(brain);
  expect(result.find(link => link.name === 'Codex')?.error).toContain('AGENTS.override.md');
  expect(readFileSync(join(codex, 'AGENTS.override.md'), 'utf8')).toBe('Override');
  expect(result.find(link => link.name === 'OpenCode')?.path).toBe(join(xdg, 'opencode', 'AGENTS.md'));
  expect(resolve(readlinkSync(join(xdg, 'opencode', 'AGENTS.md')))).toBe(join(brain, 'AGENTS.md'));
});

test('missing and outside source files cannot create broken global links', () => {
  unlinkSync(join(brain, 'AGENTS.md'));
  expect(links.apply(brain).every(link => link.state === 'blocked')).toBe(true);
  expect(owned).toEqual([]);
  writeFileSync(join(root, 'outside.md'), 'Outside');
  symlinkSync(join(root, 'outside.md'), join(brain, 'AGENTS.md'), 'file');
  expect(links.apply(brain).every(link => link.state === 'blocked')).toBe(true);
  expect(owned).toEqual([]);
});

test('pi overrides and directories are preserved instead of reporting a working link', () => {
  const pi = join(home, '.pi', 'agent');
  mkdirSync(pi, { recursive: true }); writeFileSync(join(pi, 'AGENTS.override.md'), 'Override');
  const claude = join(home, '.claude', 'CLAUDE.md'); mkdirSync(claude, { recursive: true });
  const result = links.apply(brain);
  expect(result.find(link => link.name === 'pi')?.state).toBe('blocked');
  expect(result.find(link => link.name === 'Claude Code')?.state).toBe('blocked');
  expect(lstatSync(claude).isDirectory()).toBe(true);
});

test('a broken previous symlink is restored with its original relative target', () => {
  const path = join(home, '.codex', 'AGENTS.md'); mkdirSync(dirname(path), { recursive: true });
  symlinkSync('missing.md', path, 'file');
  links.apply(brain); links.apply(null);
  expect(readlinkSync(path)).toBe('missing.md');
  expect(owned).toEqual([]);
});

test('a refused symlink restores the original file and reports the failure', () => {
  const path = join(home, '.codex', 'AGENTS.md'); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'Original');
  const create = fs.symlinkSync;
  const mock = spyOn(fs, 'symlinkSync').mockImplementation((source, destination, type) => {
    if (destination === path) throw Object.assign(new Error('Symlink permission denied'), { code: 'EPERM' });
    return create(source, destination, type);
  });
  try {
    expect(links.apply(brain).find(link => link.path === path)?.error).toContain('permission denied');
    expect(readFileSync(path, 'utf8')).toBe('Original');
    expect(owned.some(link => link.path === path)).toBe(false);
  } finally { mock.mockRestore(); }
});

test('a failed install keeps its backup tracked when another writer occupies the destination', () => {
  const path = join(home, '.codex', 'AGENTS.md'); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'Original');
  const create = fs.symlinkSync;
  const mock = spyOn(fs, 'symlinkSync').mockImplementation((source, destination, type) => {
    if (destination === path) { writeFileSync(path, 'Concurrent edit'); throw Object.assign(new Error('Destination exists'), { code: 'EEXIST' }); }
    return create(source, destination, type);
  });
  try {
    links.apply(brain);
    const backup = owned.find(link => link.path === path)?.backup;
    expect(backup).toBeDefined();
    expect(readFileSync(backup!, 'utf8')).toBe('Original');
    expect(links.apply(null).find(link => link.path === path)?.error).toContain(backup!);
    expect(readFileSync(path, 'utf8')).toBe('Concurrent edit');
  } finally { mock.mockRestore(); }
});
