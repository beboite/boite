import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scanBrain } from '../src/brain.ts';
import { BrainStore } from '../src/brain.ts';
import { connect } from '../src/client.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let root: string;
beforeEach(async () => { h = await startTestCore(); root = join(h.dataDir, 'brain'); mkdirSync(root); root = realpathSync(root); });
afterEach(async () => { await h.stop(); });
function file(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
async function git(cwd: string, args: string[]) {
  // Fixture commits must not depend on a developer's identity or signing config.
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'boite test', GIT_AUTHOR_EMAIL: 'test@boite.invalid',
    GIT_COMMITTER_NAME: 'boite test', GIT_COMMITTER_EMAIL: 'test@boite.invalid',
  };
  const p = h.core.procs.spawn('brain-test', 'git', args, { cwd, env });
  const [stdout, stderr, exit] = await Promise.all([new Response(p.proc.stdout).text(), new Response(p.proc.stderr).text(), p.exited]);
  if (exit) throw new Error(`git ${args[0]}: ${stderr}`);
  return stdout.trim();
}
async function commit(cwd: string, text: string, name = 'AGENTS.md') {
  file(join(cwd, name), text);
  await git(cwd, ['add', '--', name]);
  await git(cwd, ['commit', '-m', 'Update shared instructions']);
}

test('detects instructions, YAML skills and both plugin manifests; reports malformed entries', () => {
  file(join(root, 'AGENTS.md'), 'Follow project conventions.');
  file(join(root, '.agents/skills/review/SKILL.md'), '---\nname: review\ndescription: >-\n  Review changes\n  before release.\n---\nBody');
  file(join(root, 'skills/broken/SKILL.md'), 'Not a skill');
  file(join(root, 'plugins/editor/.claude-plugin/plugin.json'), '{"name":"editor","description":"Editor tools"}');
  file(join(root, 'plugins/build/.codex-plugin/plugin.json'), '{"name":"build"}');
  file(join(root, '.secrets/skills/private/SKILL.md'), 'not read');
  const result = scanBrain(root);
  expect(result.entries).toHaveLength(5);
  expect(result.entries.find(e => e.name === 'review')?.description).toBe('Review changes before release.');
  expect(result.entries.filter(e => e.kind === 'plugin')).toHaveLength(2);
  expect(result.entries.find(e => e.path.includes('broken'))?.error).toContain('frontmatter');
  expect(result.problems).toEqual([]);
});

