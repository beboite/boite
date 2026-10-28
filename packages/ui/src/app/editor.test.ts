import { expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { confirm } from '../lib/confirm.svelte';
import { store } from '../lib/store.svelte';
import { openWorkbench, query, test, treePaths, type, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('the file tree lists the root, expands a directory on click and opens a file on its own tab', async () => {
  await openWorkbench();
  store.panel.openFiles();
  await waitFor(() => document.querySelectorAll('[data-testid=files-row]').length > 0);

  // Directories first, then files, the order the core answers in.
  expect(treePaths()).toEqual(['assets', 'docs', 'src', 'tests', 'package.json', 'README.md']);
  // A size sits on a file and on nothing else.
  expect(query('[data-testid=files-row][data-path="README.md"] [data-testid=files-size]')).not.toBeNull();
  expect(query('[data-testid=files-row][data-path="docs"]').querySelector('[data-testid=files-size]')).toBeNull();

  // Nothing under a directory is read before it opens.
  expect(document.querySelector('[data-testid=files-row][data-path="docs/panel.md"]')).toBeNull();
  query<HTMLButtonElement>('[data-testid=files-row][data-path="docs"]').click();
  await waitFor(() => document.querySelector('[data-testid=files-row][data-path="docs/guide"]') !== null);
  expect(treePaths().slice(0, 5)).toEqual(['assets', 'docs', 'docs/guide', 'docs/panel.md', 'docs/panel.svg']);
  expect(query('[data-testid=files-row][data-path="docs/panel.md"]').getAttribute('data-depth')).toBe('1');
  expect(query('[data-testid=files-row][data-path="docs"]').getAttribute('aria-expanded')).toBe('true');

  // A third level, so the tree is a tree and not one nesting.
  query<HTMLButtonElement>('[data-testid=files-row][data-path="docs/guide"]').click();
  await waitFor(() => document.querySelector('[data-testid=files-row][data-path="docs/guide/editor.md"]') !== null);
  expect(query('[data-testid=files-row][data-path="docs/guide/editor.md"]').getAttribute('data-depth')).toBe('2');

  // The filter narrows the loaded rows and keeps the directories above a match.
  const filter = query<HTMLInputElement>('[data-testid=files-filter]');
  await type(filter, 'editor');
  await waitFor(() => treePaths().length === 3);
  expect(treePaths()).toEqual(['docs', 'docs/guide', 'docs/guide/editor.md']);
  await type(filter, '');
  await waitFor(() => treePaths().length > 3);

  // A file click opens a tab of its own, named after the file.
  query<HTMLButtonElement>('[data-testid=files-row][data-path="docs/panel.md"]').click();
  await waitFor(() => store.panel.active?.kind === 'file');
  expect(store.panel.active?.path).toBe('docs/panel.md');
  await waitFor(() => document.querySelector('[data-testid=file-panel]') !== null);
  expect(document.querySelectorAll('[data-testid=panel-tab]').length).toBe(2);
});

test('the tree of one thread is not shown for the next: a thread switch starts it over', async ({ app: _app }) => {
  await waitFor(() => document.querySelector('[data-thread-id="t-bench"]') !== null);
  // Both threads keep the tree as their active tab, so the surface is never
  // remounted between them and only its own reset can empty it.
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');
  store.panel.closeAll();
  store.panel.openFiles();
  await waitFor(() => treePaths().length > 0);

  query<HTMLButtonElement>('[data-thread-id="t-bench"]').click();
  await waitFor(() => store.openThread?.id === 't-bench');
  store.panel.closeAll();
  store.panel.openFiles();
  await waitFor(() => treePaths().length > 0);
  query<HTMLButtonElement>('[data-testid=files-row][data-path="docs"]').click();
  await waitFor(() => treePaths().includes('docs/panel.md'));

  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');
  await waitFor(() => treePaths().length > 0 && !treePaths().includes('docs/panel.md'));
  expect(query('[data-testid=files-row][data-path="docs"]').getAttribute('aria-expanded')).toBe('false');

  store.panel.closeAll();
  query<HTMLButtonElement>('[data-thread-id="t-bench"]').click();
  await waitFor(() => store.openThread?.id === 't-bench');
  store.panel.closeAll();
});

test('the editor shows the file, writes two spaces for a tab and saves what was typed', async () => {
  await openWorkbench();
  store.panel.openFile('src/lib/strings.ts');
  await waitFor(() => document.querySelector('[data-testid=file-text]') !== null);
  const area = query<HTMLTextAreaElement>('[data-testid=file-text]');
  await waitFor(() => area.value.includes("save: 'Save'"));

  // One gutter number per line, and the language the core named.
  expect(document.querySelectorAll('[data-testid=file-line]').length).toBe(area.value.split('\n').length);
  expect(query('[data-testid=file-language]').textContent).toBe('typescript');
  expect(document.querySelector('[data-testid=file-dirty]')).toBeNull();

  // Tab is two spaces in the text, not the next control.
  area.focus();
  area.setSelectionRange(0, 0);
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  area.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(true);
  await waitFor(() => query<HTMLTextAreaElement>('[data-testid=file-text]').value.startsWith('  export'));
  await waitFor(() => document.querySelector('[data-testid=file-dirty]') !== null);

  const edited = `${query<HTMLTextAreaElement>('[data-testid=file-text]').value}export const ready = true;\n`;
  area.value = edited;
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => query('[data-testid=file-save]').textContent?.includes('Save') === true);
  query<HTMLButtonElement>('[data-testid=file-save]').click();
  await waitFor(() => document.querySelector('[data-testid=file-dirty]') === null);

  // The bytes reached the fixture: a fresh read answers what was saved.
  const answer = await store.client!.call('files.read', { threadId: 't-trace', path: 'src/lib/strings.ts' });
  expect(answer.kind).toBe('text');
  expect(answer.kind === 'text' ? answer.text : '').toBe(edited);
});

test('an unsaved edit survives a tab switch, and closing its tab asks before it is lost', async () => {
  await openWorkbench();
  const file = store.panel.openFile('README.md');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value.includes('# boite') === true);
  const area = query<HTMLTextAreaElement>('[data-testid=file-text]');
  const edited = `${area.value}An edit nobody saved.
`;
  area.value = edited;
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.querySelector('[data-testid=file-dirty]') !== null);

  // Another tab unmounts the editor, and coming back used to read the disk again.
  store.panel.openTasks();
  await waitFor(() => document.querySelector('[data-testid=file-text]') === null);
  store.panel.activate(file.id);
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value === edited);
  expect(document.querySelector('[data-testid=file-dirty]')).not.toBeNull();

  // Closing the tab asks first, and Cancel keeps the tab and the edit.
  const closer = `[data-testid=panel-tab][data-surface-id="${file.id}"] [data-testid=panel-tab-close]`;
  query<HTMLButtonElement>(closer).click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') !== null);
  expect(query('#confirm-title').textContent).toBe('Close README.md without saving?');
  query<HTMLButtonElement>('[data-testid=confirm-cancel]').click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') === null);
  expect(store.panel.surfaces.some((surface) => surface.id === file.id)).toBe(true);
  expect(store.panel.draft(file.id)).toBe(edited);

  // Confirming closes it and drops the edit, so the file reopens on the disk's text.
  query<HTMLButtonElement>(closer).click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') !== null);
  query<HTMLButtonElement>('[data-testid=confirm-ok]').click();
  await waitFor(() => !store.panel.surfaces.some((surface) => surface.id === file.id));
  expect(store.panel.draft(file.id)).toBeUndefined();
  store.panel.openFile('README.md');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value.includes('# boite') === true);
  expect(query<HTMLTextAreaElement>('[data-testid=file-text]').value).not.toContain('An edit nobody saved.');
  expect(document.querySelector('[data-testid=file-dirty]')).toBeNull();
  store.panel.closeAll();
});

