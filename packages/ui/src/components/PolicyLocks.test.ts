import { afterEach, expect, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { SPEECH_CATALOGUE, type SpeechConfig, type SpeechStatus } from '@boite/contracts';
import { test } from '../test/fake-client';
import type { Store } from '../lib/store.svelte';
import { policyFixture } from '../lib/fake-client/policy';
import { contactsOf } from '../lib/contacts.svelte';
import { workspace } from '../lib/workspace.svelte';
import { machineName } from '../lib/live-view.svelte';
import { fill, strings } from '../lib/strings';
import PolicyBanner from './PolicyBanner.svelte';
import PolicySettings from './PolicySettings.svelte';
import TelemetrySettings from './TelemetrySettings.svelte';
import HarnessUpdatesCard from './HarnessUpdatesCard.svelte';
import PhoneSettings from './PhoneSettings.svelte';
import GroupCard from './GroupCard.svelte';
import SubscriptionProxySettings from './SubscriptionProxySettings.svelte';
import GatewaySwitch from './GatewaySwitch.svelte';
import LimitsPage from './LimitsPage.svelte';
import PluginsMachine from './PluginsMachine.svelte';
import DiagnosticsPage from './DiagnosticsPage.svelte';
import VoiceSettings from './VoiceSettings.svelte';
import AccountsPage from './AccountsPage.svelte';
import AgentBrowserSurface from './AgentBrowserSurface.svelte';
import AddContact from './home/AddContact.svelte';

/*
 * Every control an admin policy holds, drawn from the in-memory core with a
 * policy file: disabled, with the lock and the "i" that names the key and the
 * file. A surface that forgets its lock lets the user click into the core's
 * refusal instead of reading why beforehand.
 */

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted, { outro: false });
  mounted = undefined;
  document.body.innerHTML = '';
});

const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const find = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const byId = <T extends Element = HTMLElement>(id: string) => find<T>(`[data-testid="${id}"]`);
const lockOf = (key: string) => find(`[data-testid="policy-lock"][data-key="${key}"]`);
const show = async <Props extends Record<string, any>>(component: Component<Props>, props: Props) => {
  mounted = mount(component, { target: document.body, props });
  await settle();
};

/** A store on the fake core with `kind`'s policy file read. */
async function managed(ready: (options?: { delayMs: number; policy: ReturnType<typeof policyFixture> }) => Promise<{ store: Store }>, kind = 'managed') {
  const { store } = await ready({ delayMs: 0, policy: policyFixture(kind) });
  await vi.waitFor(() => expect(store.policy?.present).toBe(true));
  return store;
}

test('Settings lists the policy file and every key it holds, with its value; a machine without one shows nothing', async ({ ready }) => {
  const store = await managed(ready);
  await show(PolicySettings, { store });
  expect(byId('policy-file')?.textContent).toBe('/etc/boite/policy.json');
  const rows = [...document.querySelectorAll('[data-testid="policy-key"]')];
  expect(rows.map((row) => row.getAttribute('data-key'))).toEqual(store.policy!.locked);
  const row = (key: string) => rows.find((entry) => entry.getAttribute('data-key') === key)?.textContent ?? '';
  expect(row('analytics')).toContain(strings.policy.values.basic);
  expect(row('providers.deny')).toContain('Grok');
  expect(row('agentBrowser.searchUrl')).toContain('https://search.example.com/?q={query}');
  await unmount(mounted!, { outro: false });

  const { store: plain } = await ready({ delayMs: 0, policy: policyFixture(null) });
  await show(PolicySettings, { store: plain });
  expect(byId('policy-settings')).toBeNull();
});

test('a policy file with problems puts a banner with the file, the field and what was expected; one that does not parse says it failed closed', async ({ ready }) => {
  const store = await managed(ready, 'broken');
  await show(PolicyBanner, { store });
  const problems = [...document.querySelectorAll('[data-testid="policy-problem"]')];
  expect(problems.map((row) => row.getAttribute('data-field'))).toEqual(['updates.app', 'telemetry']);
  expect(problems[0]!.textContent).toContain('/etc/boite/policy.json');
  expect(problems[0]!.textContent).toContain(fill(strings.policy.problem, { field: 'updates.app', expected: '"off" or "check" or "auto"' }));
  expect(byId('policy-banner-closed')).toBeNull();
  await unmount(mounted!, { outro: false });

  const closed = await managed(ready, 'closed');
  await show(PolicyBanner, { store: closed });
  expect(byId('policy-banner-closed')?.textContent).toBe(strings.policy.failedClosed);
  await unmount(mounted!, { outro: false });

  await show(PolicyBanner, { store: await managed(ready) });
  expect(byId('policy-banner')).toBeNull();
});

