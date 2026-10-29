import { expect, test, vi } from 'vitest';
import { RpcErrorCode, SYNCED_SETTINGS, type RpcMethodName } from '@boite/contracts';
import { RpcFailure, type Client } from './client';
import { FakeClient } from './fake-client';
import { SyncFailure, syncSettings, type SyncEnd } from './settings-sync';

async function machine(options: { uninstalled?: boolean } = {}): Promise<FakeClient> {
  const client = new FakeClient({ delayMs: 0, ...options });
  await client.connect();
  return client;
}

/** The same core, answering `answer` instead for the methods it names. */
function older(client: FakeClient, answer: (method: string, params: unknown) => Promise<never> | null): Client {
  const call = client.call.bind(client) as Client['call'];
  return Object.assign(Object.create(client) as Client, {
    call: ((method, params) => answer(method, params) ?? call(method, params)) as Client['call']
  });
}
const unknown = (method: string) => Promise.reject(new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: `${method}: unknown method` }));

async function end(client: Client): Promise<SyncEnd> {
  return { client };
}

test('the target takes the portable settings, the keybindings and the brain switches, and keeps what is its own', async () => {
  const from = await machine();
  const to = await machine();
  await from.call('settings.set', { quotaOrder: ['a-claude', 'a-codex'], threadDeletionRetentionDays: 90, threadDoneRetentionDays: 14, warmProcessMinutes: 7, agentCpuCapPercent: 80, agentMemoryBudgetPercent: 70, threadMemoryCapMb: 4096, memoryReserveMb: 1024, memoryProtection: false, autoUpdateHarnesses: true, asyncQuestions: false, muteAgents: false, focusGuard: false, listenOnLan: true, publicUrl: 'https://source.example' });
  await to.call('settings.set', { quotaOrder: ['a-codex', 'a-claude'], threadDeletionRetentionDays: 7, threadDoneRetentionDays: 0, warmProcessMinutes: 2, agentCpuCapPercent: 30, agentMemoryBudgetPercent: 40, threadMemoryCapMb: 2048, memoryReserveMb: 3072, memoryProtection: true, autoUpdateHarnesses: false, muteAgents: true, focusGuard: true, listenOnLan: false, publicUrl: null });
  // The same rule on both sides is two equal objects, and no change to count.
  for (const client of [from, to]) await client.call('settings.set', { autoCompact: { tokens: 200_000, moments: ['turn-end'] } });
  await from.call('keybindings.set', { command: 'panel', chord: 'mod+shift+p' });
  await to.call('keybindings.set', { command: 'theme-light', chord: 'mod+alt+t' });
  await from.call('brain.configure', { path: 'D:/Source/brain', enabled: true, globalInstructions: false, boiteGuide: false });
  await to.call('brain.configure', { path: 'E:/Target/brain', enabled: true, globalInstructions: true, boiteGuide: true });

  const report = await syncSettings(await end(from), await end(to));

  const source = await from.call('settings.get', {});
  const target = await to.call('settings.get', {});
  expect(target).toMatchObject({ warmProcessMinutes: 2, agentCpuCapPercent: 30, agentMemoryBudgetPercent: 40, threadMemoryCapMb: 2048, memoryReserveMb: 3072, memoryProtection: true, autoUpdateHarnesses: false });
  for (const key of SYNCED_SETTINGS) expect(target[key]).toEqual(source[key]);
  expect(report.changed).toBe(5);
  // The machine's network face stays its own.
  expect(target).toMatchObject({ listenOnLan: false, publicUrl: null, quotaOrder: ['a-codex', 'a-claude'] });
  expect(report.settings).toEqual(target);
  // The whole file: the source's own entries, and nothing the target had alone.
  const sourceKeys = await from.call('keybindings.get', {});
  expect((await to.call('keybindings.get', {})).bindings).toEqual(sourceKeys.bindings);
  expect(report.keybindings?.bindings).toEqual(sourceKeys.bindings);
  expect(report.brain).toBe('copied');
  expect((await to.call('brain.status', {})).config).toMatchObject({ path: 'E:/Target/brain', enabled: true, globalInstructions: false, boiteGuide: false });
});

test('a target with no brain is told so, and a login never crosses', async () => {
  const from = await machine();
  const to = await machine({ uninstalled: true });
  await from.call('brain.configure', { path: 'D:/Source/brain', enabled: true });
  const target = await end(to);
  const configure = vi.spyOn(to, 'call');

  const report = await syncSettings(await end(from), target);

  expect(report.brain).toBe('absent');
  expect(configure.mock.calls.map(([method]) => method)).not.toContain('brain.configure');
  expect(configure.mock.calls.map(([method]) => method).filter((method) => method.startsWith('accounts.') || method.startsWith('providers.'))).toEqual([]);
});

