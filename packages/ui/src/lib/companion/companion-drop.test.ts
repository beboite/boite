/*
 * Files dropped on the companion and the threads it launches for
 * `[[task: …]]` lines: the core's attachment caps checked as the files come,
 * the project a name means, what a new thread runs on, and the launch itself
 * against the fake core.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, type Attachment, type Project } from '@boite/contracts';
import { FakeClient } from '../fake-client';
import { INITIAL_MODEL_DEFAULTS } from '../model-defaults';
import { defaultPrefs, PREFS_STORAGE_KEY } from '../prefs';
import { messageFor, roleBlock } from './brain';
import { parseDirectives, visibleReply } from './directives';
import { gatherDropped, joinScreen, type Encode } from './drop.svelte';
import { newThreadChoice, resolveProject } from './tasks';
import { Tasks, unknownLine } from './tasks.svelte';

afterEach(() => window.localStorage.clear());

async function connected(): Promise<FakeClient> {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  return client;
}

/** An attachment of about `bytes` decoded bytes. */
const held = (bytes: number, name = 'held.txt'): Attachment => ({ kind: 'file', mimeType: 'text/plain', data: 'A'.repeat(Math.ceil(bytes / 3) * 4), name });
const textFile = (name: string, size = 12) => new File([new Uint8Array(size).fill(65)], name, { type: 'text/plain' });

// ---------------------------------------------------------------------------
// Dropping files
// ---------------------------------------------------------------------------

test('a dropped file is read whole; an image goes through the encoder under the room left', async () => {
  const budgets: number[] = [];
  const encode: Encode = async (file, budget) => {
    budgets.push(budget);
    return { kind: 'image', mimeType: 'image/jpeg', data: 'QUJD', name: file.name.replace(/\.png$/, '.jpg') };
  };
  const image = new File([new Uint8Array(64)], 'shot.png', { type: 'image/png' });
  const { held: kept, refused } = await gatherDropped([textFile('notes.txt'), image], [], encode);
  expect(refused).toBeNull();
  expect(kept).toMatchObject([{ kind: 'file', name: 'notes.txt', mimeType: 'text/plain' }, { kind: 'image', mimeType: 'image/jpeg', name: 'shot.jpg' }]);
  expect(budgets).toEqual([Math.min(ATTACHMENT_MAX_BYTES, ATTACHMENTS_TOTAL_MAX_BYTES - 12)]);
});

test('an image the encoder cannot make lighter goes as the file it is', async () => {
  const image = new File([new Uint8Array(32)], 'tiny.png', { type: 'image/png' });
  const { held: kept } = await gatherDropped([image], [], async () => null);
  expect(kept).toMatchObject([{ kind: 'image', mimeType: 'image/png', name: 'tiny.png' }]);
});

test('each cap is said by name, and the files that fit still come', async () => {
  const big = new File([new Uint8Array(ATTACHMENT_MAX_BYTES + 1)], 'huge.bin');
  const tooBig = await gatherDropped([big, textFile('small.txt')], [], async () => null);
  expect(tooBig.refused).toContain('huge.bin');
  expect(tooBig.held.map((file) => file.name)).toEqual(['small.txt']);

  const full = Array.from({ length: ATTACHMENTS_PER_TURN }, (_, index) => held(3, `f${index}`));
  const tooMany = await gatherDropped([textFile('one-more.txt')], full, async () => null);
  expect(tooMany.refused).toContain('one-more.txt');
  expect(tooMany.held).toHaveLength(ATTACHMENTS_PER_TURN);

  const heavy = [held(ATTACHMENTS_TOTAL_MAX_BYTES - 1000)];
  const tooHeavy = await gatherDropped([textFile('last.txt', 2000)], heavy, async () => null);
  expect(tooHeavy.refused).toContain('last.txt');
  expect(tooHeavy.held).toEqual(heavy);
});