test('analytics capped at basic keeps the enhanced switch off and locked, and its tip names the key and the file', async ({ ready }) => {
  const store = await managed(ready);
  await show(TelemetrySettings, { store });
  expect(byId<HTMLInputElement>('telemetry-enhanced')?.disabled).toBe(true);
  expect(byId<HTMLInputElement>('telemetry-basic')?.disabled).toBe(false);
  lockOf('analytics')!.querySelector<HTMLButtonElement>('[data-testid="policy-lock-tip"]')!.click();
  flushSync();
  expect(byId('policy-lock-tip-text')?.textContent).toBe(fill(strings.policy.lockedHint, { key: 'analytics', file: '/etc/boite/policy.json' }));
});

test('agent updates turned off: no check, no automatic switch, both locked', async ({ ready }) => {
  const store = await managed(ready);
  await show(HarnessUpdatesCard, { store });
  expect(byId<HTMLButtonElement>('harness-updates-check')?.disabled).toBe(true);
  expect(byId<HTMLInputElement>('setting-auto-update-harnesses')?.disabled).toBe(true);
  expect(lockOf('updates.agents')).not.toBeNull();
});

test('the network keys hold the local network switch and Tailscale serving', async ({ ready }) => {
  const store = await managed(ready);
  await show(PhoneSettings, { store });
  expect(byId<HTMLInputElement>('setting-listen-on-lan')?.disabled).toBe(true);
  expect(lockOf('network.lan')).not.toBeNull();
  await vi.waitFor(() => expect(byId('tailscale-access')?.getAttribute('data-state')).toBe('off'));
  expect(byId<HTMLButtonElement>('tailscale-enable')?.disabled).toBe(true);
  expect(lockOf('network.tailscaleServe')).not.toBeNull();
});

test('groups turned off: an invitation from another group cannot be joined', async ({ ready }) => {
  const store = await managed(ready);
  await show(GroupCard, { store });
  const input = byId<HTMLInputElement>('group-join-input');
  if (!input) return expect.unreachable('a machine alone offers to join a group');
  input.value = 'boite-group:invite';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(byId<HTMLButtonElement>('group-join')?.disabled).toBe(true);
  expect(input.disabled).toBe(true);
  // Enter submits the form whatever the button says: the join is still not sent.
  const joinGroup = vi.spyOn(store, 'joinGroup');
  input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  flushSync();
  expect(joinGroup).not.toHaveBeenCalled();
  expect(lockOf('network.groups')).not.toBeNull();
});

test('the gateway turned off: its settings cannot turn it on or save it, and the Limits switch stays off', async ({ ready }) => {
  const store = await managed(ready);
  await show(SubscriptionProxySettings, { store });
  expect(byId<HTMLInputElement>('subscription-proxy-enabled')?.disabled).toBe(true);
  for (const save of document.querySelectorAll<HTMLButtonElement>('[data-testid="subscription-proxy-save"]')) expect(save.disabled).toBe(true);
  // Enter submits the form whatever the button says: nothing is saved.
  const call = vi.spyOn(store.client!, 'call');
  for (const form of document.querySelectorAll('form')) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  flushSync();
  expect(call.mock.calls.filter(([method]) => method === 'subscriptionProxy.configure')).toEqual([]);
  call.mockRestore();
  expect(lockOf('gateway')).not.toBeNull();
  await unmount(mounted!, { outro: false });

  store.settings = { ...store.settings!, subscriptionProxy: { enabled: false, kind: 'douane', baseUrl: 'http://gateway.test:8787', dashboardUrl: 'http://gateway.test:8787/admin/' } };
  await show(GatewaySwitch, { store });
  expect(byId<HTMLInputElement>('gateway-switch-input')?.disabled).toBe(true);
  expect(lockOf('gateway')).not.toBeNull();
});

