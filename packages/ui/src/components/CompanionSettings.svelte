<!--
  Settings, Companion: where the desktop companion sits and what it runs on.
  The preferences are this computer's (`lib/companion/prefs.ts`); the
  companion's window follows each change as it is made.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { ChevronDown } from '@lucide/svelte';
  import { defaultTitleModel, providerEnabled, type ModelInfo } from '@boite/contracts';
  import InfoTip from './InfoTip.svelte';
  import Menu from './Menu.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import { separator, type MenuItem } from '../lib/menu';
  import { DEFAULT_MODEL_NAMES } from '../lib/model-defaults';
  import { gatewayReader } from '../lib/quota-reader.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { hudGauges } from '../lib/companion/hud';
  import { COMPANION_HOTKEYS, readCompanionPrefs, subscribeCompanionPrefs, writeCompanionPrefs, type CompanionAnchor, type CompanionControl, type CompanionPrefs } from '../lib/companion/prefs';
  import { readStatus, subscribeCompanionData } from '../lib/companion/memory';
  import { companionMonitors, inShell, type CompanionMonitor } from '../lib/companion/shell';
  import CompanionMemory from './companion/CompanionMemory.svelte';

  let { store }: { store: Store } = $props();

  const AUTO = 'auto';
  const PRIMARY = 'primary';
  const copy = $derived(strings.companion.settings);

  let prefs = $state<CompanionPrefs>(readCompanionPrefs());
  let monitors = $state.raw<CompanionMonitor[]>([]);
  let started = $state(false);
  let status = $state(readStatus());

  $effect(() => subscribeCompanionPrefs((next) => (prefs = next)));
  $effect(() => subscribeCompanionData(() => (status = readStatus())));
  $effect(() => {
    void companionMonitors().then((list) => (monitors = list)).catch(() => {});
  });

  /** The agents that can answer: on, here, with an account signed in. */
  let usable = $derived(
    store.providers.filter((provider) => providerEnabled(provider) && provider.available).flatMap((provider) => {
      const accounts = store.accountsOf(provider.id).filter((account) => account.status === 'ok');
      return accounts.length > 0 ? [{ provider, accounts }] : [];
    })
  );

  // The lists each agent offers with its account, read once: the core keeps them.
  $effect(() => {
    for (const { provider, accounts } of usable) void store.probeModels(provider.id, accounts[0]!.id).catch(() => {});
  });

  const accountOf = (providerId: string) => {
    const accounts = usable.find((entry) => entry.provider.id === providerId)?.accounts ?? [];
    return accounts.find((account) => account.id === prefs.accountId) ?? accounts[0] ?? null;
  };

  let groups = $derived(
    usable.map(({ provider, accounts }) => {
      const account = provider.id === prefs.providerId ? (accountOf(provider.id) ?? accounts[0]!) : accounts[0]!;
      const offered = store.modelsOf(provider.id, account.id).filter((model) => model.id !== 'default');
      const small = defaultTitleModel(provider, offered);
      const named = (id: string): ModelInfo => offered.find((model) => model.id === id) ?? { id, name: DEFAULT_MODEL_NAMES[id] ?? id };
      const chosen = prefs.providerId === provider.id ? prefs.model : null;
      const ids = [small, chosen, ...offered.filter((model) => model.legacy !== true).map((model) => model.id)];
      return { provider, small, models: [...new Set(ids.filter((id): id is string => id !== null))].map(named) };
    })
  );

  const idOf = (providerId: string, model: string) => JSON.stringify([providerId, model]);

  let modelItems = $derived<MenuItem[]>([
    { id: AUTO, label: copy.automatic, hint: copy.automaticHint, active: prefs.providerId === null },
    ...groups.flatMap(({ provider, small, models }) => [
      separator(`sep-${provider.id}`),
      ...models.map((model) => ({
        id: idOf(provider.id, model.id),
        label: model.name,
        hint: provider.shortName,
        active: prefs.providerId === provider.id && (prefs.model ?? small) === model.id
      }))
    ])
  ]);

  let group = $derived(groups.find((entry) => entry.provider.id === prefs.providerId));
  let modelId = $derived(group ? (prefs.model ?? group.small) : null);
  let model = $derived(group?.models.find((entry) => entry.id === modelId));
  let currentModel = $derived(prefs.providerId === null ? copy.automatic : model ? `${model.name} · ${group!.provider.shortName}` : (prefs.model ?? prefs.providerId));

  let accounts = $derived(usable.find((entry) => entry.provider.id === prefs.providerId)?.accounts ?? []);
  let account = $derived(prefs.providerId === null ? null : accountOf(prefs.providerId));
  let accountItems = $derived<MenuItem[]>(accounts.map((entry) => ({ id: entry.id, label: entry.label, active: entry.id === account?.id })));

  let levels = $derived(model?.effort?.levels ?? []);
  let effortItems = $derived<MenuItem[]>([
    { id: AUTO, label: copy.effortDefault, active: prefs.effort === null },
    ...levels.map((level) => ({ id: level.id, label: level.label, hint: level.description, active: prefs.effort === level.id }))
  ]);
  let currentEffort = $derived(levels.find((level) => level.id === prefs.effort)?.label ?? copy.effortDefault);

  let screenItems = $derived<MenuItem[]>([
    { id: PRIMARY, label: copy.primary, active: prefs.monitor === null },
    ...monitors.map((monitor) => ({
      id: monitor.name,
      label: monitor.name,
      hint: fill(copy.screenSize, { width: String(monitor.width), height: String(monitor.height) }),
      active: prefs.monitor === monitor.name
    }))
  ]);

  // Where it was dropped is offered once it has been dropped somewhere.
  let anchors = $derived<CompanionAnchor[]>(prefs.spot ? ['left', 'center', 'right', 'free'] : ['left', 'center', 'right']);
  let anchorItems = $derived<MenuItem[]>(anchors.map((anchor) => ({ id: anchor, label: copy.anchors[anchor], active: prefs.anchor === anchor })));

  const OFF = 'off';
  let hotkeyItems = $derived<MenuItem[]>([
    { id: OFF, label: copy.hotkeyOff, active: prefs.hotkey === null },
    ...COMPANION_HOTKEYS.map((hotkey) => ({ id: hotkey, label: hotkey, active: prefs.hotkey === hotkey }))
  ]);
  let hotkeyTaken = $derived(prefs.hotkey !== null && status.hotkeyError === prefs.hotkey);
  let warmMinutes = $derived(store.settings?.warmProcessMinutes ?? null);

  const CONTROLS: CompanionControl[] = ['ask', 'auto'];
  let controlItems = $derived<MenuItem[]>(CONTROLS.map((control) => ({ id: control, label: copy.controls[control], hint: copy.controlsHint[control], active: prefs.control === control })));

  const WORK_MINUTES = [15, 20, 25, 30, 45, 50, 60, 90];
  const BREAK_MINUTES = [3, 5, 10, 15];
  const minutesLabel = (count: number) => fill(copy.minutes, { count: String(count) });
  const minuteItems = (choices: number[], current: number): MenuItem[] =>
    [...new Set([...choices, current])].sort((a, b) => a - b).map((count) => ({ id: String(count), label: minutesLabel(count), active: count === current }));
  let workItems = $derived(minuteItems(WORK_MINUTES, prefs.workMinutes));
  let breakItems = $derived(minuteItems(BREAK_MINUTES, prefs.breakMinutes));

  function save(patch: Partial<CompanionPrefs>) {
    prefs = writeCompanionPrefs(patch);
    if (prefs.threadId === null) started = false;
  }

  /** The gateway's subscriptions, as the companion draws them, to pick the ones it shows. */
  let gateway = $derived(gatewayReader(store.endpointUrl ?? 'here'));
  let gauges = $derived(hudGauges(gateway.state));
  $effect(() => {
    const client = store.client;
    const current = gateway;
    if (!client || !store.owner || store.connection !== 'ready' || !prefs.quotas) return;
    const off = client.on('subscriptionProxy.quotasUpdated', (value) => current.accept(value));
    untrack(() => void current.read(client));
    return off;
  });

  function showQuota(id: string, shown: boolean) {
    const others = prefs.hiddenQuotas.filter((hidden) => hidden !== id);
    save({ hiddenQuotas: shown ? others : [...others, id] });
  }

  function pickModel(id: string) {
    if (id === AUTO) return save({ providerId: null, accountId: null, model: null, effort: null });
    const [providerId, model] = JSON.parse(id) as [string, string];
    save({ providerId, model, accountId: accountOf(providerId)?.id ?? null, effort: null });
  }

  function restart() {
    save({ threadId: null });
    started = true;
  }

  function openConversation() {
    if (!prefs.threadId) return;
    store.showChat();
    void store.open(prefs.threadId);
  }