test('the screen goes after the dropped files, unless the two together pass a cap', () => {
  const files = [held(3, 'a.txt')];
  const shot = { images: [{ kind: 'image' as const, mimeType: 'image/jpeg' as const, data: 'QUJD', name: 'screen.jpg' }], seen: { kind: 'screen' as const } };
  expect(joinScreen(files, null)).toEqual(files);
  expect(joinScreen(files, shot)).toEqual([...files, ...shot.images]);
  expect(typeof joinScreen([held(ATTACHMENTS_TOTAL_MAX_BYTES - 1)], shot)).toBe('string');
});

test('the request names where the dropped files are kept, and the history still shows the words alone', () => {
  const message = messageFor('What is in these?', { now: new Date(2026, 9, 9, 14, 5), seen: null, shots: [], files: ['C:\\kept\\plan.pdf', 'C:\\kept\\odd]name.png'] });
  expect(message).toContain('files the user dropped on you: C:\\kept\\plan.pdf, C:\\kept\\odd name.png]]');
  expect(visibleReply(message)).toBe('What is in these?');
});

// ---------------------------------------------------------------------------
// Launching threads
// ---------------------------------------------------------------------------

test('[[task: project | instruction]] is read, the bars after the first kept in the instruction, and never shown', () => {
  const reply = 'Handing it over.\n[[task: boite | Fix the typo in README | then run the tests]]\n[[task: notes]]\n[[task: | nothing]]';
  expect(parseDirectives(reply, new Date()).task).toEqual([{ project: 'boite', prompt: 'Fix the typo in README | then run the tests' }]);
  expect(visibleReply(reply)).toBe('Handing it over.');
  const many = Array.from({ length: 5 }, (_, index) => `[[task: boite | job ${index}]]`).join('\n');
  expect(parseDirectives(many, new Date()).task).toHaveLength(3);
});

test('the role names the projects and how to hand one a task', () => {
  const block = roleBlock(['boite', 'notes']);
  expect(block).toContain("Boite's projects: boite, notes.");
  expect(block).toContain('[[task: PROJECT | INSTRUCTION]]');
});

const project = (id: string, name: string, extra: Partial<Project> = {}): Project => ({ id, name, path: `C:\\src\\${id}`, createdAt: 0, ...extra });
const PROJECTS = [
  project('p1', 'Boite'),
  project('p2', 'Boite-Compagnon'),
  project('p3', 'Unity Game'),
  project('p4', 'Old', { archived: true }),
  project('p5', 'Drafts', { kind: 'drafts' })
];
const resolved = (name: string) => {
  const result = resolveProject(name, PROJECTS);
  return 'project' in result ? result.project.id : result.near;
};

test('a project is found by its name with case, accents and typos aside, and only when one is sure', () => {
  expect(resolved('boite')).toBe('p1');
  expect(resolved('BOÎTE')).toBe('p1');
  expect(resolved('compagnon')).toBe('p2');
  expect(resolved('unity')).toBe('p3');
  expect(resolved('unity gaem')).toBe('p3');
  expect(resolved('bote')).toBe('p1');
  expect(resolved('boi')).toEqual(['Boite', 'Boite-Compagnon']);
  expect(resolved('Old')).toEqual([]);
  expect(resolved('drafts')).toEqual([]);
  expect(resolved('  ')).toEqual([]);
});

test('an unknown project is said with the names near it, or the projects there are', () => {
  expect(unknownLine('boi', ['Boite', 'Boite-Compagnon'], PROJECTS)).toBe('I do not know a project called "boi". Did you mean Boite, Boite-Compagnon?');
  expect(unknownLine('zzz', [], PROJECTS)).toBe('I do not know a project called "zzz". Your projects: Boite, Boite-Compagnon, Unity Game.');
  expect(unknownLine('zzz', [], [PROJECTS[4]!])).toBe('Boite has no project to launch a thread in yet.');
});

