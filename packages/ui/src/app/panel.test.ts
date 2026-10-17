import { expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { store } from '../lib/store.svelte';
import { work } from '../lib/work-prefs.svelte';
import { rightPanel } from '../lib/right-panel.svelte';
import { count } from '../lib/format';
import { mountOnFake, query, test, type, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('a floating panel can dock after leaving or closing its browser tab and changing threads', async ({ app: _app }) => {
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');
  store.panel.open('browser', 'https://example.test');
  const browser = store.panel.active!.id;
  rightPanel.floating = true;
  store.panel.openTasks();
  await waitFor(() => document.querySelector('[data-testid=panel-dock]') !== null);
  store.panel.close(browser);
  flushSync();
  expect(document.querySelector('[data-testid=browser-slot]')).toBeNull();
  query<HTMLButtonElement>('[data-testid=panel-dock]').click();
  flushSync();
  expect(rightPanel.floating).toBe(false);
  expect(document.querySelector('[data-testid=panel-dock]')).toBeNull();
  rightPanel.floating = true;
  const other = store.threads.find(thread => thread.id !== 't-trace' && !thread.archived)!;
  await store.open(other.id);
  store.panel.openTasks();
  await waitFor(() => document.querySelector('[data-testid=panel-dock]') !== null);
  rightPanel.maximized = true;
  query<HTMLButtonElement>('[data-testid=panel-dock]').click();
  expect(rightPanel.floating).toBe(false);
  expect(rightPanel.maximized).toBe(false);
});

test("a header button's right click hides it, and the Appearance page brings it back", async () => {
  work.showPreset('developer');
  // With a team on the thread, since Team shows only where there is one.
  await mountOnFake('/?fake=1&team=1');
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => document.querySelector('[data-testid=terminal-toggle]') !== null);

  query('[data-testid=terminal-toggle]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 30 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=hide]').click();
  await waitFor(() => document.querySelector('[data-testid=terminal-toggle]') === null);
  expect(work.current.hidden).toEqual(['header.terminal']);

  // The same menu, on another button, leads to the page that lists them all.
  await waitFor(() => document.querySelector('.context-control') !== null);
  query('.context-control').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 30 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=customize]') !== null);
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=customize]').click();
  await waitFor(() => document.querySelector('[data-testid=settings-buttons]') !== null);
  expect(store.settingsTab).toBe('appearance');
  const terminal = query<HTMLInputElement>('[data-testid="control-header.terminal"]');
  expect(terminal.checked).toBe(false);
  // Neither preset is lit once the buttons are the device's own.
  expect(query('[data-testid=controls-preset-developer]').getAttribute('aria-pressed')).toBe('false');
  terminal.click();
  expect(work.current.hidden).toEqual([]);
  await waitFor(() => query('[data-testid=controls-preset-developer]').getAttribute('aria-pressed') === 'true');
  query<HTMLButtonElement>('[data-testid=controls-preset-everyday]').click();
  expect(work.current.hidden).toEqual(['header.terminal', 'panel.trace']);
  await waitFor(() => !query<HTMLInputElement>('[data-testid="control-header.terminal"]').checked);
});

test('the header button opens the panel on its launcher, which opens the changes surface', async ({ app: _app }) => {
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');

  // The panel's layout is a module singleton: this test starts on an empty strip.
  store.panel.closeAll();
  expect(store.panelOpen).toBe(false);
  query<HTMLButtonElement>('[data-testid=panel-toggle]').click();
  // An empty panel opens on its cards rather than forcing one surface.
  await waitFor(() => document.querySelector('[data-testid=panel-launcher]') !== null);
  expect(query('[data-testid=panel-toggle]').getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('[data-testid=trace-panel]')).toBeNull();
  for (const kind of ['agent-browser', 'changes', 'files', 'tasks', 'trace']) {
    expect(document.querySelector(`[data-testid=launch-${kind}]`)).not.toBeNull();
  }

  query<HTMLButtonElement>('[data-testid=launch-changes]').click();
  await waitFor(() => document.querySelectorAll('[data-testid=changes-row]').length === 7);
  expect(query('[data-testid=changes-count]').textContent).toContain('7');
  // Every status of the contract has a row, so every badge is drawn once.
  expect(
    Array.from(document.querySelectorAll('[data-testid=changes-row]')).map((row) => row.getAttribute('data-status'))
  ).toEqual(['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked', 'conflict']);

  // A row selects, and the selection rides the tab rather than the component.
  query<HTMLButtonElement>('[data-testid=changes-row][data-path="src/components/RightPanel.svelte"]').click();
  await waitFor(() => store.panel.active?.path === 'src/components/RightPanel.svelte');
  await waitFor(() => document.querySelector('[data-testid=diff-view]') !== null);

  // A second surface joins the strip rather than replacing the first.
  store.panel.openTasks();
  await waitFor(() => document.querySelector('[data-testid=tasks-panel]') !== null);
  expect(document.querySelectorAll('[data-testid=panel-tab]').length).toBe(2);

  // A finger held on a tab opens the menu a right click opens, so a phone can close the others.
  const first = query('[data-testid=panel-tab][data-kind=changes]');
  first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 20 }));
  await waitFor(() => document.querySelector('[data-testid=context-menu] [data-value=others]') !== null);
  first.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, pointerId: 1, pointerType: 'touch' }));
  query<HTMLButtonElement>('[data-testid=context-menu] [data-value=others]').click();
  await waitFor(() => document.querySelectorAll('[data-testid=panel-tab]').length === 1);
  expect(store.panel.active?.kind).toBe('changes');

  query<HTMLButtonElement>('[data-testid=panel-toggle]').click();
  await waitFor(() => !store.panelOpen);
  // The panel plays its exit before it unmounts, so the button is what answers here.
  expect(query('[data-testid=panel-toggle]').getAttribute('aria-pressed')).toBe('false');
});