</script>

{#snippet picker(label: string, hint: string | null, items: MenuItem[], current: string, onpick: (id: string) => void, testid: string)}
  <div class="switch-row">
    <span class="text ui-label-box">
      <span class="ui-label">{label}</span>{#if hint}<InfoTip topic={label} text={hint} />{/if}
    </span>
    <Menu {items} {onpick} {label} placement="bottom" align="end" {testid}>
      <span class="current ui-label">{current}</span><ChevronDown size={13} />
    </Menu>
  </div>
{/snippet}

<div class="page" data-testid="companion-settings">
  <header>
    <h1 class="ui-label-box"><span class="ui-label">{strings.companion.heading}</span><InfoTip topic={strings.companion.heading} text={copy.intro} /></h1>
  </header>

  {#if !inShell()}
    <section class="card"><p class="hint">{copy.desktopOnly}</p></section>
  {/if}

  <section class="card">
    <h2>{copy.place}</h2>
    {@render picker(copy.screen, copy.screenHint, screenItems, prefs.monitor ?? copy.primary, (id) => save({ monitor: id === PRIMARY ? null : id }), 'companion-screen')}
    {@render picker(copy.position, copy.positionHint, anchorItems, copy.anchors[prefs.anchor], (id) => save({ anchor: id as CompanionAnchor }), 'companion-position')}
    {@render picker(copy.hotkey, copy.hotkeyHint, hotkeyItems, prefs.hotkey ?? copy.hotkeyOff, (id) => save({ hotkey: id === OFF ? null : id }), 'companion-hotkey')}
    {#if hotkeyTaken}<p class="hint problem" role="alert">{fill(copy.hotkeyTaken, { hotkey: prefs.hotkey! })}</p>{/if}
  </section>

  <section class="card">
    <h2>{copy.brain}</h2>
    {@render picker(copy.model, copy.modelHint, modelItems, currentModel, pickModel, 'companion-model')}
    {#if accounts.length > 1}
      {@render picker(copy.account, null, accountItems, account?.label ?? '', (id) => save({ accountId: id }), 'companion-account')}
    {/if}
    {#if levels.length > 0}
      {@render picker(copy.effort, null, effortItems, currentEffort, (id) => save({ effort: id === AUTO ? null : id }), 'companion-effort')}
    {/if}
    {@render picker(copy.control, copy.controlHint, controlItems, copy.controls[prefs.control], (id) => save({ control: id as CompanionControl }), 'companion-control')}
    <p class="hint">{copy.controlsHint[prefs.control]}</p>
  </section>

  <section class="card">
    <label class="switch-row">
      <span class="text ui-label-box"><span class="ui-label">{copy.music}</span><InfoTip topic={copy.music} text={copy.musicHint} /></span>
      <input type="checkbox" role="switch" checked={prefs.music} onchange={(event) => save({ music: event.currentTarget.checked })} data-testid="companion-music" />
    </label>
    <label class="switch-row">
      <span class="text ui-label-box"><span class="ui-label">{copy.quotas}</span><InfoTip topic={copy.quotas} text={copy.quotasHint} /></span>
      <input type="checkbox" role="switch" checked={prefs.quotas} onchange={(event) => save({ quotas: event.currentTarget.checked })} data-testid="companion-quotas" />
    </label>
    {#if prefs.quotas && gauges.length > 0}
      <div class="quotas" role="group" aria-label={copy.quotasShown}>
        {#each gauges as gauge (gauge.id)}
          <label class="switch-row quota">
            <span class="text quota-name"><ProviderLogo providerId={gauge.providerId} size={16} /><span class="ui-label">{gauge.name}</span></span>
            <input type="checkbox" role="switch" checked={!prefs.hiddenQuotas.includes(gauge.id)} onchange={(event) => showQuota(gauge.id, event.currentTarget.checked)} data-testid="companion-quota" />
          </label>
        {/each}
      </div>
    {/if}
    <label class="switch-row">
      <span class="text ui-label-box"><span class="ui-label">{copy.closeOutside}</span><InfoTip topic={copy.closeOutside} text={copy.closeOutsideHint} /></span>
      <input type="checkbox" role="switch" checked={prefs.closeOutside} onchange={(event) => save({ closeOutside: event.currentTarget.checked })} data-testid="companion-close-outside" />
    </label>
    <label class="switch-row">
      <span class="text ui-label-box"><span class="ui-label">{copy.hideFullscreen}</span><InfoTip topic={copy.hideFullscreen} text={copy.hideFullscreenHint} /></span>
      <input type="checkbox" role="switch" checked={prefs.hideFullscreen} onchange={(event) => save({ hideFullscreen: event.currentTarget.checked })} data-testid="companion-hide-fullscreen" />
    </label>
    <label class="switch-row">
      <span class="text ui-label-box"><span class="ui-label">{copy.sounds}</span><InfoTip topic={copy.sounds} text={copy.soundsHint} /></span>
      <input type="checkbox" role="switch" checked={prefs.sounds} onchange={(event) => save({ sounds: event.currentTarget.checked })} data-testid="companion-sounds" />
    </label>
  </section>

  <section class="card">
    <h2 class="ui-label-box"><span class="ui-label">{copy.pomodoro}</span><InfoTip topic={copy.pomodoro} text={copy.pomodoroHint} /></h2>
    {@render picker(copy.workMinutes, null, workItems, minutesLabel(prefs.workMinutes), (id) => save({ workMinutes: Number(id) }), 'companion-work-minutes')}
    {@render picker(copy.breakMinutes, null, breakItems, minutesLabel(prefs.breakMinutes), (id) => save({ breakMinutes: Number(id) }), 'companion-break-minutes')}
    <label class="switch-row">
      <span class="text ui-label-box"><span class="ui-label">{copy.focusOnWork}</span><InfoTip topic={copy.focusOnWork} text={copy.focusOnWorkHint} /></span>
      <input type="checkbox" role="switch" checked={prefs.focusOnWork} onchange={(event) => save({ focusOnWork: event.currentTarget.checked })} data-testid="companion-focus-on-work" />
    </label>
  </section>

  <CompanionMemory />

  <section class="card">
    <h2>{copy.conversation}</h2>
    <p class="hint">{started ? copy.started : copy.newConversationHint}</p>
    <div class="actions">
      <button class="ghost" onclick={restart} disabled={prefs.threadId === null} data-testid="companion-restart">{copy.newConversation}</button>
      {#if prefs.threadId}
        <button class="ghost" onclick={openConversation}>{copy.openConversation}</button>
      {/if}
    </div>
    {#if warmMinutes !== null}
      <p class="hint warm">{warmMinutes > 0 ? fill(copy.warmOn, { minutes: String(warmMinutes) }) : copy.warmOff}</p>
      {#if warmMinutes === 0}
        <div class="actions"><button class="ghost" onclick={() => store.showSettings('advanced')} data-testid="companion-open-advanced">{copy.openAdvanced}</button></div>
      {/if}
    {/if}
  </section>
</div>

<style>
  /* Over `.settings .page .hint` in app.css. */
  .page .problem {
    color: var(--color-danger);
  }
  .page .warm {
    margin-top: 14px;
  }
  .current {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 26ch;
  }
  /* The subscriptions under "Show quotas", one switch each, set in under it. */
  .quotas {
    display: flex;
    flex-direction: column;
    margin: -8px 0 12px;
    padding-left: 14px;
    border-left: 2px solid var(--color-border);
  }
  .page .quotas .quota {
    min-height: 0;
    padding: 6px 0;
    border-top: none;
  }
  .page .quota .text {
    font-size: var(--text-sm);
    font-weight: 400;
  }
  .quota-name {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .quota-name .ui-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .quotas + .switch-row {
    border-top: 1px solid var(--color-border);
  }
</style>