test('a gateway address outside the allowed ones cannot be turned on; an allowed one can', async ({ ready }) => {
  const policy = policyFixture('managed');
  policy.values = { gateway: { allowedBaseUrls: ['https://gateway.corp.example'] } };
  policy.locked = ['gateway.allowedBaseUrls'];
  const { store } = await ready({ delayMs: 0, policy });
  await vi.waitFor(() => expect(store.policy?.present).toBe(true));
  store.settings = { ...store.settings!, subscriptionProxy: { enabled: false, kind: 'douane', baseUrl: 'http://gateway.test:8787', dashboardUrl: 'http://gateway.test:8787/admin/' } };
  await show(GatewaySwitch, { store });
  expect(byId<HTMLInputElement>('gateway-switch-input')?.disabled).toBe(true);
  expect(lockOf('gateway.allowedBaseUrls')).not.toBeNull();
  store.settings = { ...store.settings!, subscriptionProxy: { ...store.settings!.subscriptionProxy!, baseUrl: 'https://gateway.corp.example/v1' } };
  flushSync();
  expect(byId<HTMLInputElement>('gateway-switch-input')?.disabled).toBe(false);
  // Nothing holds an allowed address, so no lock says otherwise.
  expect(lockOf('gateway.allowedBaseUrls')).toBeNull();
});

test('quota reads turned off: the page is locked and every account says why instead of drawing limits', async ({ ready }) => {
  const store = await managed(ready);
  await show(LimitsPage, { store });
  expect(lockOf('quotaReads')).not.toBeNull();
  expect(byId('limits-policy')?.textContent).toBe(strings.policy.quotasOff);
  // The fake answers as the core does: every account it would read stands disabled, saying why, with nothing read.
  const rows = await store.client!.call('quotas.list', {});
  const read = rows.filter((row) => row.status !== 'unsupported');
  expect(read.length).toBeGreaterThan(0);
  for (const row of read) {
    expect(row).toMatchObject({ status: 'disabled', windows: [], error: "Quota reads: blocked by your organization's policy, key quotaReads in /etc/boite/policy.json" });
    expect(row.resetCredits).toBeUndefined();
  }
  await settle();
  expect(document.querySelector('[data-testid="usage-limit-primary"]')).toBeNull();
  expect(byId('quota-use-reset')).toBeNull();
});

test('plugin installs turned off: no link to read, no install, while removing stays open', async ({ ready }) => {
  const store = await managed(ready);
  await store.client!.call('plugins.uninstall', { id: 'bots' });
  await show(PluginsMachine, { store });
  await vi.waitFor(() => expect(find('[data-testid="plugin-install"][data-plugin="bots"]')).not.toBeNull());
  expect(find<HTMLButtonElement>('[data-testid="plugin-install"][data-plugin="bots"]')?.disabled).toBe(true);
  const removes = document.querySelectorAll<HTMLButtonElement>('[data-testid="plugin-uninstall"]');
  expect(removes.length).toBeGreaterThan(0);
  for (const remove of removes) expect(remove.disabled).toBe(false);
  expect(byId<HTMLInputElement>('plugin-url')?.disabled).toBe(true);
  expect(byId<HTMLButtonElement>('plugin-inspect')?.disabled).toBe(true);
  expect(lockOf('plugins.install')).not.toBeNull();
});

test('issue reports turned off hide the report button; the anonymized export stays', async ({ ready }) => {
  const store = await managed(ready);
  await show(DiagnosticsPage, { store });
  await vi.waitFor(() => expect(byId('diagnostics-export')).not.toBeNull());
  expect(byId('diagnostics-report')).toBeNull();
});

test('a report dialog the lock closed does not reopen by itself when the lock lifts', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0, policy: policyFixture(null) });
  await show(DiagnosticsPage, { store });
  await vi.waitFor(() => expect(byId<HTMLButtonElement>('diagnostics-report')?.disabled).toBe(false));
  byId<HTMLButtonElement>('diagnostics-report')!.click();
  flushSync();
  expect(byId('diagnostics-report-dialog')).not.toBeNull();
  client.changePolicy(policyFixture('managed'));
  await vi.waitFor(() => expect(byId('diagnostics-report-dialog')).toBeNull());
  client.changePolicy(policyFixture(null));
  await vi.waitFor(() => expect(byId('diagnostics-report')).not.toBeNull());
  expect(byId('diagnostics-report-dialog')).toBeNull();
});

const speechStatus = (): SpeechStatus => ({
  revision: 'r1', engine: 'local', ready: false, localReady: false, groqKeySet: false, openrouterKeySet: false,
  installing: false, downloadedBytes: 0, totalBytes: 1, error: null, canInstallRuntime: true, downloading: null, runtimeOutdated: false,
  models: SPEECH_CATALOGUE.map((entry) => ({ id: entry.id, kind: 'catalogue' as const, name: entry.name, bytes: entry.bytes, tier: entry.tier, legacy: entry.legacy, installed: false })),
});
const speechConfig: SpeechConfig = { engine: 'local', language: '', apiProvider: 'groq', fallback: false, executable: '', modelPath: '', model: 'small-q5_1' };
const voiceStore = (kind: string, config: SpeechConfig = speechConfig) => ({
  client: { call: async (method: string) => method === 'speech.config' ? config : speechStatus() },
  connection: 'ready', owner: true, core: { hostname: 'build-box' }, policy: policyFixture(kind),
}) as unknown as Store;