test('what the target changed for itself stays: a setting, a chord and a brain switch it keeps', async () => {
  const from = await machine();
  const to = await machine();
  await from.call('settings.set', { shortAnswers: false, muteAgents: false, focusGuard: false });
  await from.call('keybindings.set', { command: 'panel', chord: 'mod+shift+p' });
  await from.call('keybindings.set', { command: 'palette', chord: 'mod+shift+k' });
  await from.call('brain.configure', { path: 'D:/Source/brain', enabled: true, globalInstructions: true, boiteGuide: false });
  await to.call('settings.set', { shortAnswers: true, muteAgents: true, focusGuard: true, syncOverrides: ['shortAnswers', 'keybinding:panel', 'brain:boiteGuide'] });
  await to.call('keybindings.set', { command: 'panel', chord: 'mod+alt+p' });
  await to.call('brain.configure', { path: 'E:/Target/brain', enabled: true, globalInstructions: false, boiteGuide: true });

  const report = await syncSettings(await end(from), await end(to));

  const target = await to.call('settings.get', {});
  // Kept here; the rest follows.
  expect(target).toMatchObject({ shortAnswers: true, muteAgents: false, focusGuard: false, syncOverrides: ['shortAnswers', 'keybinding:panel', 'brain:boiteGuide'] });
  expect(report.changed).toBe(2);
  const keys = (await to.call('keybindings.get', {})).bindings;
  expect(keys.panel).toBe('mod+alt+p');
  expect(keys.palette).toBe('mod+shift+k');
  expect((await to.call('brain.status', {})).config).toMatchObject({ globalInstructions: true, boiteGuide: true });
});

test('a core without a brain is skipped, not failed', async () => {
  const from = await machine();
  const to = await machine();
  await from.call('brain.configure', { path: 'D:/Source/brain', enabled: true });
  const report = await syncSettings(await end(from), await end(older(to, (method) => method === 'brain.status' ? unknown(method) : null)));

  expect(report.brain).toBe('none');
});

test('a source brain switched off switches the target one off, its folder kept', async () => {
  const from = await machine();
  const to = await machine();
  await from.call('brain.configure', { path: 'D:/Source/brain', enabled: false });
  await to.call('brain.configure', { path: 'E:/Target/brain', enabled: true, autoPull: { onStartup: true, intervalMinutes: 15 } });

  expect((await syncSettings(await end(from), await end(to))).brain).toBe('copied');

  expect((await to.call('brain.status', {})).config).toMatchObject({ path: 'E:/Target/brain', enabled: false, autoPull: { onStartup: false, intervalMinutes: 0 } });
});

test('a core without keybindings leaves them alone and the copy goes on to the brain', async () => {
  const from = await machine();
  const to = await machine();
  await from.call('brain.configure', { path: 'D:/Source/brain', enabled: true, boiteGuide: false });
  await to.call('brain.configure', { path: 'E:/Target/brain', enabled: true, boiteGuide: true });
  await to.call('keybindings.set', { command: 'theme-light', chord: 'mod+alt+t' });
  await from.call('keybindings.set', { command: 'panel', chord: 'mod+shift+p' });
  const before = (await to.call('keybindings.get', {})).bindings;

  const report = await syncSettings(await end(from), await end(older(to, (method) => method === 'keybindings.set' ? unknown(method) : null)));

  expect(report.keybindings).toBeNull();
  expect((await to.call('keybindings.get', {})).bindings).toEqual(before);
  expect(report.brain).toBe('copied');
  expect((await to.call('brain.status', {})).config.boiteGuide).toBe(false);
});

test('a keybinding the target refuses puts back what the copy changed and names the stage', async () => {
  const from = await machine();
  const to = await machine();
  await to.call('keybindings.set', { command: 'panel', chord: 'mod+alt+p' });
  await from.call('keybindings.set', { command: 'terminal', chord: 'mod+shift+t' });
  const before = (await to.call('keybindings.get', {})).bindings;
  const refused = () => Promise.reject(new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'keybindings.json: the file does not parse' }));

  // The terminal's entry fails; the target's own panel entry, dropped before it, comes back.
  const target = older(to, (method, params) => method === 'keybindings.set' && (params as { command: string }).command === 'terminal' ? refused() : null);
  const failed = await syncSettings(await end(from), await end(target)).catch((error: unknown) => error);

  expect(failed).toBeInstanceOf(SyncFailure);
  expect((failed as SyncFailure).stage).toBe('keybindings');
  expect((failed as SyncFailure).message).toContain('does not parse');
  expect((await to.call('keybindings.get', {})).bindings).toEqual(before);
});