test('a key typed while a save is out stays unsaved and survives a tab switch', async () => {
  await openWorkbench();
  const file = store.panel.openFile('docs/guide/tree.md');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value.includes('# The tree') === true);
  const area = query<HTMLTextAreaElement>('[data-testid=file-text]');
  const sent = `${area.value}Saved.\n`;
  area.value = sent;
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.querySelector<HTMLButtonElement>('[data-testid=file-save]')?.disabled === false);

  // The click sends the text; the next key lands before the write answers.
  query<HTMLButtonElement>('[data-testid=file-save]').click();
  flushSync();
  expect(query('[data-testid=file-save]').textContent).toContain('Saving');
  const newer = `${sent}Typed during the save.\n`;
  area.value = newer;
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => query('[data-testid=file-save]').textContent?.includes('Saving') === false);

  // The disk has what was sent, and the newer key is still a draft with its dot.
  const disk = await store.client!.call('files.read', { threadId: 't-trace', path: 'docs/guide/tree.md' });
  expect(disk.kind === 'text' ? disk.text : '').toBe(sent);
  expect(document.querySelector('[data-testid=file-dirty]')).not.toBeNull();
  expect(store.panel.draft(file.id)).toBe(newer);
  store.panel.openTasks();
  await waitFor(() => document.querySelector('[data-testid=file-text]') === null);
  store.panel.activate(file.id);
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value === newer);
  store.panel.keepDraft(file.id, null);
  store.panel.closeAll();
});

