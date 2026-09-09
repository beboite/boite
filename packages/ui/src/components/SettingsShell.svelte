<script lang="ts">
  import { Activity, ArrowLeft, Coins, Settings2, Users } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  import type { SettingsTab, Store } from '../lib/store.svelte';
  import AccountsPage from './AccountsPage.svelte';
  import GeneralSettings from './GeneralSettings.svelte';
  import ResourcesPage from './ResourcesPage.svelte';
  import UsagePage from './UsagePage.svelte';

  let { store }: { store: Store } = $props();

  const tabs: { id: SettingsTab; label: string; icon: typeof Settings2 }[] = [
    { id: 'general', label: strings.settings.tabs.general, icon: Settings2 },
    { id: 'accounts', label: strings.settings.tabs.accounts, icon: Users },
    { id: 'usage', label: strings.settings.tabs.usage, icon: Coins },
    { id: 'resources', label: strings.settings.tabs.resources, icon: Activity }
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

  <section>
    {#if store.settingsTab === 'general'}
      <GeneralSettings {store} />
    {:else if store.settingsTab === 'accounts'}
      <AccountsPage {store} />
    {:else if store.settingsTab === 'usage'}
      <UsagePage {store} />
    {:else}
      <ResourcesPage {store} />
    {/if}
  </section>
</div>

<style>
  .settings {
    display: flex;
    flex: 1;
    min-height: 0;
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
    height: 30px;
    padding: 0 10px;
    color: var(--color-muted-foreground);
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
