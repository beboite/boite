import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { OsProfile } from '@boite/contracts';
import { openCode2Key } from '../src/providers/opencode.ts';
import { resolveCommand } from '../src/providers/resolve.ts';
import { sqliteHasRows } from '../src/providers/sqlite-login.ts';
import { Rejection, validateDescriptor } from '../src/providers/validate.ts';
import { attachVersions, forgetVersions, loadVersions, versionsSettled } from '../src/providers/versions.ts';

let dir: string;
let leave: (() => void) | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boite-major-'));
  forgetVersions();
});
afterEach(() => {
  leave?.();
  leave = undefined;
  forgetVersions();
  rmSync(dir, { recursive: true, force: true });
});

/** A program that prints one line for `--version`, as a shell script: no Windows form of it exists here. */
function program(name: string, line: string): string {
  const folder = join(dir, name);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'agent');
  writeFileSync(file, `#!/bin/sh\necho "${line}"\n`);
  chmodSync(file, 0o755);
  return file;
}

function profile(...candidates: OsProfile['executable']): OsProfile {
  return { detect: {}, executable: candidates, isolation: {} };
}

/** A host that runs the program for real and counts how often it was asked. */
function host(): { runs: string[]; changes: number; file: string } {
  const state = { runs: [] as string[], changes: 0, file: join(dir, 'executable-versions.json') };
  leave = attachVersions({
    file: state.file,
    changed: () => { state.changes += 1; },
    run: async (path, args) => {
      state.runs.push(path);
      const proc = Bun.spawn({ cmd: [path, ...args], stdout: 'pipe', stderr: 'pipe' });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      return output;
    },
  });
  return state;
}

test.skipIf(process.platform === 'win32')('a candidate that names a major takes only the program reporting it', async () => {
  const one = program('one', 'agent 1.9.3');
  const two = program('two', 'agent v2.0.1');
  const state = host();
  const second = profile({ kind: 'file', value: one, major: 2 }, { kind: 'file', value: two, major: 2 });
  const first = profile({ kind: 'file', value: one, major: 1 }, { kind: 'file', value: two });

  // Nobody asked the first program yet: the profile resolves to nothing rather than to a later candidate.
  expect(resolveCommand(second)).toBeNull();
  await versionsSettled();
  // One is at 1, so the second descriptor passes over it; two is not known yet either.
  expect(resolveCommand(second)).toBeNull();
  await versionsSettled();
  expect(resolveCommand(second)?.executable).toBe(two);
  expect(resolveCommand(first)?.executable).toBe(one);
  expect(state.runs).toEqual([one, two]);
  expect(state.changes).toBe(2);

  // Kept beside the data: another run of the core resolves at once and asks nothing.
  forgetVersions();
  loadVersions(state.file);
  expect(resolveCommand(second)?.executable).toBe(two);
  expect(state.runs.length).toBe(2);
  expect(Object.keys(JSON.parse(readFileSync(state.file, 'utf8')) as object).sort()).toEqual([one, two].sort());

  // Half a minute on, a kept reading is checked against its program once, by a resolution that asks.
  // One that does not ask (a provider turned off) starts nothing, however long ago the reading was kept.
  const later = spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
  try {
    expect(resolveCommand(second, false)?.executable).toBe(two);
    await versionsSettled();
    expect(state.runs.length).toBe(2);
    // The answer is still the kept reading while both programs are asked again behind it.
    expect(resolveCommand(second)?.executable).toBe(two);
    await versionsSettled();
    expect(state.runs.length).toBe(4);
    expect(state.changes).toBe(2);
    // Once per run: nothing more is asked.
    expect(resolveCommand(second)?.executable).toBe(two);
    await versionsSettled();
    expect(state.runs.length).toBe(4);
  } finally {
    later.mockRestore();
  }
});