test.each([
  { remaining: true, point: 'the first of two keybinding writes' },
  { remaining: false, point: 'the last keybinding write' },
])('cancellation after $point restores changed entries without copying remaining source bindings', async ({ remaining }) => {
  const from = await machine(), to = await machine();
  const abort = new AbortController();
  try {
    await to.call('keybindings.set', { command: 'panel', chord: 'mod+alt+p' });
    if (remaining) await from.call('keybindings.set', { command: 'terminal', chord: 'mod+shift+t' });
    const before = (await to.call('keybindings.get', {})).bindings;
    const source = await end(from), target = await end(to);
    const call = to.call.bind(to);
    const spy = vi.spyOn(to, 'call').mockImplementation(async (method, params) => {
      const result = await call<RpcMethodName>(method, params);
      if (method === 'keybindings.set' && (params as { command?: string; chord?: string | null }).command === 'panel'
        && (params as { chord?: string | null }).chord === null) abort.abort();
      return result;
    });
    try {
      const failed = await syncSettings(source, target, abort.signal).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(SyncFailure);
      expect((failed as SyncFailure).stage).toBe('keybindings');
      expect((await call('keybindings.get', {})).bindings).toEqual(before);
      expect(spy.mock.calls.some(([method, params]) => method === 'keybindings.set' && (params as { command?: string }).command === 'terminal')).toBe(false);
    } finally { spy.mockRestore(); }
  } finally { from.close(); to.close(); }
});


test('memory settings stay local across copies and later adjustments on either machine', async () => {
  const from = await machine(); const to = await machine();
  try {
    await from.call('settings.set', { asyncQuestions: false, agentMemoryBudgetPercent: 35, memoryReserveMb: 4096, memoryProtection: false });
    await to.call('settings.set', { memoryReserveMb: 512 });
    await syncSettings(await end(from), await end(to));
    expect(await to.call('settings.get', {})).toMatchObject({ asyncQuestions: false, agentMemoryBudgetPercent: 60, memoryReserveMb: 512, memoryProtection: true });
    await to.call('settings.set', { agentMemoryBudgetPercent: 45, memoryProtection: false });
    await from.call('settings.set', { asyncQuestions: true, agentMemoryBudgetPercent: 85, memoryProtection: true });
    await syncSettings(await end(from), await end(to));
    expect(await to.call('settings.get', {})).toMatchObject({ asyncQuestions: true, agentMemoryBudgetPercent: 45, memoryReserveMb: 512, memoryProtection: false });
  } finally { from.close(); to.close(); }
});

test('a setting the home never wrote follows as its default, so one given back takes the home value', async () => {
  const from = await machine();
  const to = await machine();
  expect((await from.call('settings.get', {})).shortAnswers).toBeUndefined();
  await to.call('settings.set', { shortAnswers: false, autoCompact: { tokens: 200_000, moments: ['turn-end'] } });

  const report = await syncSettings(await end(from), await end(to));

  expect(report.changed).toBe(2);
  expect(await to.call('settings.get', {})).toMatchObject({ shortAnswers: true, autoCompact: null });
});

test('a setting another window keeps on the target while the copy is on its way stays as that window saved it', async () => {
  const from = await machine();
  const to = await machine();
  await from.call('settings.set', { shortAnswers: false, muteAgents: false });
  const call = to.call.bind(to) as Client['call'];
  const racing = older(to, (method, params) => method === 'settings.follow'
    // The other window's save lands between the copy's read and its write.
    ? call('settings.set', { shortAnswers: true, syncOverrides: ['shortAnswers'] }).then(() => call('settings.follow', params as never)) as Promise<never> : null);
  const spy = vi.spyOn(racing, 'call');
  await syncSettings(await end(from), await end(racing));
  expect(spy.mock.calls.some(([method]) => method === 'settings.follow')).toBe(true);
  expect(await to.call('settings.get', {})).toMatchObject({ shortAnswers: true, muteAgents: false, syncOverrides: ['shortAnswers'] });
});

test('a chord kept on the target while the settings part is copied is left alone by the keybindings part', async () => {
  const from = await machine();
  const to = await machine();
  await from.call('settings.set', { muteAgents: false });
  await from.call('keybindings.set', { command: 'panel', chord: 'mod+shift+p' });
  const call = to.call.bind(to) as Client['call'];
  const racing = older(to, (method, params) => method === 'settings.follow'
    // Another window changes the chord, and keeps it, while the settings part is on its way.
    ? call('keybindings.set', { command: 'panel', chord: 'mod+alt+p' })
      .then(() => call('settings.set', { syncOverrides: ['keybinding:panel'] }))
      .then(() => call('settings.follow', params as never)) as Promise<never> : null);
  await syncSettings(await end(from), await end(racing));
  expect((await to.call('keybindings.get', {})).bindings.panel).toBe('mod+alt+p');
});

test('installing updates by itself follows the default machine, a server included, and a desktop that turns it off keeps its own', async () => {
  // A Docker server cannot update itself, yet as the group's default it carries the choice to every desktop.
  const server = await machine();
  const desk = await machine();
  await server.call('settings.set', { autoInstallUpdates: true });
  await syncSettings(await end(server), await end(desk));
  expect((await desk.call('settings.get', {})).autoInstallUpdates).toBe(true);

  // Turned off from that desktop's own window, which marks it as kept there.
  await desk.call('settings.set', { autoInstallUpdates: false, syncOverrides: ['autoInstallUpdates'] });
  await syncSettings(await end(server), await end(desk));
  expect((await desk.call('settings.get', {})).autoInstallUpdates).toBe(false);
});
