import { expect, test } from 'vitest';
import type { HarnessUpdate, ProviderId } from '@boite/contracts';
import { offerKeys, planOf, type AppReading, type MachineReading } from './update-everything.svelte';

function agent(providerId: string, overrides: Partial<HarnessUpdate> = {}): HarnessUpdate {
  return { providerId: providerId as ProviderId, name: providerId, route: 'self', current: '1.0.0', latest: '1.1.0', pending: true,
    skipped: null, state: 'idle', message: null, checkedAt: 1, ...overrides };
}

function machine(id: string, overrides: Partial<MachineReading> = {}): MachineReading {
  return { id, label: id, local: false, ready: true, agents: [],
    server: { mode: 'systemd', phase: 'available', currentVersion: '2.0.0', version: '2.1.0', received: 0, total: null, error: null }, ...overrides };
}

const app: AppReading = { phase: 'available', currentVersion: '2.0.0', version: '2.1.0', channel: 'stable', received: 0, total: null, error: null };

test('lists what each machine can update, this computer first, and leaves out what a click cannot reach', () => {
  const plan = planOf([
    machine('m2', { agents: [agent('claude'), agent('codex', { skipped: '1.1.0', pending: false }), agent('opencode', { latest: '1.0.0', pending: false })] }),
    // Docker and manual installs update by their own command.
    machine('docker', { server: { mode: 'docker', phase: 'available', currentVersion: '2.0.0', version: '2.1.0', received: 0, total: null, error: null } }),
    // Paired without full control, or not answering: nothing the button can ask.
    machine('phone-paired', { ready: false, agents: [agent('claude')] }),
    machine('pc', { local: true, server: null, agents: [agent('grok')] })
  ], app);

  expect(plan.map((entry) => [entry.id, entry.parts.map((part) => part.id)])).toEqual([
    ['pc', ['app', 'grok']],
    ['m2', ['boite', 'claude']]
  ]);
  expect(plan.flatMap((entry) => entry.parts).every((part) => part.startable && part.state === 'offered')).toBe(true);
});

test('follows parts in progress without offering them twice, and offers a failure again', () => {
  const plan = planOf([
    machine('m2', {
      server: { mode: 'systemd', phase: 'downloading', currentVersion: '2.0.0', version: '2.1.0', received: 30, total: 120, error: null },
      agents: [agent('claude', { state: 'updating', pending: false, waitingFor: 2 }), agent('codex', { state: 'failed', message: 'npm said no', pending: false })]
    }),
    machine('pc', { local: true, server: null })
  ], { ...app, phase: 'ready' });

  const parts = Object.fromEntries(plan.flatMap((entry) => entry.parts.map((part) => [`${entry.id}/${part.id}`, part])));
  expect(parts['m2/boite']).toMatchObject({ state: 'downloading', percent: 25, startable: false });
  expect(parts['m2/claude']).toMatchObject({ state: 'updating', waitingFor: 2, startable: false });
  expect(parts['m2/codex']).toMatchObject({ state: 'failed', message: 'npm said no', startable: true });
  // Downloaded and waiting for the click: still what the button starts.
  expect(parts['pc/app']).toMatchObject({ state: 'ready', startable: true });
});

test('a machine with nothing to do is not listed, and "Later" keys name each release so a newer one asks again', () => {
  const current = machine('m2', { server: { mode: 'systemd', phase: 'current', currentVersion: '2.1.0', version: null, received: 0, total: null, error: null } });
  expect(planOf([current], null)).toEqual([]);

  const before = offerKeys(planOf([machine('m2', { agents: [agent('claude')] })], null));
  const after = offerKeys(planOf([machine('m2', { agents: [agent('claude', { latest: '1.2.0' })] })], null));
  expect(before).toEqual(['m2/boite@2.1.0', 'm2/claude@1.1.0']);
  expect(after).toEqual(['m2/boite@2.1.0', 'm2/claude@1.2.0']);
});

test("the app's own release is offered even when this computer's core is not among the machines", () => {
  const plan = planOf([machine('m2')], app, 'This PC');
  expect(plan.map((entry) => [entry.id, entry.label, entry.parts.map((part) => part.id)])).toEqual([
    ['app', 'This PC', ['app']],
    ['m2', 'm2', ['boite']]
  ]);
});