test.skipIf(process.platform === 'win32')('a program replaced in place is asked again, and one that names no version never fits', async () => {
  const file = program('agent', 'agent 2.4.0');
  const state = host();
  const gated = profile({ kind: 'file', value: file, major: 2 });
  expect(resolveCommand(gated)).toBeNull();
  await versionsSettled();
  expect(resolveCommand(gated)?.executable).toBe(file);

  // Rewritten at the same version, as a reinstall does: nothing resolves while it is asked again,
  // so whoever listed meanwhile is told once the answer is in, though the version did not move.
  writeFileSync(file, '#!/bin/sh\necho "agent 2.4.0"\n# reinstalled\n');
  const before = state.changes;
  expect(resolveCommand(gated)).toBeNull();
  await versionsSettled();
  expect(resolveCommand(gated)?.executable).toBe(file);
  expect(state.changes).toBe(before + 1);

  // The same path now holds another major: its size changed, so the reading is not believed.
  writeFileSync(file, '#!/bin/sh\necho "agent version 3.0.0 (rewritten)"\n');
  expect(resolveCommand(gated)).toBeNull();
  await versionsSettled();
  expect(resolveCommand(gated)).toBeNull();
  expect(state.runs.length).toBe(3);

  // A provider that is turned off is resolved without asking: a program never asked stays unknown and is not run.
  const unasked = program('unasked', 'agent 2.0.0');
  expect(resolveCommand(profile({ kind: 'file', value: unasked, major: 2 }), false)).toBeNull();
  await versionsSettled();
  expect(state.runs).not.toContain(unasked);

  const mute = program('mute', 'no version here');
  const silent = profile({ kind: 'file', value: mute, major: 2 });
  expect(resolveCommand(silent)).toBeNull();
  await versionsSettled();
  expect(resolveCommand(silent)).toBeNull();
});

test.skipIf(process.platform === 'win32')('a program that cannot be run is passed over for the candidate behind it', async () => {
  const broken = program('broken', 'agent 2.0.0');
  const plain = program('plain', 'agent 9.9.9');
  let changes = 0;
  const asked: string[] = [];
  leave = attachVersions({
    file: join(dir, 'executable-versions.json'),
    changed: () => { changes += 1; },
    run: async (path) => {
      asked.push(path);
      throw new Error('the program did not start');
    },
  });
  const gated = profile({ kind: 'file', value: broken, major: 2 }, { kind: 'file', value: plain });

  // Asked and not answered yet: nothing resolves, the candidate may still be the right one.
  expect(resolveCommand(gated)).toBeNull();
  await versionsSettled();
  // It could not say: the candidate behind it is taken, and whoever listens was told to look again.
  expect(resolveCommand(gated)?.executable).toBe(plain);
  expect(changes).toBe(1);
  // Not asked again at every resolution.
  expect(resolveCommand(gated)?.executable).toBe(plain);
  expect(asked).toEqual([broken]);

  // A minute later it is asked again behind the scenes, and stays passed over meanwhile:
  // the candidate behind it keeps resolving, and a second failure tells nobody anything new.
  const now = spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  try {
    expect(resolveCommand(gated)?.executable).toBe(plain);
    await versionsSettled();
    expect(asked).toEqual([broken, broken]);
    expect(changes).toBe(1);
    expect(resolveCommand(gated)?.executable).toBe(plain);
  } finally {
    now.mockRestore();
  }
});

function descriptor(patch: Record<string, unknown>): Record<string, unknown> {
  const os = { detect: {}, executable: [{ kind: 'path', value: 'lab' }], isolation: { LAB_HOME: '{isolationDir}' } };
  return {
    id: 'lab', schemaVersion: 1, name: 'Lab', shortName: 'Lab', protocol: 'acp', roots: ['{isolationDir}'],
    profiles: { windows: os, linux: os, macos: os }, auth: { kind: 'none' },
    models: [{ id: 'default', name: 'Default', default: true }],
    capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: true },
    ...patch,
  };
}

function rejection(raw: unknown): { field: string; message: string } {
  try {
    validateDescriptor(raw, 'lab.json', new Set(), dir);
  } catch (error) {
    if (error instanceof Rejection) return { field: error.rejected.field, message: error.rejected.message };
    throw error;
  }
  throw new Error('the descriptor loaded');
}