test('junction cycles are bounded and outside catalog links are refused without reading their files', () => {
  mkdirSync(join(root, 'skills'));
  symlinkSync(root, join(root, 'skills/cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(join(h.dataDir, 'external'));
  file(join(h.dataDir, 'external/SKILL.md'), 'never read');
  symlinkSync(join(h.dataDir, 'external'), join(root, 'skills/external'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = scanBrain(root);
  expect(result.entries).toEqual([]);
  expect(result.problems.join()).toContain('outside the brain');
});

test('a brain reached through a directory alias has the same catalog', () => {
  file(join(root, 'AGENTS.md'), 'Shared conventions');
  file(join(root, 'skills/review/SKILL.md'), '---\nname: review\ndescription: Review changes.\n---\n');
  const alias = join(h.dataDir, 'brain-alias');
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect(scanBrain(alias)).toEqual(scanBrain(root));
});

test('owner configures, disables and disconnects the brain; invalid paths preserve the previous config', async () => {
  const owner = await h.connect();
  await expect(owner.call('brain.configure', { path: 'relative', enabled: true })).rejects.toThrow('absolute');
  const result = await owner.call('brain.configure', { path: root, enabled: true });
  expect(result.config).toEqual({ path: root, enabled: true });
  expect(result.git).toBeNull();
  await expect(owner.call('brain.configure', { path: join(root, 'missing'), enabled: true })).rejects.toThrow('existing');
  expect((await owner.call('brain.status', {})).config.path).toBe(root);
  await owner.call('brain.configure', { path: root, enabled: false });
  expect(h.core.brain.instructions()).toBe('');
  expect((await owner.call('brain.configure', { path: null, enabled: false })).entries).toEqual([]);
  const { grant } = await owner.call('pairing.grant', {});
  const device = await connect(h.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    for (const method of ['brain.status', 'brain.sync'] as const) await expect(device.call(method, {})).rejects.toThrow('owner');
    await expect(device.call('brain.configure', { path: root, enabled: true })).rejects.toThrow('owner');
  } finally { device.close(); }
});

test('normal turns receive current instructions and skill paths without changing the journalled prompt', async () => {
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  file(join(root, 'AGENTS.md'), 'Shared convention one');
  file(join(root, 'skills/review/SKILL.md'), '---\nname: review\ndescription: Review changes.\n---\nSkill body stays on disk');
  await owner.call('brain.configure', { path: root, enabled: true });
  const first = await owner.call('turns.start', { threadId, prompt: 'Hello' });
  await waitFor(() => h.core.journal.listTurns(threadId).find(t => t.id === first.id)?.status === 'done');
  const messages = h.core.journal.listMessages(threadId);
  expect(JSON.stringify(messages.filter(m => m.role === 'assistant'))).toContain('Shared convention one');
  expect(JSON.stringify(messages.filter(m => m.role === 'user'))).not.toContain('Shared convention');
  expect(h.core.brain.instructions()).toContain(join(root, 'skills/review/SKILL.md'));
  expect(h.core.brain.instructions()).not.toContain('Skill body stays on disk');
  file(join(root, 'AGENTS.md'), 'Shared convention two');
  expect(h.core.brain.instructions()).toContain('Shared convention two');
});

test('configuration persists across store instances; missing folders and oversized instructions are reported', async () => {
  file(join(root, 'AGENTS.md'), 'x'.repeat(65 * 1024));
  const configured = await h.core.brain.configure({ path: root, enabled: true });
  expect(configured.entries[0]?.error).toContain('at most');
  expect(() => h.core.brain.instructions()).toThrow('at most');
  const reopened = new BrainStore(h.core);
  expect(reopened.config()).toEqual({ path: root, enabled: true });
  renameSync(root, `${root}-moved`);
  expect((await reopened.status()).problems.length).toBeGreaterThan(0);
  expect(() => reopened.instructions()).toThrow();
  await reopened.close();
});

test('a missing upstream and a concurrent sync refuse without changing configuration', async () => {
  await git(root, ['init', '--initial-branch=main']);
  await commit(root, 'A convention');
  await h.core.brain.configure({ path: root, enabled: true });
  const first = h.core.brain.sync().catch(cause => cause as Error);
  const second = h.core.brain.sync().catch(cause => cause as Error);
  const configure = h.core.brain.configure({ path: null, enabled: false }).catch(cause => cause as Error);
  expect((await second as Error).message).toContain('already running');
  expect((await configure as Error).message).toContain('running');
  expect((await first as Error).message).toContain('upstream');
  expect(h.core.brain.config().path).toBe(root);
  expect((await h.core.brain.status()).lastSync).toBeNull();
});

test('closing the brain drains active Git and prevents subsequent commands', async () => {
  await git(root, ['init', '--initial-branch=main']);
  await commit(root, 'A convention');
  await h.core.brain.configure({ path: root, enabled: true });
  const operation = h.core.brain.sync().catch(cause => cause as Error);
  await h.core.brain.close();
  expect((await operation as Error).message).toContain('shutting down');
  await expect(h.core.brain.sync()).rejects.toThrow('shutting down');
});

test('two checkouts exchange existing commits; dirty and diverged histories remain untouched', async () => {
  const remote = join(h.dataDir, 'remote.git'), second = join(h.dataDir, 'second');
  await git(h.dataDir, ['init', '--bare', '--initial-branch=main', remote]);
  await git(root, ['init', '--initial-branch=main']);
  await commit(root, 'First convention');
  await git(root, ['remote', 'add', 'origin', remote]);
  await git(root, ['push', '-u', 'origin', 'main']);
  await git(h.dataDir, ['clone', remote, second]);
  await h.core.brain.configure({ path: root, enabled: true });
  await commit(second, 'Remote convention');
  await git(second, ['push']);
  let synced = await h.core.brain.sync();
  expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('Remote convention');
  expect(synced.git).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: false });
  expect(synced.lastSync).toBeNumber();
  await commit(root, 'Local convention');
  synced = await h.core.brain.sync();
  expect(synced.git?.ahead).toBe(0);
  await git(second, ['pull', '--ff-only']);
  expect(readFileSync(join(second, 'AGENTS.md'), 'utf8')).toBe('Local convention');
  file(join(root, 'untracked.txt'), 'Keep this');
  await expect(h.core.brain.sync()).rejects.toThrow('local file changes');
  expect(readFileSync(join(root, 'untracked.txt'), 'utf8')).toBe('Keep this');
  await git(root, ['add', 'untracked.txt']);
  await git(root, ['commit', '-m', 'Keep local notes']);
  await commit(second, 'Diverged remote');
  await git(second, ['push']);
  const before = await git(root, ['rev-parse', 'HEAD']);
  await expect(h.core.brain.sync()).rejects.toThrow('diverging');
  expect(await git(root, ['rev-parse', 'HEAD'])).toBe(before);
  expect((await h.core.brain.status()).git).toMatchObject({ ahead: 1, behind: 1, dirty: false });
}, 30_000);

test.each(['fetch', 'push'] as const)('switching branches during %s cannot publish the newly selected branch', async phase => {
  const remote = join(h.dataDir, 'remote.git');
  await git(h.dataDir, ['init', '--bare', '--initial-branch=main', remote]);
  await git(root, ['init', '--initial-branch=main']);
  await commit(root, 'Shared base');
  const base = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['remote', 'add', 'origin', remote]);
  await git(root, ['push', '-u', 'origin', 'main']);
  await git(root, ['switch', '-c', 'other']);
  await commit(root, 'Other branch only');
  await git(root, ['branch', '--set-upstream-to=origin/main']);
  await git(root, ['switch', 'main']);
  await commit(root, 'Main branch only');
  const mainHead = await git(root, ['rev-parse', 'HEAD']);
  await h.core.brain.configure({ path: root, enabled: true });
  // Use real repositories while placing an external checkout at the fetch boundary.
  const runner = h.core.brain as unknown as { git(path: string, args: string[]): Promise<string> };
  const original = runner.git.bind(runner);
  const intercepted = spyOn(runner, 'git').mockImplementation(async (path, args) => {
    if (phase === 'push' && args[0] === 'push') await git(root, ['switch', 'other']);
    const result = await original(path, args);
    if (phase === 'fetch' && args[0] === 'fetch') await git(root, ['switch', 'other']);
    return result;
  });
  try {
    if (phase === 'fetch') await expect(h.core.brain.sync()).rejects.toThrow('changed during synchronization');
    else await h.core.brain.sync();
    expect(await git(remote, ['rev-parse', 'main'])).toBe(phase === 'fetch' ? base : mainHead);
    expect(await git(root, ['branch', '--show-current'])).toBe('other');
  } finally { intercepted.mockRestore(); }
}, 30_000);
