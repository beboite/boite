<script lang="ts">
  import { Activity, ChevronRight, ShieldCheck, ArrowLeft, Coins, FlaskConical, Keyboard, Palette, Puzzle, Settings2, Users } from '@lucide/svelte';
  import KeyboardPage from './KeyboardPage.svelte';
  import PluginsPage from './PluginsPage.svelte';
  import { strings } from '../lib/strings';
  import type { SettingsTab, Store } from '../lib/store.svelte';
  import AccountsPage from './AccountsPage.svelte';
  import AppearancePage from './AppearancePage.svelte';
  import ExperimentsPage from './ExperimentsPage.svelte';
  import GeneralSettings from './GeneralSettings.svelte';
  import MachinesPage from './MachinesPage.svelte';
  import ResourcesPage from './ResourcesPage.svelte';
  import UsagePage from './UsagePage.svelte';

  let { store }: { store: Store } = $props();

  /** Providers, Plugins and Resources call nothing a paired device may call. */
  const OWNER_TABS: SettingsTab[] = ['accounts', 'plugins', 'resources'];

  const all: { id: SettingsTab; label: string; icon: typeof Settings2 }[] = [
    { id: 'general', label: strings.settings.tabs.general, icon: Settings2 },
    { id: 'machines', label: strings.machines.heading, icon: Activity },
    { id: 'appearance', label: strings.settings.tabs.appearance, icon: Palette },
    { id: 'keyboard', label: strings.settings.tabs.keyboard, icon: Keyboard },
    { id: 'accounts', label: strings.settings.tabs.accounts, icon: Users },
    { id: 'plugins', label: strings.settings.tabs.plugins, icon: Puzzle },
    { id: 'usage', label: strings.settings.tabs.usage, icon: Coins },
    { id: 'resources', label: strings.settings.tabs.resources, icon: ShieldCheck },
    { id: 'experiments', label: strings.settings.tabs.experiments, icon: FlaskConical }
  ];

  let children: Partial<Record<SettingsTab, { id: string; label: string }[]>> = $derived({
    accounts: store.providers.map(provider => ({id: `provider-${provider.id}`, label: provider.name})),
    appearance: [{id: 'theme', label: strings.settings.theme}],
    keyboard: [{id: 'shortcuts', label: strings.keyboard.heading}, {id: 'keybinding-file', label: strings.keyboard.file}],
    experiments: [{id: 'theme-grain', label: strings.experiments.themeGrain.title}, {id: 'session-import', label: strings.experiments.sessionImport.title}],
    general: [
      { id: 'phone', label: strings.phone.heading },
      { id: 'projects', label: strings.settings.projects },
      { id: 'background', label: strings.settings.background },
      { id: 'machines', label: strings.machines.heading },
      { id: 'devices', label: strings.settings.pairing.heading },
      { id: 'scheduler', label: strings.settings.scheduler },
      { id: 'core', label: strings.settings.core }
    ],
    resources: [
      { id: 'quiet', label: strings.protection.quiet },
      { id: 'limits', label: strings.protection.limits },
      { id: 'tasks', label: strings.protection.tasks }
    ]
  });
  let selectedSection = $state('');
  function jump(id: string) {
    selectedSection = id;
    document.getElementById(`settings-${id}`)?.scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start'});
  }

  let tabs = $derived(all.filter((tab) => store.owner || !OWNER_TABS.includes(tab.id)));
  /** A tab this client has no nav entry for lands on General rather than nowhere. */
  let tab = $derived(tabs.some((entry) => entry.id === store.settingsTab) ? store.settingsTab : 'general');
</script>

