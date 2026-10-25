<script lang="ts">
  import TelemetrySettings from './TelemetrySettings.svelte';
  import { AppWindow, ArchiveRestore, ArrowLeft, Bell, ChevronRight, Coins, Gauge, KeyRound, Lock, Monitor, Palette, Mic } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { strings } from '../lib/strings';
  import { mobileOverlay } from '../lib/mobile-history';
  import AppearancePage from './AppearancePage.svelte';
  import ExperimentsPage from './ExperimentsPage.svelte';
  import DiagnosticsPage from './DiagnosticsPage.svelte';
  import LimitsPage from './LimitsPage.svelte';
  import QuotaMachineScope from './QuotaMachineScope.svelte';
  import ResourcesPage from './ResourcesPage.svelte';
  import TaskManagerLoader from './TaskManagerLoader.svelte';
  import MachinesPage from './MachinesPage.svelte';
  import PhoneSettings from './PhoneSettings.svelte';
  import UsagePage from './UsagePage.svelte';
  import VoiceSettings from './VoiceSettings.svelte';
  import BrainPage from './BrainPage.svelte';
  import ArchivedThreads from './ArchivedThreads.svelte';
  import WorktreesCard from './WorktreesCard.svelte';
  import WindowAllowlistCard from './WindowAllowlistCard.svelte';
  import WindowExclusionsCard from './WindowExclusionsCard.svelte';
  import SecretsCard from './SecretsCard.svelte';
  import BrowserProfilesCard from './BrowserProfilesCard.svelte';
  import AutoCompactSettings from './AutoCompactSettings.svelte';
  import InfoTip from './InfoTip.svelte';
  import { tick, type Snippet } from 'svelte';
  import { revealSettingsCard } from '../lib/settings-flash';

  /**
   * `target` is the machine the settings bar picked, `store` this window's:
   * the pages of one machine show the target, under the bar.
   */
  let { store, target = store, bar, onopenthread }: { store: Store; target?: Store; bar?: Snippet; onopenthread?: () => void } = $props();
  let phone = $state(false);
  /** The analytics switches, on a screen of their own beside the notifications. */
  let privacy = $state(false);
  /**
   * The phone has no General page, so the archive, which lives there on the
   * desktop, gets a page of its own; a jump to the desktop's card (the palette,
   * the project menu) lands on it too.
   */
  let archivePage = $derived(store.settingsTab === 'general' && store.settingsSection?.id === 'archived');
  let worktreesPage = $derived(store.owner && store.settingsTab === 'general' && store.settingsSection?.id === 'worktrees');
  /** Both window cards on one page: the allowed apps and the ones never captured. */
  let windowsPage = $derived(store.owner && store.settingsTab === 'general' && (store.settingsSection?.id === 'windows' || store.settingsSection?.id === 'window-exclusions'));
  /** The keys kept per project: a paired phone sees them too. */
  let secretsPage = $derived(store.settingsTab === 'general' && store.settingsSection?.id === 'secrets');
  let browserProfilesPage = $derived(store.owner && store.settingsTab === 'general' && store.settingsSection?.id === 'browser-profiles');
  /** The one card of the desktop's Advanced page that is about conversations, not about the machine. */
  let compactPage = $derived(store.owner && store.settingsTab === 'advanced' && store.settingsSection?.id === 'auto-compact');
  let page = $derived((store.owner && (store.settingsTab === 'brain' || store.settingsTab === 'resources' || store.settingsTab === 'diagnostics')) || store.settingsTab === 'appearance' || store.settingsTab === 'machines' || store.settingsTab === 'voice' || store.settingsTab === 'usage' || store.settingsTab === 'limits' || store.settingsTab === 'task-manager' || store.settingsTab === 'experiments'
    ? store.settingsTab : phone ? 'phone' : privacy ? 'privacy' : archivePage ? 'archived' : worktreesPage ? 'worktrees' : windowsPage ? 'windows' : secretsPage ? 'secrets' : browserProfilesPage ? 'browser-profiles' : compactPage ? 'auto-compact' : 'home');
  let machine = $derived(workspace.machines.find(machine => machine.store === store));
  let title = $derived(page === 'brain' ? strings.brain.heading : page === 'phone' ? strings.mobile.settingsPhone
    : page === 'privacy' ? strings.mobile.settingsPrivacy
    : page === 'archived' ? strings.settings.archived.heading
    : page === 'worktrees' ? strings.settings.worktrees.heading
    : page === 'windows' ? strings.windows.settings.allowedHeading
    : page === 'secrets' ? strings.secrets.heading
    : page === 'browser-profiles' ? strings.browserProfiles.heading
    : page === 'auto-compact' ? strings.settings.autoCompact
    : page === 'voice' ? strings.speech.heading : page === 'appearance' ? strings.settings.tabs.appearance
    : page === 'usage' ? strings.usage.heading : page === 'limits' ? strings.usage.limits
    : page === 'resources' ? strings.settings.tabs.resources
    : page === 'task-manager' ? strings.taskManager.title
    : page === 'diagnostics' ? strings.diagnostics.heading
    : page === 'experiments' ? strings.settings.tabs.experiments : strings.settings.tabs.machines);
  /** The page's own title and its info mark step aside for the bar, so the bar carries the mark. */
  let info = $derived(page === 'usage' ? `${strings.usage.intro} ${strings.usage.note}`
    : page === 'privacy' ? strings.telemetry.description
    : page === 'secrets' ? strings.secrets.info
    : page === 'experiments' ? strings.settings.experiments.intro : '');
  let detail = $derived(page !== 'home');
  $effect(() => { if (detail) return mobileOverlay(back); });

  $effect(() => {
    if (page === 'phone' && store.connection === 'ready') void store.loadSessions();
  });
  function back() { phone = false; privacy = false; store.showSettings(); }
  /** Usage and Limits are one screen on a phone, two tabs of it. */
  let quota = $derived(page === 'usage' || page === 'limits');

  // A settings card in a conversation opened this page to show one card: scroll to it and light it up.
  $effect(() => {
    const section = store.settingsSection;
    if (!section?.flash) return;
    void tick().then(() => revealSettingsCard(section.id, true, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'));
  });
</script>

<!-- `settings` gives the detail pages the same grammar as the desktop ones. -->
<div class="mobile-settings settings" data-testid="settings">
  {#key page}
  {#if page === 'home'}
    <!-- The header already says Settings: the screen opens on its two groups, what this phone keeps and what the machine runs. -->
    <div class="home" data-testid="mobile-settings-home">
      <section aria-labelledby="phone-preferences">
        <h2 id="phone-preferences">{strings.mobile.settingsDevice}</h2>
        <div class="rows">
          <button class="ghost row" data-testid="mobile-settings-phone" onclick={() => { phone = true; }}>
            <Bell size={20} /><span class="ui-label">{strings.mobile.settingsPhone}</span><ChevronRight size={18} />
          </button>
          <button class="ghost row" data-testid="settings-tab-appearance" onclick={() => store.showSettings('appearance')}>
            <Palette size={20} /><span class="ui-label">{strings.settings.tabs.appearance}</span><ChevronRight size={18} />
          </button>
          <button class="ghost row" data-testid="mobile-settings-privacy" onclick={() => { privacy = true; }}>
            <Lock size={20} /><span class="ui-label">{strings.mobile.settingsPrivacy}</span><ChevronRight size={18} />
          </button>
        </div>
      </section>
      <section aria-labelledby="remote-machine">
        <h2 id="remote-machine">{strings.mobile.settingsMachine}</h2>
        <div class="rows">
          <!-- The machine itself leads to the group's machines and their updates. -->
          <button class="ghost row machine-link" data-testid="mobile-settings-connection" onclick={() => store.showSettings('machines')}>
            <Monitor size={20} /><span><strong class="ui-label">{machine?.label ?? strings.machines.heading}</strong><small class:ready={store.connection === 'ready'}>{store.pairingRequired ? strings.mobile.pairingRequired : strings.connection[store.connection]}</small></span><ChevronRight size={18} />
          </button>
          <button class="ghost row" data-testid="settings-tab-usage" onclick={() => store.showSettings('usage')}>
            <Coins size={20} /><span class="ui-label">{strings.usage.heading}</span><ChevronRight size={18} />
          </button>
          <button class="ghost row" data-testid="settings-tab-voice" onclick={() => store.showSettings('voice')}>
            <Mic size={20} /><span class="ui-label">{strings.speech.heading}</span><ChevronRight size={18} />
          </button>
          {#if store.owner}
            <button class="ghost row" data-testid="mobile-settings-browser-profiles" onclick={() => store.showSettings('general', 'browser-profiles')}>
              <Monitor size={20} /><span class="ui-label">{strings.browserProfiles.heading}</span><ChevronRight size={18} />
            </button>
          {/if}
          {#if store.owner}
            <button class="ghost row" data-testid="mobile-settings-windows" onclick={() => store.showSettings('general', 'windows')}>
              <AppWindow size={20} /><span class="ui-label">{strings.windows.settings.allowedHeading}</span><ChevronRight size={18} />
            </button>
          {/if}
          <button class="ghost row" data-testid="mobile-settings-archived" onclick={() => store.showSettings('general', 'archived')}>
            <ArchiveRestore size={20} /><span class="ui-label">{strings.settings.archived.heading}</span><ChevronRight size={18} />
          </button>
          <button class="ghost row" data-testid="mobile-settings-secrets" onclick={() => store.showSettings('general', 'secrets')}>
            <KeyRound size={20} /><span class="ui-label">{strings.secrets.heading}</span><ChevronRight size={18} />
          </button>
        </div>
      </section>
    </div>
  {:else}
    <header class:limits={page === 'limits'}>
      <button class="ghost icon" data-testid="mobile-settings-back" aria-label={strings.mobile.settingsBack} onclick={back}><ArrowLeft size={20} /></button>
      <h1>{#if page === 'limits'}<QuotaMachineScope store={target} fallback={title} />{:else}{title}{/if}{#if info}<InfoTip topic={title} text={info} testid="mobile-settings-info" />{/if}</h1>
    </header>
    <div class="detail" data-testid="mobile-settings-detail">
      {#if bar && ['brain', 'voice', 'limits', 'task-manager', 'resources', 'diagnostics', 'worktrees', 'windows', 'secrets', 'auto-compact', 'archived'].includes(page)}<div class="bar">{@render bar()}</div>{/if}
      {#key target}
      {#if quota}
        <div class="tabs" role="tablist" aria-label={strings.usage.heading} data-testid="mobile-usage-tabs">
          <button type="button" role="tab" class="tab" class:on={page === 'usage'} aria-selected={page === 'usage'} data-testid="mobile-usage-tab-usage" onclick={() => store.showSettings('usage')}><Coins size={15} /><span class="ui-label">{strings.usage.heading}</span></button>
          <button type="button" role="tab" class="tab" class:on={page === 'limits'} aria-selected={page === 'limits'} data-testid="mobile-usage-tab-limits" onclick={() => store.showSettings('limits')}><Gauge size={15} /><span class="ui-label">{strings.usage.limits}</span></button>
        </div>
      {/if}
      {#if page === 'brain' && target.owner}
        <BrainPage store={target} />
      {:else if page === 'phone'}
        <div class="page phone-page">
          <!-- Which machine these apply to, once there is a choice, and the connection when it is not working. -->
          {#if workspace.machines.length > 1 || store.connection !== 'ready'}
            <p class="scope" data-testid="mobile-settings-scope">{[workspace.machines.length > 1 ? (machine?.label ?? store.endpointUrl ?? strings.connection.current) : null, store.connection === 'ready' ? null : strings.connection[store.connection]].filter(Boolean).join(' · ')}</p>
          {/if}
          <PhoneSettings {store} showServerSettings={false} />
        </div>
      {:else if page === 'privacy'}
        <div class="page phone-page privacy-page"><TelemetrySettings {store} /></div>
      {:else if page === 'voice'}
        <VoiceSettings store={target} readOnly />
      {:else if page === 'appearance'}
        <AppearancePage {store} phone />
      {:else if page === 'usage'}
        <UsagePage {store} />
      {:else if page === 'limits'}
        <LimitsPage store={target} showTitle={false} />
      {:else if page === 'task-manager'}
        <TaskManagerLoader store={target} {onopenthread} />
      {:else if page === 'resources' && target.owner}
        <ResourcesPage store={target} />
      {:else if page === 'experiments'}
        <ExperimentsPage {store} />
      {:else if page === 'diagnostics' && target.owner}
        <DiagnosticsPage store={target} {onopenthread} />
      {:else if page === 'worktrees'}
        <div class="page"><WorktreesCard store={target} /></div>
      {:else if page === 'windows'}
        <div class="page"><WindowAllowlistCard store={target} /><WindowExclusionsCard store={target} /></div>
      {:else if page === 'secrets'}
        <div class="page secrets-page"><SecretsCard store={target} /></div>
      {:else if page === 'browser-profiles'}
        <div class="page"><BrowserProfilesCard /></div>
      {:else if page === 'auto-compact'}
        <div class="page"><AutoCompactSettings store={target} /></div>
      {:else if page === 'archived'}
        <div class="page archived-page">
          <ArchivedThreads store={target} eager />
        </div>
      {:else}
        <MachinesPage mobile {onopenthread} />
      {/if}
      {/key}
    </div>
  {/if}
  {/key}
</div>

<style>
  .mobile-settings { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .home, .detail { animation: fade var(--dur-2) var(--ease-out-quint); min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .home { padding: 16px; }
  /* The group's first row is the machine itself: its name over its connection. */
  .machine-link { min-height: 64px; }
  .machine-link strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .machine-link small { display: block; margin-top: 6px; font-size: var(--text-xs); font-weight: 400; color: var(--color-muted-foreground); }
  .machine-link small.ready { color: var(--color-success); }
  section + section { margin-top: 28px; }
  h2 { font-size: var(--text-sm); font-weight: 500; color: var(--color-muted-foreground); margin: 0 0 8px; }
  p { font-size: var(--text-sm); color: var(--color-muted-foreground); line-height: 1.5; margin: 8px 0 12px; }
  .rows { border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; background: var(--color-surface); }
  /* A ghost button is muted; a row title reads like any other settings label. */
  .row { display: flex; align-items: center; width: 100%; height: auto; min-height: 56px; gap: 12px; padding: 12px 16px; font-size: var(--text-base); font-weight: 500; text-align: left; border-radius: 0; white-space: normal; color: var(--color-foreground); }
  .row + .row { border-top: 1px solid var(--color-border); }
  .row span { flex: 1; min-width: 0; }
  .row :global(svg) { flex: none; color: var(--color-muted-foreground); }
  header { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--color-border); }
  header .icon { width: 44px; min-height: 44px; }
  header h1 { margin: 0; font-size: var(--text-md); font-weight: 600; }
  header.limits h1 { flex: 1; min-width: 0; margin-right: 54px; }
  .phone-page { padding: 16px; }
  /* Usage and Limits: two tabs of one screen, in one track, the chosen one filled. */
  .tabs { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 2px; margin: 16px 16px 0; padding: 2px; border: 1px solid var(--color-edge); border-radius: var(--radius-lg); background: var(--color-surface-2); }
  .tab { min-width: 0; min-height: var(--touch-target); gap: 8px; border: 1px solid transparent; border-radius: var(--radius-md); background: transparent; color: var(--color-muted-foreground); font-size: var(--text-sm); font-weight: 500; transition: background var(--dur-2) var(--ease-out-quint), color var(--dur-2) var(--ease-out-quint); }
  .tab.on { background: var(--color-foreground); border-color: var(--color-foreground); color: var(--color-on-foreground); }
  .tab :global(svg) { flex: none; }
  /* The bar carries the page's name and its "i": the card's own heading steps aside. */
  .privacy-page :global(.card > h2) { display: none; }
  .scope { overflow-wrap: anywhere; margin-top: 0; }
  .phone-page :global(.card) { padding: 18px; }
  .detail :global(.page), .detail :global(.machines-page) { padding: 16px; }
  .bar { padding: 16px 16px 0; }
  .bar + :global(.page) { padding-top: 12px; }
  /* The bar above already names the page, so its own title steps aside. */
  .detail :global(.page:not(.machines-page):not(.limits-page):not(.usage) > header),
  .detail :global(.machines-page .head h1),
  .detail :global(.limits-page > header h1),
  .detail :global(.usage > header h1) { display: none; }
  /* Their refresh joins the bar, at the right end: alone on a row it pushed the cards down. */
  .detail :global(.limits-page > header),
  .detail :global(.usage > header) { position: absolute; top: 8px; right: 12px; margin: 0; }
  .detail :global(.limits-page > header .refresh),
  .detail :global(.usage > header .refresh) { width: 44px; height: 44px; }
  .detail :global(.switch-row) { flex-wrap: wrap; gap: 12px; }
  /* The bar names the page and the line above says what it holds: the card's own heading and tip step aside. */
  .archived-page :global(#settings-archived > h2) { display: none; }
  .secrets-page :global(#settings-secrets > h2) { display: none; }
</style>