test('a descriptor names a major, an experimental flag and a SQLite login, each refused with its field when wrong', () => {
  const os = (executable: unknown[]) => ({ detect: {}, executable, isolation: { LAB_HOME: '{isolationDir}' } });
  const good = validateDescriptor(descriptor({
    experimental: true,
    profiles: { linux: os([{ kind: 'path', value: 'lab', major: 2 }]) },
    auth: { kind: 'oauth-cli', sqlite: { file: 'lab/login.db', tables: ['credential'] } },
  }), 'lab.json', new Set(), dir);
  expect(good.experimental).toBe(true);
  expect(good.profiles.linux?.executable[0]?.major).toBe(2);
  expect(good.auth.sqlite).toEqual({ file: 'lab/login.db', tables: ['credential'] });

  expect(rejection(descriptor({ experimental: 'yes' })).field).toBe('experimental');
  expect(rejection(descriptor({ profiles: { linux: os([{ kind: 'path', value: 'lab', major: 0 }]) } })).field).toBe('profiles.linux.executable[0].major');
  expect(rejection(descriptor({ profiles: { linux: os([{ kind: 'npm', value: '@lab/agent', major: 2 }]) } }))).toEqual({
    field: 'profiles.linux.executable[0].major',
    message: 'an npm candidate names its package and takes no major',
  });
  expect(rejection(descriptor({ auth: { kind: 'oauth-cli', sqlite: { file: 'login.db', tables: ['a; drop'] } } })).field).toBe('auth.sqlite.tables[0]');
  expect(rejection(descriptor({ auth: { kind: 'oauth-cli', sqlite: { file: '../login.db', tables: ['credential'] } } })).field).toBe('auth.sqlite.file');
  expect(rejection(descriptor({ auth: { kind: 'oauth-cli', sqlite: { file: 'login.db', tables: [] } } })).field).toBe('auth.sqlite.tables');
  // The login database is the account's own: sharing a folder that holds it is refused like a session file.
  expect(rejection(descriptor({
    auth: { kind: 'oauth-cli', sqlite: { file: 'lab/login.db', tables: ['credential'] } },
    shared: [{ variable: 'LAB_HOME', paths: ['lab'] }],
  })).field).toBe('shared[0].paths[0]');
});

/** The columns OpenCode 2.0.24 gives its `credential` table. */
function credentialDb(file: string): Database {
  mkdirSync(join(file, '..'), { recursive: true });
  const db = new Database(file);
  db.run('CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)');
  return db;
}

test('a SQLite login reads as signed in once a listed table holds a row', () => {
  const file = join(dir, 'opencode', 'opencode.db');
  expect(sqliteHasRows(file, ['credential'])).toBe(false);
  const db = credentialDb(file);
  expect(sqliteHasRows(file, ['credential', 'account'])).toBe(false);
  db.run("INSERT INTO credential VALUES ('cred_1', 'opencode-go', 'OpenCode Go', ?, NULL, NULL, 1, 1, 1)", [JSON.stringify({ type: 'key', key: 'fixture-go-key' })]);
  expect(sqliteHasRows(file, ['account', 'credential'])).toBe(true);
  db.close();

  // A file that is not a database says nothing about a login: unknown, never signed out.
  const broken = join(dir, 'broken.db');
  writeFileSync(broken, 'this is not a database, and it is long enough to be read as one');
  expect(sqliteHasRows(broken, ['credential'])).toBeNull();
  // A table this version of the agent does not have is only an empty answer.
  expect(sqliteHasRows(file, ['no_such_table'])).toBe(false);
});

test('the OpenCode 2 key of an integration is the active credential stored for it', () => {
  expect(openCode2Key(dir, 'opencode-go')).toBeNull();
  const db = credentialDb(join(dir, 'opencode', 'opencode.db'));
  const add = (id: string, integration: string, value: unknown, active: number, updated: number): void => {
    db.run('INSERT INTO credential VALUES (?, ?, ?, ?, NULL, NULL, ?, 1, ?)', [id, integration, integration, JSON.stringify(value), active, updated]);
  };
  add('cred_other', 'anthropic', { type: 'key', key: 'fixture-other-key' }, 1, 5);
  add('cred_old', 'opencode-go', { type: 'key', key: 'fixture-old-key' }, 0, 9);
  expect(openCode2Key(dir, 'opencode-go')).toBeNull();
  add('cred_oauth', 'opencode-go', { type: 'oauth', access: 'fixture-token' }, 1, 2);
  expect(openCode2Key(dir, 'opencode-go')).toBeNull();
  add('cred_go', 'opencode-go', { type: 'key', key: 'fixture-go-key' }, 1, 3);
  expect(openCode2Key(dir, 'opencode-go')).toBe('fixture-go-key');
  db.close();
});