/**
 * Holds each file write on its own gate. `release(index)` lets the write sent
 * in that order through, `releaseAll()` every one, and both resolve once the
 * editors have handled the answers.
 */
function gateWrites(): { release(index: number): Promise<void>; releaseAll(): Promise<void>; releaseReversed(): Promise<void> } {
  const client = store.client!, real = client.call.bind(client);
  const gates: Array<{ open: () => void; answer: Promise<unknown> }> = [];
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method !== 'files.write') return real(method as never, params as never);
    let open!: () => void;
    const held = new Promise<void>(resolve => { open = resolve; });
    const answer = held.then(() => real(method as never, params as never));
    gates.push({ open, answer });
    return answer;
  }) as never);
  const through = async (some: typeof gates) => {
    for (const gate of some) gate.open();
    await Promise.allSettled(some.map(gate => gate.answer));
    // The editor's own continuation after its awaited write.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    flushSync();
  };
  // The newest held write reaches the disk first, each one finished before the
  // next starts, until no write is left: the order a core may run them in.
  const releaseReversed = async () => {
    let opened = 0;
    while (opened < gates.length) {
      const fresh = gates.slice(opened).reverse();
      opened = gates.length;
      for (const gate of fresh) await through([gate]);
    }
  };
  return { release: index => through([gates[index]!]), releaseAll: () => through(gates), releaseReversed };
}

/** Holds every file write until `release`, which resolves once the held writes have answered their editors. */
function holdWrites(): () => Promise<void> {
  const gates = gateWrites();
  return () => gates.releaseAll();
}

async function edit(text: string): Promise<void> {
  const area = query<HTMLTextAreaElement>('[data-testid=file-text]');
  area.value = text;
  area.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

test('a save that answers after its editor closed keeps the edit a newer editor made since', async () => {
  await openWorkbench();
  const file = store.panel.openFile('docs/guide/tree.md');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value.includes('# The tree') === true);
  const release = holdWrites();
  const sent = `${query<HTMLTextAreaElement>('[data-testid=file-text]').value}Saved.\n`;
  await edit(sent);
  await waitFor(() => document.querySelector<HTMLButtonElement>('[data-testid=file-save]')?.disabled === false);
  query<HTMLButtonElement>('[data-testid=file-save]').click();
  flushSync();

  // The tab switch unmounts the editor with its save still out; the one mounted next types on.
  store.panel.openTasks();
  await waitFor(() => document.querySelector('[data-testid=file-text]') === null);
  store.panel.activate(file.id);
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value === sent);
  const newer = `${sent}Typed in the next editor.\n`;
  await edit(newer);
  await release();
  const written = await store.client!.call('files.read', { threadId: 't-trace', path: 'docs/guide/tree.md' });
  expect(written.kind === 'text' && written.text).toBe(sent);
  expect(store.panel.draft(file.id)).toBe(newer);
  store.panel.openTasks();
  await waitFor(() => document.querySelector('[data-testid=file-text]') === null);
  store.panel.activate(file.id);
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value === newer);
  store.panel.keepDraft(file.id, null);
  store.panel.closeAll();
});

