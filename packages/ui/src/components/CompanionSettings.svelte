<!--
  Settings, Companion: where the desktop companion sits and what it runs on.
  The preferences are this computer's (`lib/companion/prefs.ts`); the
  companion's window follows each change as it is made.
-->
<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import { defaultTitleModel, providerEnabled, type ModelInfo } from '@boite/contracts';
  import InfoTip from './InfoTip.svelte';
  import Menu from './Menu.svelte';
  import { separator, type MenuItem } from '../lib/menu';
  import { DEFAULT_MODEL_NAMES } from '../lib/model-defaults';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { readCompanionPrefs, subscribeCompanionPrefs, writeCompanionPrefs, type CompanionAnchor, type CompanionControl, type CompanionPrefs } from '../lib/companion/prefs';
  import { companionMonitors, inShell, type CompanionMonitor } from '../lib/companion/shell';

  let { store }: { store: Store } = $props();

  const AUTO = 'auto';
  const PRIMARY = 'primary';
  const copy = $derived(strings.companion.settings);

  let prefs = $state<CompanionPrefs>(readCompanionPrefs());
  let monitors = $state.raw<CompanionMonitor[]>([]);
  let started = $state(false);

  $effect(() => subscribeCompanionPrefs((next) => (prefs = next)));
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

  const ANCHORS: CompanionAnchor[] = ['left', 'center', 'right'];
  let anchorItems = $derived<MenuItem[]>(ANCHORS.map((anchor) => ({ id: anchor, label: copy.anchors[anchor], active: prefs.anchor === anchor })));

  const CONTROLS: CompanionControl[] = ['ask', 'auto'];
  let controlItems = $derived<MenuItem[]>(CONTROLS.map((control) => ({ id: control, label: copy.controls[control], hint: copy.controlsHint[control], active: prefs.control === control })));

  function save(patch: Partial<CompanionPrefs>) {
    prefs = writeCompanionPrefs(patch);
    if (prefs.threadId === null) started = false;
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
      <span class="text ui-label-box"><span class="ui-label">{copy.closeOutside}</span><InfoTip topic={copy.closeOutside} text={copy.closeOutsideHint} /></span>
      <input type="checkbox" role="switch" checked={prefs.closeOutside} onchange={(event) => save({ closeOutside: event.currentTarget.checked })} data-testid="companion-close-outside" />
    </label>
  </section>

  <section class="card">
    <h2>{copy.conversation}</h2>
    <p class="hint">{started ? copy.started : copy.newConversationHint}</p>
    <div class="actions">
      <button class="ghost" onclick={restart} disabled={prefs.threadId === null} data-testid="companion-restart">{copy.newConversation}</button>
      {#if prefs.threadId}
        <button class="ghost" onclick={openConversation}>{copy.openConversation}</button>
      {/if}
    </div>
  </section>
</div>

<style>
  .current {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 26ch;
  }
</style>
