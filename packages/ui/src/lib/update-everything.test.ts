import { expect, test } from 'vitest';
import type { HarnessUpdate, ProviderId } from '@boite/contracts';
import { DONE_LINGER_MS, offerKeys, planOf, reconcileRows, type AppReading, type MachineReading, type UpdateRow } from './update-everything.svelte';

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

test('the card empties one row at a time: a part that lands shows its check, then goes', () => {
  const reachable = () => true;
  const running = planOf([machine('m2', { agents: [agent('claude', { state: 'updating', pending: false }), agent('codex', { state: 'updating', pending: false })] })], null);
  let rows: UpdateRow[] = reconcileRows([], running, reachable, 0);
  expect(rows.map((row) => [row.part.id, row.doneAt])).toEqual([['boite', null], ['claude', null], ['codex', null]]);

  // Claude lands first: its row stays with a check, the others go on.
  const claudeDone = planOf([machine('m2', { agents: [agent('codex', { state: 'updating', pending: false })] })], null);
  rows = reconcileRows(rows, claudeDone, reachable, 1000);
  expect(rows.map((row) => [row.part.id, row.doneAt])).toEqual([['boite', null], ['claude', 1000], ['codex', null]]);
  // Past the linger it goes, in place.
  rows = reconcileRows(rows, claudeDone, reachable, 1000 + DONE_LINGER_MS);
  expect(rows.map((row) => row.part.id)).toEqual(['boite', 'codex']);
});

test('Boite restarting on a machine out of reach is not done, and an offer put off goes without a check', () => {
  const installing = planOf([machine('m2', { server: { mode: 'systemd', phase: 'installing', currentVersion: '2.0.0', version: '2.1.0', received: 0, total: null, error: null } })], null);
  let rows = reconcileRows([], installing, () => true, 0);
  // The core restarts: the machine drops, its row keeps saying Restarting.
  rows = reconcileRows(rows, [], () => false, 500);
  expect(rows.map((row) => [row.part.id, row.part.state, row.doneAt])).toEqual([['boite', 'installing', null]]);
  // Back, on the new version: now it is done.
  rows = reconcileRows(rows, [], () => true, 900);
  expect(rows.map((row) => [row.part.id, row.doneAt])).toEqual([['boite', 900]]);

  const offered = reconcileRows([], planOf([machine('m2')], null), () => true, 0);
  expect(reconcileRows(offered, [], () => true, 100)).toEqual([]);
});

test("another Windows PC's desktop app is a part of its own, offered from here, never on a system whose installer asks there", () => {
  const manual = { mode: 'manual', phase: 'idle', currentVersion: '2.0.0', version: null, received: 0, total: null, error: null } as const;
  const plan = planOf([
    machine('pc-b', { os: 'windows', server: manual, desktop: { ...app, phase: 'ready' }, agents: [agent('claude')] }),
    // A .deb or a macOS installer may prompt with nobody at that machine.
    machine('laptop', { os: 'macos', server: manual, desktop: app }),
    // This computer's own app stays the window's updater, never a report.
    machine('pc', { local: true, server: null, os: 'windows', desktop: app })
  ], null);
  expect(plan.map((entry) => [entry.id, entry.parts.map((part) => part.id)])).toEqual([['pc-b', ['desktop', 'claude']]]);
  // Downloaded there but not installed: still an offer from here, since its window installs on request.
  expect(plan[0]!.parts[0]).toMatchObject({ name: 'Boite', from: '2.0.0', version: '2.1.0', state: 'offered', startable: true });
  expect(offerKeys(plan)).toEqual(['pc-b/desktop@2.1.0', 'pc-b/claude@1.1.0']);

  const parts = (reading: Partial<MachineReading>) => planOf([machine('pc-b', { os: 'windows', server: manual, ...reading })], null)[0]?.parts ?? [];
  expect(parts({ desktop: { ...app, phase: 'downloading', received: 50, total: 200 } })[0]).toMatchObject({ state: 'downloading', percent: 25, startable: false });
  expect(parts({ desktop: { ...app, phase: 'installing' } })[0]).toMatchObject({ state: 'installing', startable: false });
  // Asked while no window was open there: failed with the core's reason, and offered again.
  const failure = { version: '2.1.0', message: 'Boite is not open on PC-B' };
  expect(parts({ desktop: null, desktopFailure: failure })[0]).toMatchObject({ id: 'desktop', state: 'failed', message: 'Boite is not open on PC-B', startable: true });
  expect(parts({ desktop: app, desktopFailure: failure })[0]).toMatchObject({ state: 'failed', startable: true });
  // The window took it after all.
  expect(parts({ desktop: { ...app, phase: 'downloading' }, desktopFailure: failure })[0]).toMatchObject({ state: 'downloading' });
  expect(parts({ desktop: { ...app, phase: 'current', version: null } })).toEqual([]);
});

test("another PC's desktop app installing keeps its row while that PC restarts out of reach, and lands once it is back", () => {
  const manual = { mode: 'manual', phase: 'idle', currentVersion: '2.0.0', version: null, received: 0, total: null, error: null } as const;
  const installing = planOf([machine('pc-b', { os: 'windows', server: manual, desktop: { ...app, phase: 'installing' } })], null);
  let rows = reconcileRows([], installing, () => true, 0);
  rows = reconcileRows(rows, [], () => false, 400);
  expect(rows.map((row) => [row.key, row.part.state, row.doneAt])).toEqual([['pc-b/desktop', 'installing', null]]);
  rows = reconcileRows(rows, [], () => false, 30_000);
  expect(rows.map((row) => row.doneAt)).toEqual([null]);
  // Back on the new version: the new core has no offer left, so the row shows its check.
  rows = reconcileRows(rows, [], () => true, 31_000);
  expect(rows.map((row) => [row.key, row.doneAt])).toEqual([['pc-b/desktop', 31_000]]);
});

test("a release another PC's core took waits there for its agents, then follows its window", () => {
  const manual = { mode: 'manual', phase: 'idle', currentVersion: '2.0.0', version: null, received: 0, total: null, error: null } as const;
  const part = (reading: Partial<MachineReading>) => planOf([machine('pc-b', { os: 'windows', server: manual, desktopRequested: '2.1.0', ...reading })], null)[0]?.parts[0];
  expect(part({ desktop: app })).toMatchObject({ id: 'desktop', state: 'waiting', startable: false });
  expect(part({ desktop: { ...app, phase: 'downloading' } })).toMatchObject({ state: 'downloading' });
  // A newer release than the one asked for is offered again.
  expect(part({ desktop: { ...app, version: '2.2.0' } })).toMatchObject({ state: 'offered', startable: true });
});