/** The tab goes to Tasks and back, so the file's editor is a new one. */
async function remount(id: string, text: string): Promise<void> {
  store.panel.openTasks();
  await waitFor(() => document.querySelector('[data-testid=file-text]') === null);
  store.panel.activate(id);
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value === text);
}

async function clickSave(): Promise<void> {
  await waitFor(() => document.querySelector<HTMLButtonElement>('[data-testid=file-save]')?.disabled === false);
  query<HTMLButtonElement>('[data-testid=file-save]').click();
  flushSync();
}

async function saveHeld(): Promise<() => Promise<void>> {
  const release = holdWrites();
  await clickSave();
  return release;
}

async function openTree(): Promise<{ id: string; original: string }> {
  await openWorkbench();
  const file = store.panel.openFile('docs/guide/tree.md');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value.includes('# The tree') === true);
  return { id: file.id, original: query<HTMLTextAreaElement>('[data-testid=file-text]').value };
}

async function diskOf(path: string): Promise<string | false> {
  const read = await store.client!.call('files.read', { threadId: 't-trace', path });
  return read.kind === 'text' && read.text;
}

test('the answer to one save leaves the newest draft while a later save of the file is still out', async () => {
  const { id, original } = await openTree();
  const writes = gateWrites();
  const first = `${original}First save.\n`;
  await edit(first);
  await clickSave();
  await remount(id, first);
  const second = `${original}Second save.\n`;
  await edit(second);
  await clickSave();
  // Back to the first save's text while both writes are out: the newest text the user wants.
  await edit(first);
  await writes.release(0);
  await writes.release(1);
  vi.restoreAllMocks();
  expect(await diskOf('docs/guide/tree.md')).toBe(second);
  expect(store.panel.draft(id)).toBe(first);
  await remount(id, first);
  store.panel.keepDraft(id, null);
  store.panel.closeAll();
});

test('a file has one write out at a time: the newer save leaves once the older answered, whatever order a core would run them in', async () => {
  const { id, original } = await openTree();
  const writes = gateWrites();
  const older = `${original}Older save.\n`;
  await edit(older);
  await clickSave();
  await remount(id, older);
  const newer = `${original}Newer save.\n`;
  await edit(newer);
  await clickSave();
  await writes.releaseReversed();
  vi.restoreAllMocks();
  expect(await diskOf('docs/guide/tree.md')).toBe(newer);
  expect(store.panel.disk('docs/guide/tree.md')).toBe(newer);
  expect(store.panel.draft(id)).toBeUndefined();
  await remount(id, newer);
  store.panel.closeAll();
});

test('an editor\'s read that answers after its replacement read a newer disk never takes the disk back', async () => {
  const { id, original } = await openTree();
  const path = 'docs/guide/tree.md';
  const external = `${original}Changed by the agent while the first read was out.\n`;
  // The first editor's read sees the disk before the agent's change, and its answer is held.
  const real = store.readFile.bind(store);
  let answer!: () => void;
  const held = new Promise<void>(resolve => { answer = resolve; });
  let calls = 0, captured = false;
  vi.spyOn(store, 'readFile').mockImplementation(async (...args) => {
    const snapshot = await real(...args);
    if (++calls === 1) { captured = true; await held; }
    return snapshot;
  });
  store.panel.openTasks();
  await waitFor(() => document.querySelector('[data-testid=file-text]') === null);
  store.panel.activate(id);
  await waitFor(() => captured);
  store.panel.openTasks();
  await waitFor(() => document.querySelector('[data-testid=file-text]') === null);
  await store.client!.call('files.write', { threadId: 't-trace', path, text: external });
  await remount(id, external);
  answer();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  flushSync();
  vi.restoreAllMocks();
  expect(await diskOf(path)).toBe(external);
  expect(query<HTMLTextAreaElement>('[data-testid=file-text]').value).toBe(external);
  expect(document.querySelector('[data-testid=file-dirty]')).toBeNull();
  await store.client!.call('files.write', { threadId: 't-trace', path, text: original });
  store.panel.closeAll();
});

