import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OsProfile, ProviderShare, ProviderSharedKeys } from '@boite/contracts';
import { SHARE_MARKER, shareKeys, shareProfile, unshareProfile } from '../src/profile-share.ts';
import { removeDir } from './harness.ts';

const profile: OsProfile = {
  detect: {},
  executable: [{ kind: 'path', value: 'codex' }],
  isolation: { CODEX_HOME: '{isolationDir}' },
  close: { processes: [] },
};

const shares: ProviderShare[] = [{
  variable: 'CODEX_HOME',
  paths: ['config.toml', 'hooks.json', 'skills', 'AGENTS.md'],
  retarget: { 'config.toml': ['hooks.json'] },
}];

describe('profile sharing', () => {
  let root: string;
  let source: string;
  let account: string;
  let before: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'boite-share-'));
    source = join(root, 'own');
    account = join(root, 'accounts', 'acc_1');
    mkdirSync(join(source, 'skills', 'deep'), { recursive: true });
    mkdirSync(account, { recursive: true });
    writeFileSync(join(source, 'skills', 'deep', 'SKILL.md'), 'skill');
    writeFileSync(join(source, 'hooks.json'), '{"hooks":{}}');
    const hooks = join(source, 'hooks.json');
    // The three spellings a config file may use for the same absolute path.
    writeFileSync(join(source, 'config.toml'), [
      `[hooks.state.'${hooks}:pre_tool_use:0:0']`,
      `escaped = "${hooks.split('\\').join('\\\\')}"`,
      `slashed = "${hooks.split('\\').join('/')}"`,
    ].join('\n'));
    before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = source;
  });

  afterEach(async () => {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
    await removeDir(root);
  });

  test('links directories, copies files and points a copy at the account\'s own files', () => {
    expect(shareProfile(account, profile, shares)).toEqual([]);

    expect(lstatSync(join(account, 'skills')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(account, 'skills', 'deep', 'SKILL.md'), 'utf8')).toBe('skill');
    expect(lstatSync(join(account, 'hooks.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(account, 'hooks.json'), 'utf8')).toBe('{"hooks":{}}');

    const config = readFileSync(join(account, 'config.toml'), 'utf8');
    const own = join(account, 'hooks.json');
    expect(config).toContain(`[hooks.state.'${own}:pre_tool_use:0:0']`);
    expect(config).toContain(`escaped = "${own.split('\\').join('\\\\')}"`);
    expect(config).toContain(`slashed = "${own.split('\\').join('/')}"`);
    expect(config).not.toContain(source.split('\\').join('/'));
    // A path the user does not have is skipped, not reported.
    expect(existsSync(join(account, 'AGENTS.md'))).toBe(false);
  });

  test('sets the account\'s own file aside once, then keeps the copy in step with the source', () => {
    writeFileSync(join(account, 'hooks.json'), 'the account\'s own');
    mkdirSync(join(account, 'skills'));
    writeFileSync(join(account, 'skills', 'mine.md'), 'mine');

    expect(shareProfile(account, profile, shares)).toEqual([]);
    const aside = readdirSync(account).filter((name) => name.includes('.own-')).sort();
    expect(aside).toHaveLength(2);
    expect(readFileSync(join(account, aside.find((name) => name.startsWith('hooks.json'))!), 'utf8')).toBe('the account\'s own');
    expect(readFileSync(join(account, aside.find((name) => name.startsWith('skills'))!, 'mine.md'), 'utf8')).toBe('mine');

    // The agent rewrites its copy, the user edits the source: the source wins,
    // and nothing more is set aside for a file Boite wrote.
    writeFileSync(join(account, 'hooks.json'), 'the agent rewrote it');
    writeFileSync(join(source, 'hooks.json'), '{"hooks":{"Stop":[]}}');
    expect(shareProfile(account, profile, shares)).toEqual([]);
    expect(readFileSync(join(account, 'hooks.json'), 'utf8')).toBe('{"hooks":{"Stop":[]}}');
    expect(readdirSync(account).filter((name) => name.includes('.own-'))).toHaveLength(2);
  });

  test('a path the user removed goes from the account, when it is still what Boite put there', () => {
    shareProfile(account, profile, shares);
    rmSync(join(source, 'hooks.json'));
    rmSync(join(source, 'skills'), { recursive: true });

    expect(shareProfile(account, profile, shares)).toEqual([]);
    expect(existsSync(join(account, 'hooks.json'))).toBe(false);
    expect(lstatSync(join(account, 'skills'), { throwIfNoEntry: false })).toBeUndefined();
    const marker = JSON.parse(readFileSync(join(account, SHARE_MARKER), 'utf8')) as { links: string[]; files: Record<string, string> };
    expect(marker.links).toEqual([]);
    expect(Object.keys(marker.files)).toEqual(['config.toml']);
  });

  test('removing the account removes its links and leaves the user\'s profile alone', () => {
    shareProfile(account, profile, shares);
    unshareProfile(account);
    expect(lstatSync(join(account, 'skills'), { throwIfNoEntry: false })).toBeUndefined();
    rmSync(account, { recursive: true, force: true });
    expect(readFileSync(join(source, 'skills', 'deep', 'SKILL.md'), 'utf8')).toBe('skill');
  });

  test('a variable this OS does not isolate shares nothing, and a failure names its path', () => {
    const elsewhere: OsProfile = { ...profile, isolation: { OTHER_HOME: '{isolationDir}' } };
    expect(shareProfile(account, elsewhere, shares)).toEqual([]);
    expect(readdirSync(account)).toEqual([]);

    // A file where the copy needs a parent directory fails the same way on every OS.
    writeFileSync(join(account, 'nested'), 'a file');
    const problems = shareProfile(account, profile, [{ variable: 'CODEX_HOME', paths: ['nested/hooks.json'] }]);
    expect(problems).toEqual([]);
    mkdirSync(join(source, 'nested'));
    writeFileSync(join(source, 'nested', 'hooks.json'), '{}');
    const failed = shareProfile(account, profile, [{ variable: 'CODEX_HOME', paths: ['nested/hooks.json'] }]);
    expect(failed.map((problem) => problem.path)).toEqual(['nested/hooks.json']);
  });

  test('a link on the way to a shared path stops it, and the account\'s own link at the path is set aside', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    mkdirSync(join(source, 'linked'));
    writeFileSync(join(source, 'linked', 'hooks.json'), '{}');
    symlinkSync(outside, join(account, 'linked'), 'junction');
    const problems = shareProfile(account, profile, [{ variable: 'CODEX_HOME', paths: ['linked/hooks.json'] }]);
    expect(problems.map((problem) => problem.path)).toEqual(['linked/hooks.json']);
    expect(problems[0]?.message).toContain('is a link');
    expect(readdirSync(outside)).toEqual([]);

    // Boite never makes a link where a file goes: one there is the account's.
    symlinkSync(outside, join(account, 'hooks.json'), 'junction');
    expect(shareProfile(account, profile, shares)).toEqual([]);
    expect(lstatSync(join(account, 'hooks.json')).isSymbolicLink()).toBe(false);
    const aside = readdirSync(account).find((name) => name.startsWith('hooks.json.own-'));
    expect(lstatSync(join(account, aside!)).isSymbolicLink()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  describe('shared keys', () => {
    // `home` names the user's file only when the variable is unset; here it is set.
    const entries: ProviderSharedKeys[] = [{ variable: 'CODEX_HOME', path: 'state.json', home: '~/.nowhere.json', keys: ['mcpServers'] }];
    const servers = { ssh: { type: 'stdio', command: 'ssh-mcp', env: { TOKEN: 'x' } } };
    const read = (): Record<string, unknown> => JSON.parse(readFileSync(join(account, 'state.json'), 'utf8')) as Record<string, unknown>;

    test('sets the key from the user\'s file and leaves the agent\'s own keys alone', () => {
      writeFileSync(join(source, 'state.json'), JSON.stringify({ mcpServers: servers, oauthAccount: { email: 'user' } }));
      writeFileSync(join(account, 'state.json'), JSON.stringify({ oauthAccount: { email: 'account' }, projects: { a: 1 } }));

      expect(shareKeys(account, profile, entries)).toEqual([]);
      expect(read()).toEqual({ oauthAccount: { email: 'account' }, projects: { a: 1 }, mcpServers: servers });

      // Nothing changed: the agent's later rewrite is not touched.
      writeFileSync(join(account, 'state.json'), JSON.stringify({ mcpServers: servers, projects: { a: 2 } }));
      expect(shareKeys(account, profile, entries)).toEqual([]);
      expect(read()).toEqual({ mcpServers: servers, projects: { a: 2 } });
    });

    test('follows the user\'s edits and removals, and keeps a value Boite never set aside', () => {
      writeFileSync(join(account, 'state.json'), JSON.stringify({ mcpServers: { mine: { command: 'own' } } }));
      writeFileSync(join(source, 'state.json'), JSON.stringify({ mcpServers: servers }));
      expect(shareKeys(account, profile, entries)).toEqual([]);
      const aside = readdirSync(account).filter((name) => name.startsWith('state.json.own-'));
      expect(aside).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(account, aside[0]!), 'utf8'))).toEqual({ mcpServers: { mine: { command: 'own' } } });
      expect(read()).toEqual({ mcpServers: servers });

      const more = { ...servers, semble: { command: 'semble' } };
      writeFileSync(join(source, 'state.json'), JSON.stringify({ mcpServers: more }));
      expect(shareKeys(account, profile, entries)).toEqual([]);
      expect(read()).toEqual({ mcpServers: more });
      expect(readdirSync(account).filter((name) => name.startsWith('state.json.own-'))).toHaveLength(1);

      writeFileSync(join(source, 'state.json'), JSON.stringify({}));
      expect(shareKeys(account, profile, entries)).toEqual([]);
      expect(read()).toEqual({});
    });

    test('creates no file when the user has none, and reports a file that is not JSON instead of overwriting it', () => {
      expect(shareKeys(account, profile, entries)).toEqual([]);
      expect(existsSync(join(account, 'state.json'))).toBe(false);

      writeFileSync(join(source, 'state.json'), JSON.stringify({ mcpServers: servers }));
      writeFileSync(join(account, 'state.json'), '{ half written');
      const problems = shareKeys(account, profile, entries);
      expect(problems.map((problem) => problem.path)).toEqual(['state.json']);
      expect(problems[0]?.message).toContain('is not valid JSON');
      expect(readFileSync(join(account, 'state.json'), 'utf8')).toBe('{ half written');
    });

    test('a failed write records no hash, so a value the agent writes later stays its own', () => {
      writeFileSync(join(source, 'state.json'), JSON.stringify({ mcpServers: servers }));
      // A directory where the temporary copy goes makes the write fail.
      mkdirSync(join(account, `state.json.boite-${process.pid}.tmp`));
      expect(shareKeys(account, profile, entries).map((problem) => problem.path)).toEqual(['state.json']);
      const markerFile = join(account, SHARE_MARKER);
      const marker = existsSync(markerFile) ? JSON.parse(readFileSync(markerFile, 'utf8')) as { keys?: Record<string, string> } : {};
      expect(marker.keys ?? {}).toEqual({});
      expect(existsSync(join(account, 'state.json'))).toBe(false);
    });

    test('a key the account file only inherits counts as absent', () => {
      const inherited: ProviderSharedKeys[] = [{ variable: 'CODEX_HOME', path: 'state.json', keys: ['toString'] }];
      writeFileSync(join(source, 'state.json'), JSON.stringify({ toString: 'theirs' }));
      writeFileSync(join(account, 'state.json'), JSON.stringify({}));
      expect(shareKeys(account, profile, inherited)).toEqual([]);
      expect(read()).toEqual({ toString: 'theirs' });
      expect(readdirSync(account).filter((name) => name.startsWith('state.json.own-'))).toEqual([]);
    });
  });
});
