<script lang="ts">
  import { ArrowLeft, Bell, ChevronRight, Monitor, Palette } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { strings } from '../lib/strings';
  import { mobileOverlay } from '../lib/mobile-history';
  import AppearancePage from './AppearancePage.svelte';
  import MachinesPage from './MachinesPage.svelte';
  import PhoneSettings from './PhoneSettings.svelte';

  let { store }: { store: Store } = $props();
  let phone = $state(false);
  let page = $derived(store.settingsTab === 'appearance' || store.settingsTab === 'machines'
    ? store.settingsTab : phone ? 'phone' : 'home');
  let machine = $derived(workspace.machines.find(machine => machine.store === store));
  let title = $derived(page === 'phone' ? strings.mobile.settingsPhone
    : page === 'appearance' ? strings.settings.tabs.appearance : strings.machines.heading);
  let detail = $derived(page !== 'home');
  $effect(() => { if (detail) return mobileOverlay(back); });

  $effect(() => {
    if (page === 'phone' && store.connection === 'ready') void store.loadSessions();
  });
  function back() { phone = false; store.showSettings('general'); }
</script>

<div class="mobile-settings" data-testid="settings">
  {#if page === 'home'}
    <div class="home" data-testid="mobile-settings-home">
      <h1>{strings.settings.heading}</h1>
      <section aria-labelledby="phone-preferences">
        <h2 id="phone-preferences">{strings.mobile.settingsDevice}</h2>
        <p>{strings.mobile.settingsDeviceHint}</p>
        <div class="rows">
          <button class="ghost row" data-testid="mobile-settings-phone" onclick={() => { phone = true; }}>
            <Bell size={20} /><span><strong>{strings.mobile.settingsPhone}</strong><small>{strings.mobile.settingsPhoneHint}</small></span><ChevronRight size={18} />
          </button>
          <button class="ghost row" data-testid="settings-tab-appearance" onclick={() => store.showSettings('appearance')}>
            <Palette size={20} /><span><strong>{strings.settings.tabs.appearance}</strong><small>{strings.mobile.settingsAppearanceHint}</small></span><ChevronRight size={18} />
          </button>
        </div>
      </section>
      <section aria-labelledby="remote-machines">
        <h2 id="remote-machines">{strings.machines.heading}</h2>
        <div class="rows">
          <button class="ghost row" data-testid="settings-tab-machines" onclick={() => store.showSettings('machines')}>
            <Monitor size={20} /><span><strong>{strings.connection.manage}</strong><small>{strings.mobile.settingsMachinesHint}</small></span><ChevronRight size={18} />
          </button>
        </div>
        <p>{strings.mobile.settingsRemoteHint}</p>
      </section>
    </div>
  {:else}
    <header>
      <button class="ghost icon" data-testid="mobile-settings-back" aria-label={strings.mobile.settingsBack} onclick={back}><ArrowLeft size={20} /></button>
      <h1>{title}</h1>
    </header>
    <div class="detail" data-testid="mobile-settings-detail">
      {#if page === 'phone'}
        <div class="page phone-page">
          <p class="scope" data-testid="mobile-settings-scope">{machine?.label ?? store.endpointUrl ?? strings.connection.current} · {strings.connection[store.connection]}</p>
          <PhoneSettings {store} showServerSettings={false} />
        </div>
      {:else if page === 'appearance'}
        <AppearancePage />
      {:else}
        <MachinesPage mobile />
      {/if}
    </div>
  {/if}
</div>

<style>
  .mobile-settings { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .home, .detail { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .home { padding: 20px 16px; }
  h1 { font-size: var(--text-lg); margin: 0; }
  section { margin-top: 28px; }
  h2 { font-size: var(--text-sm); font-weight: 500; color: var(--color-muted-foreground); margin: 0 0 8px; }
  p { font-size: var(--text-sm); color: var(--color-muted-foreground); line-height: 1.5; margin: 8px 0 12px; }
  .rows { border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; background: var(--color-surface); }
  .row { display: flex; width: 100%; height: auto; min-height: 72px; gap: 12px; padding: 16px; text-align: left; border-radius: 0; white-space: normal; }
  .row + .row { border-top: 1px solid var(--color-border); }
  .row span { flex: 1; min-width: 0; }
  .row :global(svg) { flex: none; }
  strong { display: block; font-size: var(--text-base); font-weight: 500; }
  small { display: block; margin-top: 4px; font-size: var(--text-sm); color: var(--color-muted-foreground); line-height: 1.45; }
  header { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--color-border); }
  header .icon { width: 44px; min-height: 44px; }
  header h1 { font-size: var(--text-md); }
  .phone-page { padding: 16px; }
  .scope { overflow-wrap: anywhere; }
  .phone-page :global(.card) { padding: 18px; }
  .detail :global(.page), .detail :global(.machines-page) { padding: 16px; }
  .detail :global(.page > header), .detail :global(.machines-page > h1) { display: none; }
  .detail :global(.switch-row) { flex-wrap: wrap; gap: 12px; }
</style>
