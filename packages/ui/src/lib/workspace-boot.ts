// Owns workspace startup, remembered-machine admission and primary-machine entries.
import type { Machine, Workspace } from './workspace.svelte';
import {
  clearStoredEndpoint, linkedCore, openOnMainMachine, readEnvironments,
  readStoredEndpoint, readMainMachine, servesThisPage, storeEndpoint,
  upsertEnvironment, fromTauri, opens, type Endpoint, type StoredEnvironment
} from './endpoint';
import { strings } from './strings';
import { holdsBack } from './group-links.svelte';

/** Keeps lifecycle and navigation guards private to the workspace facade. */
interface BootLifecycle {
  current(): boolean;
  navigationCurrent(): boolean;
  silent(booting: Promise<void>): Promise<boolean>;
  standIn(): void;
  primaryAnswered(): void;
  /** The fake second machine stays in the facade: a dynamic import of the fake client here moved shared chunks into the entry. */
  addFakeMachine(): Promise<void>;
}

/** What a machine that has not answered yet is called: its address, never "This PC". */
export function hostOf(url: string | null): string | undefined {
  try { return url === null ? undefined : new URL(url).host; } catch { return undefined; }
}

export function primaryMachine(workspace: Workspace, selected: Endpoint | null, remembered: StoredEnvironment[], before: StoredEnvironment[] = []): Machine {
  const store = workspace.primary;
  // A machine the group brought stays one when it is the machine this window opens on. When its saved entry
  // went during the boot, its key refused, what the entry said before still holds: the group may drop it.
  // With no entry at all, the core the window was stored on says it itself.
  const brought = remembered.find(e => e.url === store.endpointUrl) ?? before.find(e => e.url === store.endpointUrl)
    ?? (selected?.url === store.endpointUrl ? selected : undefined);
  const machine: Machine = {
    id: store.endpointUrl ?? 'local',
    label: remembered.find(e => e.url === selected?.url)?.label ?? (store.localCore ? strings.machines.local : store.core?.hostname ?? hostOf(store.endpointUrl)) ?? strings.machines.local,
    store,
    ...(brought?.coreId === undefined ? {} : { coreId: brought.coreId }),
    ...(brought?.groupId === undefined ? {} : { groupId: brought.groupId }),
    ...(brought?.coreId === undefined || brought.epoch === undefined ? {} : { epoch: brought.epoch })
  };
  workspace.restoreProfile(machine);
  return machine;
}

async function connectShellLocal(workspace: Workspace, lifecycle: BootLifecycle): Promise<void> {
  const store = workspace.primary;
  if (!window.__TAURI_INTERNALS__ || store.localCore) return;
  const local = await fromTauri();
  if (!lifecycle.current()) return;
  if (local && local.url !== store.endpointUrl) await workspace.add(local, strings.machines.local);
}

async function adoptPopulatedJournal(workspace: Workspace, lifecycle: BootLifecycle): Promise<void> {
  const store = workspace.primary;
  // A fresh Dev core may have no threads while an older core on this PC has a journal.
  // The name a core reports is its own word: a machine the group brought never becomes the page's own by claiming this PC's.
  const populated = store.localCore && store.threads.length === 0 && store.core?.hostname
    ? workspace.machines.find(m => m.store !== store && m.coreId === undefined && m.store.connection === 'ready' && m.store.threads.length > 0 && m.store.core?.hostname === store.core?.hostname)
    : undefined;
  if (!populated) return;
  await store.switchEnvironment(populated.id);
  if (!lifecycle.current() || store.connection !== 'ready') return;
  populated.store.client?.close();
  populated.store.detach();
  workspace.machines = [{ id: populated.id, label: populated.label, icon: populated.icon, store }, ...workspace.machines.filter(m => m.store !== store && m !== populated)];
}

/** Which keys the group brought over plain HTTP may be sent where they were saved: asked before any of them is. */
async function vet(workspace: Workspace, saved: StoredEnvironment[]): Promise<StoredEnvironment[]> {
  const held = saved.filter(holdsBack);
  if (held.length === 0) return [];
  const anchors: Endpoint[] = saved.filter((e) => e.coreId === undefined && opens(e))
    .map((e) => ({ url: e.url, token: e.token, paired: e.paired, ...(e.signs === undefined ? {} : { signs: e.signs }) }));
  const local = window.__TAURI_INTERNALS__ ? await fromTauri().catch(() => null) : null;
  if (local && !anchors.some((e) => e.url === local.url)) anchors.push(local);
  return workspace.groups.vet(held, anchors);
}

/** The machine paired by hand a window falls back on: the one serving this page first. None in the shell, which has its own core. */
export function byHand(): StoredEnvironment | undefined {
  const byHand = readEnvironments().filter((e) => e.coreId === undefined && opens(e));
  return window.__TAURI_INTERNALS__ ? undefined : byHand.find((e) => servesThisPage(e.url)) ?? byHand[0];
}

/**
 * The stored core was refused its key: the key goes first, so nothing reads
 * it back, and the window opens on a machine paired by hand or on the
 * shell's own core.
 */
