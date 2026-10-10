import { afterEach, expect, test, vi } from 'vitest';
import type { UiRevealTarget } from '@boite/contracts';
import { setExperiment } from './experiments';
import { experimentOn } from './experiments.svelte';
import { onReveal, reveal, revealRequested, type RevealWorkspace } from './reveal';
import type { Store } from './store.svelte';

const internals = window as unknown as { __TAURI_INTERNALS__?: unknown };
afterEach(() => {
  delete internals.__TAURI_INTERNALS__;
  setExperiment('resident-agents', false);
});

const fakeStore = (localCore: boolean) => ({ localCore, showAgents: vi.fn() }) as unknown as Store & { showAgents: ReturnType<typeof vi.fn> };
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
  const workspace: RevealWorkspace = { active: from, select: vi.fn(async (_target, threadId) => { order.push(`select:${threadId ?? ''}`); }) };
  await reveal(workspace, from, thread, async () => { order.push('show'); });
  expect(order).toEqual(['show', 'select:thr_1']);
  expect(workspace.select).toHaveBeenCalledWith(from, 'thr_1');
  expect(from.showAgents).not.toHaveBeenCalled();
});

test('an agent opens on the Agents page, switching its experiment on', async () => {
  const from = fakeStore(true);
  const workspace: RevealWorkspace = { active: from, select: vi.fn(async () => undefined) };
  expect(experimentOn('resident-agents')).toBe(false);
  await reveal(workspace, from, { kind: 'agent', agentId: 'agent-7' }, async () => undefined);
  expect(workspace.select).toHaveBeenCalledWith(from);
  expect(experimentOn('resident-agents')).toBe(true);
  expect(from.showAgents).toHaveBeenCalledWith('agent-7');

  // A machine the owner switched away from meanwhile keeps its page.
  const other = fakeStore(true);
  await reveal({ active: from, select: async () => undefined }, other, { kind: 'agent', agentId: 'agent-8' }, async () => undefined);
  expect(other.showAgents).not.toHaveBeenCalled();
});
