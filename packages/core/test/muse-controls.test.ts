import { expect, test } from 'bun:test';
import { MuseControls } from '../src/drivers/muse/controls.ts';
import type { MuseRpc } from '../src/drivers/muse/rpc.ts';
import type { SessionContext } from '../src/drivers/types.ts';
import { thrown } from './settle.ts';

const context = { thread: { model: 'requested', permissionMode: 'default' } } as SessionContext;

test('Muse retries model rejection and approval mismatch on the next warm alignment', async () => {
  const controls = new MuseControls();
  const calls: string[] = [];
  const rpc = { command: async (method: string) => {
    calls.push(method);
    if (method === 'session/setModel') return {status: calls.length === 1 ? 'rejected' : 'accepted'};
    return {effectiveMode: {mode: calls.length === 2 ? 'denyUnmatched' : 'promptUnmatched'}};
  } } as unknown as MuseRpc;
  await controls.align(rpc, 'session', context, false);
  await controls.align(rpc, 'session', context, false);
  expect(calls).toEqual(['session/setModel', 'session/setApprovalMode', 'session/setModel', 'session/setApprovalMode']);
  await controls.align(rpc, 'session', context, false);
  expect(calls).toHaveLength(4);
});

test('Muse keeps legacy unprotected acknowledgements but requires explicit native confirmation', async () => {
  const calls: string[] = [];
  const rpc = { command: async (method: string) => { calls.push(method); return {}; } } as unknown as MuseRpc;
  const controls = new MuseControls();
  await controls.align(rpc, 'session', context, false);
  await controls.align(rpc, 'session', context, false);
  expect(calls).toHaveLength(2);
  const protectedControls = new MuseControls();
  expect(await thrown(protectedControls.align(rpc, 'session', context, true))).toThrow('captured model');
  protectedControls.modelId = 'requested';
  expect(await thrown(protectedControls.align(rpc, 'session', context, true))).toThrow('captured approval mode');
});