test('the tasks surface lists the project todos and adds, claims and drops one', async ({ app: _app }) => {
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');

  store.panel.closeAll();
  store.panel.openTasks();
  await waitFor(() => document.querySelectorAll('[data-testid=todo-row]').length === 3);
  // The card the agent finished waits on the user, ahead of the one already done.
  expect(
    Array.from(document.querySelectorAll('[data-testid=todo-row]')).map((row) => row.getAttribute('data-status'))
  ).toEqual(['claimed', 'open', 'done']);
  expect(query('[data-testid=todo-awaiting]').textContent).toContain('Awaiting you');

  const field = query<HTMLInputElement>('[data-testid=todo-input]');
  await type(field, 'Capture the phone layout');
  query<HTMLButtonElement>('[data-testid=todo-add]').click();
  await waitFor(() => document.querySelectorAll('[data-testid=todo-row]').length === 4);
  expect(document.body.textContent).toContain('Capture the phone layout');
  // The whole list travels on `todos.updated`, keyed by the project.
  expect(store.todos['p-boite']?.length).toBe(4);

  const added = Array.from(document.querySelectorAll('[data-testid=todo-row]')).find((row) =>
    row.textContent?.includes('Capture the phone layout')
  ) as HTMLElement;
  expect(added.getAttribute('data-status')).toBe('open');
  added.querySelector<HTMLButtonElement>('[data-testid=todo-claim]')!.click();
  await waitFor(() => store.todos['p-boite']?.some((todo) => todo.text === 'Capture the phone layout' && todo.status === 'claimed') === true);

  added.querySelector<HTMLButtonElement>('[data-testid=todo-remove]')!.click();
  await waitFor(() => document.querySelectorAll('[data-testid=todo-row]').length === 3);
  expect(document.body.textContent).not.toContain('Capture the phone layout');
});

test('the panel query switch opens that surface on the thread the page lands on', async () => {
  // `&panel=<kind>` is the capture path: the surface is there with no clicks.
  await mountOnFake('/?fake=1&panel=tasks');
  await waitFor(() => document.querySelector('[data-testid=tasks-panel]') !== null);
  expect(store.panel.active?.kind).toBe('tasks');
  store.panel.closeAll();
});

test('the panel query switch also names a directory to open the tree on and a file to read', async () => {
  await mountOnFake('/?fake=1&panel=file:docs/guide/editor.md');
  await waitFor(() => document.querySelector('[data-testid=file-panel]') !== null);
  expect(store.panel.active?.path).toBe('docs/guide/editor.md');
  await waitFor(() => query<HTMLTextAreaElement>('[data-testid=file-text]').value.includes('# The editor'));
  store.panel.closeAll();
});

test('what the agent asks for through panel.open opens on the thread it named', async ({ app: _app }) => {
  await waitFor(() => document.querySelector('[data-thread-id="t-trace"]') !== null);
  query<HTMLButtonElement>('[data-thread-id="t-trace"]').click();
  await waitFor(() => store.openThread?.id === 't-trace');
  store.panel.closeAll();
  expect(store.panelOpen).toBe(false);

  const shown = await store.client!.call('panel.open', {
    threadId: 't-trace',
    surface: { kind: 'diff', path: 'docs/panel.md' }
  });
  expect(shown).toEqual({ shown: true });
  await waitFor(() => document.querySelector('[data-testid=changes-panel]') !== null);
  expect(store.panel.active?.path).toBe('docs/panel.md');

  // A file lands on its own tab, named after the file and holding the line.
  await store.client!.call('panel.open', {
    threadId: 't-trace',
    surface: { kind: 'file', path: 'src/lib/store.svelte.ts', line: 42 }
  });
  await waitFor(() => document.querySelector('[data-testid=file-panel]') !== null);
  expect(store.panel.active?.line).toBe(42);
  expect(query('[data-testid=panel-tab][data-kind=file]').getAttribute('title')).toBe('src/lib/store.svelte.ts');
  expect(query('[data-testid=panel-tab][data-kind=file] .name').textContent).toBe('store.svelte.ts');
});