test('dictation held to local keeps the cloud engine and its fallback off; dictation off holds the local engine and its download too', async () => {
  await show(VoiceSettings, { store: voiceStore('managed') });
  await vi.waitFor(() => expect(byId('voice-api')).not.toBeNull());
  expect(byId<HTMLButtonElement>('voice-api')?.disabled).toBe(true);
  expect(byId<HTMLButtonElement>('voice-local')?.disabled).toBe(false);
  expect(byId<HTMLButtonElement>('voice-install')?.disabled).toBe(false);
  expect(lockOf('dictation')).not.toBeNull();
  await unmount(mounted!, { outro: false });

  await show(VoiceSettings, { store: voiceStore('closed') });
  await vi.waitFor(() => expect(byId('voice-api')).not.toBeNull());
  expect(byId<HTMLButtonElement>('voice-local')?.disabled).toBe(true);
  expect(byId<HTMLButtonElement>('voice-install')?.disabled).toBe(true);
  expect(byId<HTMLInputElement>('voice-executable')?.disabled).toBe(true);
  expect(byId<HTMLInputElement>('voice-model-path')?.disabled).toBe(true);
  await unmount(mounted!, { outro: false });

  // A cloud engine saved before the policy: its provider and keys are held too.
  await show(VoiceSettings, { store: voiceStore('managed', { ...speechConfig, engine: 'api' }) });
  await vi.waitFor(() => expect(byId('voice-provider-groq')).not.toBeNull());
  expect(byId<HTMLButtonElement>('voice-provider-groq')?.disabled).toBe(true);
  expect(byId<HTMLInputElement>('voice-groq-key')?.disabled).toBe(true);
  expect(byId<HTMLInputElement>('voice-openrouter-key')?.disabled).toBe(true);
});

test('a provider the policy denies stays listed, off, saying so, with a lock and no switch to turn it back on', async ({ ready }) => {
  const store = await managed(ready);
  await vi.waitFor(() => expect(store.providers.find((provider) => provider.id === 'grok')?.policy).toEqual({ policy: 'providers.deny', file: '/etc/boite/policy.json' }));
  await show(AccountsPage, { store });
  const row = find('[data-testid="provider-settings"][data-provider-id="grok"]')!;
  expect(row.getAttribute('data-enabled')).toBe('false');
  expect(row.textContent).toContain(strings.policy.providerOff);
  expect(row.querySelector<HTMLInputElement>('[data-testid="provider-enabled"]')?.disabled).toBe(true);
  expect(row.querySelector('[data-testid="policy-lock"][data-key="providers.deny"]')).not.toBeNull();
  // Another provider keeps its own switch.
  expect(find<HTMLInputElement>('[data-testid="provider-settings"][data-provider-id="codex"] [data-testid="provider-enabled"]')?.disabled).toBe(false);
});

test('the agent browser turned off says so in its panel instead of offering a page to open', async ({ ready }) => {
  const store = await managed(ready, 'closed');
  await show(AgentBrowserSurface, { store, threadId: 't-1' });
  expect(byId('agent-browser-policy')?.textContent).toContain(fill(strings.policy.browserOff, { machine: machineName(store) }));
  expect(lockOf('agentBrowser')).not.toBeNull();
  expect(byId('agent-browser-none')).toBeNull();
});

test('contacts turned off: no invitation of any kind and no join', async ({ ready }) => {
  const store = await managed(ready);
  workspace.machines = [{ id: 'local', label: 'Desktop', store }];
  workspace.active = store;
  const view = contactsOf(store);
  await view.refresh();
  await show(AddContact, { view });
  expect(byId<HTMLButtonElement>('contact-invite-tailnet')?.disabled).toBe(true);
  expect(byId<HTMLButtonElement>('contact-invite-create')?.disabled).toBe(true);
  const link = byId<HTMLInputElement>('contact-join-link')!;
  link.value = 'boite-contact:invite';
  link.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(byId<HTMLButtonElement>('contact-join')?.disabled).toBe(true);
  expect(lockOf('network.contacts')).not.toBeNull();
});