<div class="settings" data-testid="settings">
  <nav aria-label={strings.settings.heading}>
    <button type="button" class="ghost back" data-testid="settings-back" onclick={() => store.showChat()}>
      <ArrowLeft size={15} strokeWidth={1.75} />
      {strings.settings.back}
    </button>
    <h1>{strings.settings.heading}</h1>
    {#each tabs as entry (entry.id)}
      {@const Icon = entry.icon}
      <div class="category">
      <button
        type="button"
        class="ghost tab"
        class:active={tab === entry.id}
        data-testid="settings-tab-{entry.id}"
        aria-current={tab === entry.id ? 'page' : undefined}
        aria-expanded={children[entry.id] ? tab === entry.id : undefined}
        onclick={() => { selectedSection = ''; store.showSettings(entry.id); }}
      >
        <Icon size={15} strokeWidth={1.75} />
        <span>{entry.label}</span>
        {#if children[entry.id]}<ChevronRight size={14} class={tab === entry.id ? 'expanded' : ''} />{/if}
      </button>
      {#if children[entry.id]}
        <div class="subcategories" class:open={tab === entry.id} inert={tab !== entry.id}>
          <div>
            {#each children[entry.id] ?? [] as child (child.id)}
              {#if store.owner || child.id !== 'scheduler'}
                <button class="ghost subsection" class:chosen={selectedSection === child.id} onclick={() => jump(child.id)}>{child.label}</button>
              {/if}
            {/each}
          </div>
        </div>
      {/if}
      </div>
    {/each}
  </nav>

  {#if children[tab]}
    <div class="mobile-subcategories">
      {#each children[tab] ?? [] as child (child.id)}
        {#if store.owner || child.id !== 'scheduler'}
          <button class="ghost" class:active={selectedSection === child.id} onclick={() => jump(child.id)}>{child.label}</button>
        {/if}
      {/each}
    </div>
  {/if}

  <!-- The panel is keyed on the tab, so switching tabs fades the new page in
       rather than swapping it in one frame. -->
  {#key tab}
    <section>
      {#if tab === 'general'}
        <GeneralSettings {store} />
      {:else if tab === 'machines'}
        <MachinesPage />
      {:else if tab === 'appearance'}
        <AppearancePage />
      {:else if tab === 'keyboard'}
        <KeyboardPage {store} />
      {:else if tab === 'accounts'}
        <AccountsPage {store} />
      {:else if tab === 'usage'}
        <UsagePage {store} />
      {:else if tab === 'plugins'}
        <PluginsPage {store} />
      {:else if tab === 'experiments'}
        <ExperimentsPage />
      {:else}
        <ResourcesPage {store} />
      {/if}
    </section>
  {/key}
</div>

<style>
  .mobile-subcategories { display: none; }
  .category { flex: none; }
  .tab span { flex: 1; text-align: left; }
  .tab :global(svg:last-child) { transition: transform var(--dur-3) var(--ease-out-quint); }
  .tab :global(.expanded) { transform: rotate(90deg); }
  .subcategories { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows var(--dur-3) var(--ease-out-quint), opacity var(--dur-2); }
  .subcategories.open { grid-template-rows: 1fr; opacity: 1; }
  .subcategories > div { overflow: hidden; min-height: 0; }
  .subsection { display: flex; justify-content: flex-start; width: calc(100% - 24px); margin-left: 24px; padding-left: 15px; border-left: 1px solid var(--color-edge); border-radius: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .subsection.chosen { color: var(--color-foreground); border-left-color: var(--color-foreground); background: var(--color-hover); }
  @media (prefers-reduced-motion: reduce) { .subcategories, .tab :global(svg:last-child) { transition: none; } }

  .settings {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  nav {
    width: 240px;
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 20px 14px;
    overflow-y: auto;
    border-right: 1px solid var(--color-border);
    background: var(--color-surface);
  }

  .back {
    justify-content: flex-start;
    margin-bottom: 8px;
  }

  h1 {
    padding: 4px 10px 10px;
    font-size: var(--text-md);
  }

  .tab {
    justify-content: flex-start;
    width: 100%;
    height: var(--control-lg, 40px);
    padding: 0 10px;
    color: var(--color-muted-foreground);
  }

  /* A full width row does not shrink under the finger, it fills one step more. */
  .tab:active:not(:disabled) {
    transform: none;
    background: color-mix(in srgb, var(--color-surface-3) 85%, var(--color-foreground));
  }

  .tab.active {
    background: var(--color-active);
    color: var(--color-foreground);
  }

  section {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    animation: fade var(--dur-2) var(--ease-out-quint);
  }

  @media (max-width: 720px) {
    .settings {
      flex-direction: column;
    }

    nav {
      width: auto;
      display: flex;
      flex-direction: row;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 8px 12px;
      align-items: flex-start;
      border-right: none;
      border-bottom: 1px solid var(--color-border);
    }

    .subcategories { display: none; }
    .mobile-subcategories { display: flex; gap: 4px; padding: 8px 14px; overflow-x: auto; flex: none; border-bottom: 1px solid var(--color-border); }
    .mobile-subcategories button { flex: none; font-size: var(--text-sm); }
    .back { display: none; }
    .category { min-width: 0; }
    h1 {
      display: none;
    }
  }
</style>