test('a read that left while a save was out never takes the disk back once that save answered', async () => {
  const { id, original } = await openTree();
  const sent = `${original}Saved under a read.\n`;
  await edit(sent);
  const release = await saveHeld();
  // The next editor's read sees the disk before the write, and its answer is held past the write's.
  const real = store.readFile.bind(store);
  let answer!: () => void;
  const held = new Promise<void>(resolve => { answer = resolve; });
  vi.spyOn(store, 'readFile').mockImplementation(async (...args) => {
    const snapshot = await real(...args);
    await held;
    return snapshot;
  });
  store.panel.openTasks();
  await waitFor(() => document.querySelector('[data-testid=file-text]') === null);
  store.panel.activate(id);
  flushSync();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await release();
  answer();
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]') !== null);
  vi.restoreAllMocks();
  expect(await diskOf('docs/guide/tree.md')).toBe(sent);
  expect(query<HTMLTextAreaElement>('[data-testid=file-text]').value).toBe(sent);
  expect(store.panel.draft(id)).toBeUndefined();
  expect(document.querySelector('[data-testid=file-dirty]')).toBeNull();
  store.panel.closeAll();
});

test('a save still out when its tab closes stays the file\'s: the tab reopened on it keeps the old disk text as an edit', async () => {
  const { id, original } = await openTree();
  const sent = `${original}Saved from a closed tab.\n`;
  await edit(sent);
  const release = await saveHeld();
  const closer = `[data-testid=panel-tab][data-surface-id="${id}"] [data-testid=panel-tab-close]`;
  query<HTMLButtonElement>(closer).click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') !== null);
  query<HTMLButtonElement>('[data-testid=confirm-ok]').click();
  await waitFor(() => !store.panel.surfaces.some((surface) => surface.id === id));

  store.panel.openFile('docs/guide/tree.md');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value === original);
  await edit(`${original}Typed in the reopened tab.\n`);
  await edit(original);
  await release();
  vi.restoreAllMocks();
  expect(await diskOf('docs/guide/tree.md')).toBe(sent);
  expect(store.panel.draft(id)).toBe(original);
  expect(document.querySelector('[data-testid=file-dirty]')).not.toBeNull();
  await remount(id, original);
  store.panel.keepDraft(id, null);
  store.panel.closeAll();
});

test('an editor mounted while a save is out keeps the old disk text as an edit, typed before or after the save answers', async () => {
  await openWorkbench();
  const file = store.panel.openFile('docs/guide/tree.md');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value.includes('# The tree') === true);
  const original = query<HTMLTextAreaElement>('[data-testid=file-text]').value;
  const sent = `${original}Saved from A.\n`;
  await edit(sent);
  let release = await saveHeld();

  // Undone back to the disk it read, before the save answers: once it does, that is an edit.
  await remount(file.id, sent);
  await edit(original);
  await release();
  vi.restoreAllMocks();
  expect(store.panel.draft(file.id)).toBe(original);
  expect(document.querySelector('[data-testid=file-dirty]')).not.toBeNull();
  await remount(file.id, original);

  // Typed back to the disk it read after the save answered: still an edit.
  release = await saveHeld();
  await remount(file.id, original);
  await edit(`${original}Elsewhere.\n`);
  await release();
  vi.restoreAllMocks();
  await edit(sent);
  expect(store.panel.draft(file.id)).toBe(sent);
  expect(document.querySelector('[data-testid=file-dirty]')).not.toBeNull();
  await remount(file.id, sent);
  store.panel.keepDraft(file.id, null);
  store.panel.closeAll();
});

