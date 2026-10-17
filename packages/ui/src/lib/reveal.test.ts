import { afterEach, expect, test, vi } from 'vitest';
import type { UiRevealTarget } from '@boite/contracts';
import { setExperiment } from './experiments';
import { experimentOn } from './experiments.svelte';
import { onReveal, reveal, revealRequested, type RevealWorkspace } from './reveal';
import type { Store } from './store.svelte';
import { fill, strings } from './strings';

const internals = window as unknown as { __TAURI_INTERNALS__?: unknown };
afterEach(() => {
  delete internals.__TAURI_INTERNALS__;
  setExperiment('resident-agents', false);
});

type FakeStore = Store & { showAgents: ReturnType<typeof vi.fn>; showSettings: ReturnType<typeof vi.fn> };
const fakeStore = (localCore: boolean, coreId = 'core-here', connection = 'ready') =>
  ({ localCore, core: { coreId }, connection, error: null, showAgents: vi.fn(), showSettings: vi.fn() }) as unknown as FakeStore;
const alone = { machineOf: () => null };
const thread: UiRevealTarget = { kind: 'thread', threadId: 'thr_1' as never };

test('only the desktop shell answers, and only for the core it started', () => {
  const seen: string[] = [];
  const stop = onReveal(async (_from, target) => { seen.push(target.kind); });
  try {
    revealRequested(fakeStore(true), thread);
    expect(seen).toEqual([]);
    internals.__TAURI_INTERNALS__ = {};
    revealRequested(fakeStore(false), thread);
    expect(seen).toEqual([]);
    revealRequested(fakeStore(true), thread);
    expect(seen).toEqual(['thread']);
  } finally { stop(); }
  revealRequested(fakeStore(true), thread);
  expect(seen).toEqual(['thread']);
});

test('the window comes forward, then the thread opens on the machine that asked', async () => {
  const from = fakeStore(true);
  const order: string[] = [];
  const workspace: RevealWorkspace = { ...alone, active: from, select: vi.fn(async (_target, threadId) => { order.push(`select:${threadId ?? ''}`); }) };
  await reveal(workspace, from, thread, async () => { order.push('show'); });
  expect(order).toEqual(['show', 'select:thr_1']);
  expect(workspace.select).toHaveBeenCalledWith(from, 'thr_1');
  expect(from.showAgents).not.toHaveBeenCalled();
});

test('an agent opens on the Agents page, switching its experiment on', async () => {
  const from = fakeStore(true);
  const workspace: RevealWorkspace = { ...alone, active: from, select: vi.fn(async () => undefined) };
  expect(experimentOn('resident-agents')).toBe(false);
  await reveal(workspace, from, { kind: 'agent', agentId: 'agent-7' }, async () => undefined);
  expect(workspace.select).toHaveBeenCalledWith(from);
  expect(experimentOn('resident-agents')).toBe(true);
  expect(from.showAgents).toHaveBeenCalledWith('agent-7');

  // A machine the owner switched away from meanwhile keeps its page.
  const other = fakeStore(true);
  await reveal({ ...alone, active: from, select: async () => undefined }, other, { kind: 'agent', agentId: 'agent-8' }, async () => undefined);
  expect(other.showAgents).not.toHaveBeenCalled();
});

test('the app updates open in Settings, on the machine that asked', async () => {
  const from = fakeStore(true);
  const workspace: RevealWorkspace = { ...alone, active: from, select: vi.fn(async () => undefined) };
  await reveal(workspace, from, { kind: 'update' }, async () => undefined);
  expect(workspace.select).toHaveBeenCalledWith(from);
  expect(from.showSettings).toHaveBeenCalledWith('machines', 'machines');
  expect(from.showAgents).not.toHaveBeenCalled();

  const other = fakeStore(true);
  await reveal({ ...alone, active: from, select: async () => undefined }, other, { kind: 'update' }, async () => undefined);
  expect(other.showSettings).not.toHaveBeenCalled();
});

test('a target naming another machine opens on that machine\'s Store, and its own id stays here', async () => {
  const from = fakeStore(true);
  const laptop = fakeStore(false, 'core-laptop');
  const machineOf = vi.fn((coreId: string) => (coreId === 'core-laptop' ? { store: laptop, label: 'Laptop' } : null));
  const select = vi.fn(async (_target: Store, _threadId?: string) => undefined);
  const workspace = { active: from, select, machineOf } as RevealWorkspace & { active: Store };
  select.mockImplementation(async (target) => { workspace.active = target; });

  await reveal(workspace, from, { kind: 'thread', threadId: 'thr_1' as never, coreId: 'core-laptop' }, async () => undefined);
  expect(select).toHaveBeenLastCalledWith(laptop, 'thr_1');
  await reveal(workspace, from, { kind: 'agent', agentId: 'agent-7', coreId: 'core-laptop' }, async () => undefined);
  expect(select).toHaveBeenLastCalledWith(laptop);
  expect(laptop.showAgents).toHaveBeenCalledWith('agent-7');
  expect(from.showAgents).not.toHaveBeenCalled();

  // The core that asked, named by its own id: no lookup, the thread opens here.
  machineOf.mockClear();
  await reveal(workspace, from, { kind: 'thread', threadId: 'thr_2' as never, coreId: 'core-here' }, async () => undefined);
  expect(select).toHaveBeenLastCalledWith(from, 'thr_2');
  expect(machineOf).not.toHaveBeenCalled();
});

test('a machine the window lacks or has offline says so on the page shown, and nothing opens', async () => {
  const from = fakeStore(true);
  const asleep = fakeStore(false, 'core-asleep', 'closed');
  const workspace: RevealWorkspace = {
    active: from,
    select: vi.fn(async () => undefined),
    machineOf: (coreId) => (coreId === 'core-asleep' ? { store: asleep, label: 'Build server' } : null)
  };
  await reveal(workspace, from, { kind: 'thread', threadId: 'thr_1' as never, coreId: 'core-unknown' }, async () => undefined);
  expect(from.error).toBe(strings.plugins.revealUnknownMachine);
  await reveal(workspace, from, { kind: 'agent', agentId: 'agent-7', coreId: 'core-asleep' }, async () => undefined);
  expect(from.error).toBe(fill(strings.plugins.revealMachineOffline, { machine: 'Build server' }));
  expect(workspace.select).not.toHaveBeenCalled();
  expect(asleep.showAgents).not.toHaveBeenCalled();
});
