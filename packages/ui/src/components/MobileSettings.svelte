<script lang="ts">
  import TelemetrySettings from './TelemetrySettings.svelte';
  import { ArchiveRestore, ArrowLeft, Bell, Brain, ChevronRight, Coins, Compass, Gauge, Monitor, Palette, Mic } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { strings } from '../lib/strings';
  import { mobileOverlay } from '../lib/mobile-history';
  import { openTour } from '../lib/onboarding.svelte';
  import AppearancePage from './AppearancePage.svelte';
  import LimitsPage from './LimitsPage.svelte';
  import MachinesPage from './MachinesPage.svelte';
  import PhoneSettings from './PhoneSettings.svelte';
  import UsagePage from './UsagePage.svelte';
  import VoiceSettings from './VoiceSettings.svelte';
  import BrainPage from './BrainPage.svelte';
  import ArchivedThreads from './ArchivedThreads.svelte';

  let { store }: { store: Store } = $props();
  let phone = $state(false);
  /** The phone has no General page, so the archive, which lives there on the desktop, gets a page of its own. */
  let archived = $state(false);
  let page = $derived((store.owner && store.settingsTab === 'brain') || store.settingsTab === 'appearance' || store.settingsTab === 'machines' || store.settingsTab === 'voice' || store.settingsTab === 'usage' || store.settingsTab === 'limits'
    ? store.settingsTab : phone ? 'phone' : archived ? 'archived' : 'home');
  let machine = $derived(workspace.machines.find(machine => machine.store === store));
  let title = $derived(page === 'brain' ? strings.brain.heading : page === 'phone' ? strings.mobile.settingsPhone
    : page === 'archived' ? strings.settings.archived.heading
    : page === 'voice' ? strings.speech.heading : page === 'appearance' ? strings.settings.tabs.appearance
    : page === 'usage' ? strings.usage.heading : page === 'limits' ? strings.usage.limits : strings.machines.heading);
  let detail = $derived(page !== 'home');
  $effect(() => { if (detail) return mobileOverlay(back); });

  $effect(() => {
    if (page === 'phone' && store.connection === 'ready') void store.loadSessions();
  });
  function back() { phone = false; archived = false; store.showSettings('general'); }
</script>

<!-- `settings` gives the detail pages the same grammar as the desktop ones. -->
<div class="mobile-settings settings" data-testid="settings">
  {#key page}
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
          <button class="ghost row" data-testid="settings-tour" onclick={() => { store.showChat(); openTour(); }}>
            <Compass size={20} /><span><strong>{strings.onboarding.replay}</strong><small>{strings.onboarding.replayHint}</small></span><ChevronRight size={18} />
          </button>
        </div>
      </section>
      <section aria-labelledby="remote-machines">
        <h2 id="remote-machines">{strings.machines.heading}</h2>
        <div class="rows">
          <button class="ghost row" data-testid="settings-tab-machines" onclick={() => store.showSettings('machines')}>
            <Monitor size={20} /><span><strong>{strings.connection.manage}</strong><small>{strings.mobile.settingsMachinesHint}</small></span><ChevronRight size={18} />
          </button>
          {#if store.owner}<button class="ghost row" data-testid="settings-tab-brain" onclick={() => store.showSettings('brain')}><Brain size={20} /><span><strong>{strings.brain.heading}</strong><small>{strings.brain.description}</small></span><ChevronRight size={18} /></button>{/if}
          <button class="ghost row" data-testid="settings-tab-voice" onclick={() => store.showSettings('voice')}>
            <Mic size={20} /><span><strong>{strings.speech.heading}</strong><small>{strings.speech.phoneHint}</small></span><ChevronRight size={18} />
          </button>
          <button class="ghost row" data-testid="settings-tab-usage" onclick={() => store.showSettings('usage')}>
            <Coins size={20} /><span><strong>{strings.usage.heading}</strong><small>{strings.usage.phoneHint}</small></span><ChevronRight size={18} />
          </button>
          <button class="ghost row" data-testid="settings-tab-limits" onclick={() => store.showSettings('limits')}>
            <Gauge size={20} /><span><strong>{strings.usage.limits}</strong><small>{strings.usage.limitsIntro}</small></span><ChevronRight size={18} />
          </button>
          <button class="ghost row" data-testid="mobile-settings-archived" onclick={() => { archived = true; }}>
            <ArchiveRestore size={20} /><span><strong>{strings.settings.archived.heading}</strong><small>{strings.mobile.settingsArchivedHint}</small></span><ChevronRight size={18} />
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
      {#if page === 'brain' && store.owner}
        <BrainPage {store} />
      {:else if page === 'phone'}
        <div class="page phone-page">
          <p class="scope" data-testid="mobile-settings-scope">{machine?.label ?? store.endpointUrl ?? strings.connection.current} · {strings.connection[store.connection]}</p>
          <PhoneSettings {store} showServerSettings={false} />
          <TelemetrySettings {store} />
        </div>
      {:else if page === 'voice'}
        <VoiceSettings {store} readOnly />
      {:else if page === 'appearance'}
        <AppearancePage />
      {:else if page === 'usage'}
        <UsagePage {store} />
      {:else if page === 'limits'}
        <LimitsPage {store} />
      {:else if page === 'archived'}
        <div class="page archived-page">
          <p class="lead">{strings.settings.archived.intro}</p>
          <ArchivedThreads {store} />
        </div>
      {:else}
        <MachinesPage mobile />
      {/if}
    </div>
  {/if}
  {/key}
</div>

<style>
  .mobile-settings { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .home, .detail { animation: fade var(--dur-2) var(--ease-out-quint); min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .home { padding: 20px 16px; }
  h1 { font-size: var(--text-lg); margin: 0; }
  section { margin-top: 28px; }
  h2 { font-size: var(--text-sm); font-weight: 500; color: var(--color-muted-foreground); margin: 0 0 8px; }
  p { font-size: var(--text-sm); color: var(--color-muted-foreground); line-height: 1.5; margin: 8px 0 12px; }
  .rows { border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; background: var(--color-surface); }
  /* A ghost button is muted; a row title reads like any other settings label. */
  .row { display: flex; width: 100%; height: auto; min-height: 72px; gap: 12px; padding: 16px; text-align: left; border-radius: 0; white-space: normal; color: var(--color-foreground); }
  .row + .row { border-top: 1px solid var(--color-border); }
  .row span { flex: 1; min-width: 0; }
  .row :global(svg) { flex: none; color: var(--color-muted-foreground); }
  h2 + p { margin-top: 0; }
  strong { display: block; font-size: var(--text-base); font-weight: 500; }
  small { display: block; margin-top: 4px; font-size: var(--text-sm); color: var(--color-muted-foreground); line-height: 1.45; }
  header { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--color-border); }
  header .icon { width: 44px; min-height: 44px; }
  header h1 { font-size: var(--text-md); }
  .phone-page { padding: 16px; }
  .scope { overflow-wrap: anywhere; margin-top: 0; }
  .lead { margin-top: 0; }
  .phone-page :global(.card) { padding: 18px; }
  .detail :global(.page), .detail :global(.machines-page) { padding: 16px; }
  /* The bar above already names the page, so its own title steps aside. */
  .detail :global(.page:not(.machines-page):not(.usage) > header),
  .detail :global(.machines-page > .head h1),
  .detail :global(.usage > header h1) { display: none; }
  .detail :global(.switch-row) { flex-wrap: wrap; gap: 12px; }
  /* The bar names the page and the line above says what it holds: the card's own heading and tip step aside. */
  .archived-page :global(#settings-archived > h2) { display: none; }
</style>