test('the same path in two threads is two editors: a save in one never turns the text of the other into its draft', async () => {
  await openWorkbench();
  // Another thread on the same folder already shows the file on its active tab.
  await store.open('t-bench');
  store.panel.openFile('docs/guide/editor.md');
  await waitFor(() => (document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value.length ?? 0) > 0);
  await store.open('t-trace');
  const file = store.panel.openFile('docs/guide/editor.md');
  await waitFor(() => (document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value.length ?? 0) > 0);
  const disk = query<HTMLTextAreaElement>('[data-testid=file-text]').value;
  const release = holdWrites();
  const sent = `${disk}From the trace thread.\n`;
  await edit(sent);
  await waitFor(() => document.querySelector<HTMLButtonElement>('[data-testid=file-save]')?.disabled === false);
  query<HTMLButtonElement>('[data-testid=file-save]').click();
  flushSync();

  // That thread comes back and is typed into before the save answers.
  await store.open('t-bench');
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value === disk);
  const other = `${disk}From the bench thread.\n`;
  await edit(other);
  await release();
  expect(store.panel.draft(file.id)).toBe(other);
  store.panel.keepDraft(file.id, null);
  store.panel.closeAll();

  await store.open('t-trace');
  // The trace thread's save landed: nothing of the bench thread became its draft.
  expect(store.panel.draft(file.id)).toBeUndefined();
  await waitFor(() => document.querySelector<HTMLTextAreaElement>('[data-testid=file-text]')?.value === sent);
  store.panel.closeAll();
});

test('the image viewer measures the picture and the zoom buttons move the percentage', async () => {
  await openWorkbench();
  store.panel.openFile('assets/preview.png');
  await waitFor(() => document.querySelector('[data-testid=file-image]') !== null);

  // jsdom fetches no picture, so the size a browser would report is declared here.
  const picture = query<HTMLImageElement>('[data-testid=file-image]');
  Object.defineProperty(picture, 'naturalWidth', { value: 640, configurable: true });
  Object.defineProperty(picture, 'naturalHeight', { value: 400, configurable: true });
  picture.dispatchEvent(new Event('load'));
  await waitFor(() => document.querySelector('[data-testid=file-natural]') !== null);
  expect(query('[data-testid=file-natural]').textContent?.trim()).toBe('640 x 400');
  // Nothing is laid out here, so the fit lands on the picture's own size.
  expect(query('[data-testid=file-zoom]').textContent).toBe('100%');

  query<HTMLButtonElement>('[data-testid=file-zoom-in]').click();
  await waitFor(() => query('[data-testid=file-zoom]').textContent === '125%');
  query<HTMLButtonElement>('[data-testid=file-zoom-in]').click();
  await waitFor(() => query('[data-testid=file-zoom]').textContent === '156%');
  query<HTMLButtonElement>('[data-testid=file-actual]').click();
  await waitFor(() => query('[data-testid=file-zoom]').textContent === '100%');
  // A picture is not text: it has no save and no gutter.
  expect(document.querySelector('[data-testid=file-save]')).toBeNull();
  expect(document.querySelector('[data-testid=file-text]')).toBeNull();
});

test('a file the agent opens at a line lands on that line, and asking again moves the same tab', async () => {
  await openWorkbench();

  // `panel.requested` is what the core emits for the `boite` CLI's `panel.open`.
  await store.client!.call('panel.open', {
    threadId: 't-trace',
    surface: { kind: 'file', path: 'src/lib/store.svelte.ts', line: 42 }
  });
  await waitFor(() => document.querySelector('[data-testid=file-highlight]') !== null);
  expect(query('[data-testid=file-highlight]').getAttribute('data-line')).toBe('42');
  expect(query('[data-testid=file-line][data-line="42"]').classList.contains('on')).toBe(true);
  expect(store.panel.surfaces.length).toBe(1);

  // The same file again moves the tab it already has rather than opening a second.
  await store.client!.call('panel.open', {
    threadId: 't-trace',
    surface: { kind: 'file', path: 'src/lib/store.svelte.ts', line: 7 }
  });
  await waitFor(() => query('[data-testid=file-highlight]').getAttribute('data-line') === '7');
  expect(query('[data-testid=file-line][data-line="7"]').classList.contains('on')).toBe(true);
  expect(store.panel.surfaces.length).toBe(1);
});