function openElsewhere(): void {
  clearStoredEndpoint();
  const next = byHand();
  if (next) storeEndpoint({ url: next.url, token: next.token, ...(next.paired ? { paired: true } : {}), ...(next.signs === undefined ? {} : { signs: next.signs }) });
}

export async function bootWorkspace(workspace: Workspace, thread: string | null, lifecycle: BootLifecycle): Promise<void> {
  const store = workspace.primary;
  store.visible = true;
  workspace.active = store;
  // The machine the owner chose becomes the stored core before anything below reads it.
  workspace.main = readMainMachine();
  openOnMainMachine();
  try {
    workspace.view = localStorage.getItem('boite.thread-view') === 'recent' ? 'recent' : 'projects';
  } catch {
    /* session only */
  }
  // The window would open on a machine whose key is held back, the stored one or the one a `?core=`
  // link names: it waits for the answer, and on a refusal that key is sent nowhere.
  // Both count: a link the owner declines falls back on the stored core.
  const kept = readStoredEndpoint();
  // The stored core counts as an entry even when the list no longer has one for it: its marks travel with it.
  const saved = kept?.coreId !== undefined && !readEnvironments().some((e) => e.url === kept.url)
    ? [...readEnvironments(), { url: kept.url, label: '', token: kept.token, paired: true, coreId: kept.coreId, ...(kept.groupId === undefined ? {} : { groupId: kept.groupId }) }]
    : readEnvironments();
  const stored = kept?.url;
  const gated = [linkedCore(), stored].filter((url): url is string => typeof url === 'string' && saved.some((e) => e.url === url && holdsBack(e)));
  const vetting = vet(workspace, saved).catch(() => [] as StoredEnvironment[]);
  if (gated.length > 0) {
    const cleared = await vetting;
    if (!lifecycle.current()) return;
    if (stored !== undefined && gated.includes(stored) && !cleared.some((e) => e.url === stored)) openElsewhere();
  }
  const selected = readStoredEndpoint();
  const booting = thread === null ? store.boot() : store.boot(false, thread);
  // Awaited below on every path: a failure in between is not left unhandled.
  booting.catch(() => undefined);
  // A machine that stays silent, a laptop switched off, does not keep the others waiting: they are
  // connected without it, and the first that answers is shown in its place. A link is always waited on.
  const ahead = workspace.waiting && await lifecycle.silent(booting);
  if (!ahead) await booting;
  if (!lifecycle.current()) return;
  workspace.active = store;
  // Read after the boot: a pairing link it opened on has just made this machine one paired by hand.
  workspace.machines = [primaryMachine(workspace, selected, readEnvironments(), saved)];
  // Ends the wait at once when the machine answered, or when no other could be shown.
  lifecycle.standIn();
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('fake') === '1') {
    if (new URLSearchParams(window.location.search).get('machines') === '1') {
      await lifecycle.addFakeMachine();
    }
    return;
  }
  const primaryEndpoint = readStoredEndpoint();
  await connectShellLocal(workspace, lifecycle);
  if (!lifecycle.current()) return;
  lifecycle.standIn();
  const shown = (connected: boolean): boolean => {
    if (connected) lifecycle.standIn();
    return connected;
  };
  if (!store.localCore && primaryEndpoint?.url === store.endpointUrl && opens(primaryEndpoint)) {
    // An entry that went during the boot comes back as what it was: a machine the group brought is not made
    // the owner's by being written again. One still there says what it is itself, a pairing by hand included.
    const was = readEnvironments().some((e) => e.url === primaryEndpoint.url) ? undefined : saved.find((e) => e.url === primaryEndpoint.url);
    upsertEnvironment({
      ...primaryEndpoint, paired: primaryEndpoint.paired ?? false, label: workspace.machines[0]!.label,
      ...(was?.coreId === undefined ? {} : { coreId: was.coreId }),
      ...(was?.groupId === undefined ? {} : { groupId: was.groupId })
    });
  }
  const others = readEnvironments().filter((e) => e.url !== store.endpointUrl);
  await Promise.all([
    ...others.filter((e) => !holdsBack(e)).map((e) => workspace.add(e, e.label).then(shown)),
    // A key held back is sent once the machines paired by hand had their say, and only where it still stands.
    vetting.then((cleared) => Promise.all(others
      .filter((e) => holdsBack(e) && cleared.some((kept) => kept.url === e.url) && lifecycle.current())
      .map((e) => workspace.add(e, e.label).then(shown)))),
    ...(ahead ? [booting.then(() => lifecycle.primaryAnswered())] : [])
  ]);
  if (!lifecycle.current()) return;
  await adoptPopulatedJournal(workspace, lifecycle);
  if (thread === null || !lifecycle.navigationCurrent() || !lifecycle.current() || store.openThread?.id === thread) return;
  const origin = workspace.machines.find((m) => m.store !== store && m.store.endpointUrl !== null && servesThisPage(m.store.endpointUrl));
  if (origin) await workspace.select(origin.store, thread);
}

