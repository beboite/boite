// Owns window keyboard routing, including keys handled differently from palette commands.
import type { KeybindingCommand } from '@boite/contracts';
import { runCommand } from './commands.svelte';
import { errorText } from './errors';
import { closeTabs } from './panel-close';
import { isQuitChord, type QuitHold } from './quit-hold';
import type { Store } from './store.svelte';
import { setZoom, stepZoom, wantedZoom, ZOOM_DEFAULT, zoomKey } from './zoom';

type AppKeyDependencies = {
  store: Store;
  inShell: boolean;
  modal: boolean;
  quitHold: Pick<QuitHold, 'press'> | null;
};
type AppKeyCommand = (event: KeyboardEvent, store: Store) => void;

/** A key that belongs to whatever the user is typing in. */
function typing(event: KeyboardEvent): boolean {
  const target = event.target;
  return target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

function panelKey(kind: 'changes' | 'files' | 'tasks'): AppKeyCommand {
  return (event, store) => {
    // Paired devices read the working tree, but not the project's todos.
    if (!store.openThread || (kind === 'tasks' && !store.owner)) return;
    event.preventDefault();
    // A surface opened from settings must also bring its chat into view.
    if (store.page !== 'chat') {
      store.showChat();
      store.panel.open(kind);
    } else store.panel.toggleKind(kind);
  };
}

const appKeyCommands = new Map<KeybindingCommand, AppKeyCommand>([
  ['palette', (event, store) => {
    event.preventDefault();
    store.paletteOpen = !store.paletteOpen;
  }],
  ['panel', (event, store) => {
    if (!store.openThread) return;
    event.preventDefault();
    store.togglePanel();
  }],
  ['browser', (event, store) => {
    if (!store.openThread) return;
    event.preventDefault();
    const open = store.panel.surfaces.find(surface => surface.kind === 'agent-browser');
    if (open) store.panel.activate(open.id);
    else store.panel.open('agent-browser');
  }],
  ['changes', panelKey('changes')],
  ['files', panelKey('files')],
  ['tasks', panelKey('tasks')],
  ['close-surface', (event, store) => {
    // Close the active surface only while its panel is showing and not typing.
    const active = store.panel.activeSurfaceId;
    if (!store.panelOpen || !active || typing(event)) return;
    event.preventDefault();
    void closeTabs(store.panel, 'close', active);
  }],
  // The composer stashes first; the window only suppresses the browser's save dialog.
  ['stash', event => { event.preventDefault(); }],
  // The composer already saw and handled this key before the window did.
  ['send-and-draft', () => {}],
]);

function handleShellKey(event: KeyboardEvent, deps: AppKeyDependencies): boolean {
  if (deps.quitHold && isQuitChord(event)) {
    event.preventDefault();
    deps.quitHold.press();
    return true;
  }
  // Browser surfaces own their zoom; browser tabs keep native zoom.
  const zoom = deps.inShell ? zoomKey(event) : null;
  if (zoom === null || (event.target instanceof Element && event.target.closest('[data-testid=browser-surface]'))) return false;
  event.preventDefault();
  void setZoom(zoom === 0 ? ZOOM_DEFAULT : stepZoom(wantedZoom(), zoom)).catch((error: unknown) => {
    deps.store.error = errorText(error);
  });
  return true;
}

function activeWork(store: Store): boolean {
  return store.busy || store.openThread?.activity?.goal?.status === 'active' || store.openThread?.activity?.loop?.status === 'active';
}

function handleEscape(event: KeyboardEvent, store: Store): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  if (store.sidebarOpen) store.sidebarOpen = false;
  else if (!typing(event) && store.page === 'chat' && activeWork(store)) {
    event.preventDefault();
    void store.stop();
  }
}

/** Keep shell keys ahead of dialogs, then dispatch the user's keyboard table. */
export function handleAppKey(event: KeyboardEvent, deps: AppKeyDependencies): void {
  if (handleShellKey(event, deps)) return;
  // Each modal answers its own keys during capture before this window listener.
  if (deps.modal) return;
  const command = deps.store.commandForKey(event);
  if (command === null) {
    handleEscape(event, deps.store);
    return;
  }
  const handle = appKeyCommands.get(command);
  if (handle) {
    handle(event, deps.store);
    return;
  }
  event.preventDefault();
  runCommand(deps.store, command, deps.inShell);
}