test('a new thread runs on what the main window opens a new prompt on', async () => {
  const client = await connected();
  const [{ loaded: providers }, accounts] = await Promise.all([client.call('providers.list', {}), client.call('accounts.list', {})]);
  // Nothing remembered: the first agent on with an account, its signed-in account, the built-in default model.
  expect(newThreadChoice(providers, accounts, null, defaultPrefs(), {})).toMatchObject({
    providerId: 'claude',
    accountId: 'a-claude-main',
    model: INITIAL_MODEL_DEFAULTS.claude!.model,
    effort: INITIAL_MODEL_DEFAULTS.claude!.effort,
    permissionMode: 'default'
  });
  // The agent, account and mode the composer remembers, and the model set in Settings.
  const prefs = { ...defaultPrefs(), providerId: 'echo', accountId: 'a-echo', permissionMode: 'acceptEdits' as const };
  expect(newThreadChoice(providers, accounts, null, prefs, {})).toMatchObject({ providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: 'high', permissionMode: 'acceptEdits' });
  expect(newThreadChoice(providers, accounts, null, prefs, { echo: { model: 'echo-1', effort: 'low' } })).toMatchObject({ model: 'echo-1', effort: 'low' });
  // A remembered agent that is gone falls back to the first one.
  expect(newThreadChoice(providers, accounts, null, { ...defaultPrefs(), providerId: 'gone' }, {})?.providerId).toBe('claude');
  expect(newThreadChoice(providers, [], null, defaultPrefs(), {})).toBeNull();
});

type Call = [string, Record<string, unknown>];

function tasksOn(client: FakeClient, control: 'ask' | 'auto') {
  const say = vi.fn();
  const created = vi.fn();
  const spy = vi.spyOn(client, 'call');
  const calls = () => spy.mock.calls as unknown as Call[];
  return { tasks: new Tasks({ client: () => client, control: () => control, created, say }), say, created, calls };
}

test('asking before acting, a task waits on a card, then launches a thread in its project with the instruction', async () => {
  const client = await connected();
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ ...defaultPrefs(), providerId: 'echo', accountId: 'a-echo' }));
  const { tasks, say, created, calls } = tasksOn(client, 'ask');

  await tasks.request([{ project: 'Boîte', prompt: 'Fix the typo in the README' }]);
  expect(tasks.pending).toMatchObject([{ projectId: 'p-boite', project: 'boite', prompt: 'Fix the typo in the README' }]);
  expect(calls().some(([method]) => method === 'threads.create')).toBe(false);

  await tasks.confirm(tasks.pending[0]!.id);
  expect(tasks.pending).toEqual([]);
  const create = calls().find(([method]) => method === 'threads.create')![1];
  expect(create).toMatchObject({ projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', title: 'Fix the typo in the README', permissionMode: 'default' });
  expect(create.worktree).toBeUndefined();
  const thread = created.mock.calls[0]![0] as { id: string; projectId: string };
  expect(thread.projectId).toBe('p-boite');
  expect(calls().find(([method]) => method === 'turns.start')![1]).toEqual({ threadId: thread.id, prompt: 'Fix the typo in the README' });
  expect(tasks.launched).toMatchObject([{ threadId: thread.id, project: 'boite' }]);
  expect(say).not.toHaveBeenCalled();

  tasks.finished([thread.id]);
  expect(tasks.launched).toEqual([]);
});

test('a cancelled task launches nothing', async () => {
  const client = await connected();
  const { tasks, calls } = tasksOn(client, 'ask');
  await tasks.request([{ project: 'notes', prompt: 'Tidy up' }]);
  tasks.cancel(tasks.pending[0]!.id);
  expect(tasks.pending).toEqual([]);
  expect(calls().some(([method]) => method === 'threads.create')).toBe(false);
});

test('acting without asking, a task goes at once, and a project nobody knows is said in the bubble', async () => {
  const client = await connected();
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ ...defaultPrefs(), providerId: 'echo', accountId: 'a-echo' }));
  const { tasks, say, calls } = tasksOn(client, 'auto');
  await tasks.request([{ project: 'note', prompt: 'Sum up this week' }, { project: 'zzz', prompt: 'Anything' }]);
  expect(tasks.pending).toEqual([]);
  expect(calls().find(([method]) => method === 'threads.create')![1]).toMatchObject({ projectId: 'p-notes' });
  expect(tasks.launched).toMatchObject([{ project: 'notes' }]);
  expect(say).toHaveBeenCalledWith('I do not know a project called "zzz". Your projects: boite, notes.');
});
