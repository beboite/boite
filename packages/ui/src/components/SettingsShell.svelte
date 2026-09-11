<script lang="ts">
  import { Activity, ArrowLeft, Coins, FlaskConical, Keyboard, Palette, Puzzle, Settings2, Users } from '@lucide/svelte';
  import KeyboardPage from './KeyboardPage.svelte';
  import PluginsPage from './PluginsPage.svelte';
  import { strings } from '../lib/strings';
  import type { SettingsTab, Store } from '../lib/store.svelte';
  import AccountsPage from './AccountsPage.svelte';
  import AppearancePage from './AppearancePage.svelte';
  import ExperimentsPage from './ExperimentsPage.svelte';
  import GeneralSettings from './GeneralSettings.svelte';
  import ResourcesPage from './ResourcesPage.svelte';
  import UsagePage from './UsagePage.svelte';

  let { store }: { store: Store } = $props();

  const tabs: { id: SettingsTab; label: string; icon: typeof Settings2 }[] = [
    { id: 'general', label: strings.settings.tabs.general, icon: Settings2 },
    { id: 'appearance', label: strings.settings.tabs.appearance, icon: Palette },
    { id: 'keyboard', label: strings.settings.tabs.keyboard, icon: Keyboard },
    { id: 'accounts', label: strings.settings.tabs.accounts, icon: Users },
    { id: 'plugins', label: strings.settings.tabs.plugins, icon: Puzzle },
    { id: 'usage', label: strings.settings.tabs.usage, icon: Coins },
    { id: 'resources', label: strings.settings.tabs.resources, icon: Activity },
    { id: 'experiments', label: strings.settings.tabs.experiments, icon: FlaskConical }
  ];
</script>

<div class="settings" data-testid="settings">
  <nav>
    <button type="button" class="ghost back" data-testid="settings-back" onclick={() => store.showChat()}>
      <ArrowLeft size={15} strokeWidth={1.75} />
      {strings.settings.back}
    </button>
    <h1>{strings.settings.heading}</h1>
    {#each tabs as tab (tab.id)}
      {@const Icon = tab.icon}
      <button
        type="button"
        class="ghost tab"
        class:active={store.settingsTab === tab.id}
        data-testid="settings-tab-{tab.id}"
        aria-current={store.settingsTab === tab.id ? 'page' : undefined}
        onclick={() => store.showSettings(tab.id)}
      >
        <Icon size={15} strokeWidth={1.75} />
        {tab.label}
      </button>
    {/each}
  </nav>

  <!-- The panel is keyed on the tab, so switching tabs fades the new page in
       rather than swapping it in one frame. -->
  {#key store.settingsTab}
    <section>
      {#if store.settingsTab === 'general'}
        <GeneralSettings {store} />
      {:else if store.settingsTab === 'appearance'}
        <AppearancePage />
      {:else if store.settingsTab === 'keyboard'}
        <KeyboardPage {store} />
      {:else if store.settingsTab === 'accounts'}
        <AccountsPage {store} />
      {:else if store.settingsTab === 'usage'}
        <UsagePage {store} />
      {:else if store.settingsTab === 'plugins'}
        <PluginsPage {store} />
      {:else if store.settingsTab === 'experiments'}
        <ExperimentsPage />
      {:else}
        <ResourcesPage {store} />
      {/if}
    </section>
  {/key}
</div>

<style>
  .settings {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  nav {
    width: 220px;
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 10px;
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
    height: var(--row);
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
      flex-direction: row;
      flex-wrap: wrap;
      border-right: none;
      border-bottom: 1px solid var(--color-border);
    }

    h1 {
      display: none;
    }
  }
</style>
