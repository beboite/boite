<script lang="ts">
  import { MediaQuery } from 'svelte/reactivity';
  import { tick } from 'svelte';
  import MobileSettings from './MobileSettings.svelte';
  import BrainPage from './BrainPage.svelte';
  import { Activity, ArrowLeft, Brain, ChevronRight, Coins, FlaskConical, Gauge, House, Keyboard, Mic, Monitor, Palette, Puzzle, Settings2, ShieldCheck, SlidersHorizontal, Users } from '@lucide/svelte';
  import KeyboardPage from './KeyboardPage.svelte';
  import LimitsPage from './LimitsPage.svelte';
  import PluginsPage from './PluginsPage.svelte';
  import { COMMAND_GROUPS } from '../lib/keybindings';
  import { EXPERIMENT_IDS } from '../lib/experiments';
  import { experimentCopy } from '../lib/experiment-copy';
  import { strings } from '../lib/strings';
  import type { SettingsTab, Store } from '../lib/store.svelte';
  import AccountsPage from './AccountsPage.svelte';
  import AdvancedSettings from './AdvancedSettings.svelte';
  import AppearancePage from './AppearancePage.svelte';
  import ExperimentsPage from './ExperimentsPage.svelte';
  import GeneralSettings from './GeneralSettings.svelte';
  import MachinesPage from './MachinesPage.svelte';
  import ResourcesPage from './ResourcesPage.svelte';
  import TaskManagerLoader from './TaskManagerLoader.svelte';
  import SettingsHome, { type SettingsEntry, type SettingsTile } from './SettingsHome.svelte';
  import UsagePage from './UsagePage.svelte';
  import VoiceSettings from './VoiceSettings.svelte';
  import { providerGroups } from '../lib/provider-family';
import { workspace } from '../lib/workspace.svelte';
  import { browserBridge } from '../lib/browser-bridge';

  let { store, onopenthread }: { store: Store; onopenthread?: () => void } = $props();
  const narrow = new MediaQuery('(max-width: 720px)');
  const inShell = window.__TAURI_INTERNALS__ !== undefined;

  /** Providers, Plugins, Resources and Brain call nothing a paired device may call. */
  const OWNER_TABS: SettingsTab[] = ['accounts', 'plugins', 'resources', 'brain'];

  type Tab = SettingsTile;

  // Derived, not built once: the nav is written in the language the app is
  // speaking, and the language changes without a reload. Four groups: the
  // app itself, the agents, what they cost, where they run.
  let all = $derived<Tab[]>([
    { id: 'home', label: strings.settings.tabs.home, icon: House, group: 0 },
    { id: 'general', label: strings.settings.tabs.general, icon: Settings2, group: 0 },
    { id: 'appearance', label: strings.settings.tabs.appearance, icon: Palette, group: 0 },
    { id: 'keyboard', label: strings.settings.tabs.keyboard, icon: Keyboard, group: 0 },
    { id: 'voice', label: strings.speech.heading, icon: Mic, group: 0 },
    { id: 'accounts', label: strings.settings.tabs.accounts, icon: Users, group: 1 },
    { id: 'plugins', label: strings.settings.tabs.plugins, icon: Puzzle, group: 1 },
    { id: 'brain', label: strings.brain.heading, icon: Brain, group: 1 },
    { id: 'usage', label: strings.settings.tabs.usage, icon: Coins, group: 2 },
    { id: 'limits', label: strings.usage.limits, icon: Gauge, group: 2 },
    { id: 'task-manager', label: strings.taskManager.title, icon: Activity, group: 2 },
    { id: 'resources', label: strings.settings.tabs.resources, icon: ShieldCheck, group: 2 },
    { id: 'machines', label: strings.settings.tabs.machines, icon: Monitor, group: 3 },
    { id: 'advanced', label: strings.settings.tabs.advanced, icon: SlidersHorizontal, group: 3 },
    { id: 'experiments', label: strings.settings.tabs.experiments, icon: FlaskConical, group: 3 }
  ]);

  let providerList = $derived(providerGroups(store.providers, store.shownAccounts()));

  let children: Partial<Record<SettingsTab, { id: string; label: string }[]>> = $derived({
    general: [
      { id: 'conversations', label: strings.settings.conversations },
      { id: 'archived', label: strings.settings.archived.heading },
      ...(store.owner ? [{ id: 'worktrees', label: strings.settings.worktrees.heading }] : []),
      ...(browserBridge.paints ? [{ id: 'browser-profiles', label: strings.browserProfiles.card }] : []),
      { id: 'app', label: strings.settings.app },
      ...(store.owner ? [{ id: 'privacy', label: strings.telemetry.heading }] : [])
    ],
    appearance: [{ id: 'theme', label: strings.settings.display }, { id: 'reading', label: strings.settings.reading }, { id: 'workspace', label: strings.settings.workspace }, { id: 'buttons', label: strings.controls.heading }],
    keyboard: [
      ...COMMAND_GROUPS.map((group) => ({ id: `keys-${group.id}`, label: strings.keyboard.groups[group.id] })),
      { id: 'keybinding-file', label: strings.keyboard.file }
    ],
    brain: [{ id: 'brain-folder', label: strings.brain.folder }, { id: 'hooks', label: strings.hooks.heading }],
    // The page's order: connected providers first, then the ones still to add.
    accounts: [...providerList.connected, ...providerList.rest].map((row) => ({ id: `provider-${row.id}`, label: row.name })),
    usage: [
      { id: 'usage-overview', label: strings.usage.overview },
      { id: 'usage-chart', label: strings.usage.chart },
      { id: 'usage-breakdown', label: strings.usage.breakdown },
      { id: 'usage-threads', label: strings.usage.threads }
    ],
    resources: [
      { id: 'quiet', label: strings.protection.quiet },
      { id: 'limits', label: strings.protection.limits },
      { id: 'tasks', label: strings.protection.tasks }
    ],
    machines: [
      { id: 'updates', label: strings.serverUpdate.updates },
      { id: 'machines', label: strings.machines.connections },
      { id: 'devices', label: strings.settings.pairing.heading },
      { id: 'phone', label: strings.phone.heading }
    ],
    advanced: [
      ...(store.owner ? [{ id: 'execution', label: strings.settings.execution }, { id: 'origins', label: strings.machines.browserOrigins }] : []),
      { id: 'core', label: strings.settings.core }
    ],
    experiments: EXPERIMENT_IDS.map((id) => ({ id, label: experimentCopy()[id].title }))
  });

  /**
   * The pages whose sections the nav lists under their name: the ones several
   * screens long. Every other page fits on about one screen, or lists rows
   * whose names are already in view, and a sub-entry there only repeats a
   * heading. The search still finds every section above.
   */
  const LONG_PAGES: SettingsTab[] = ['keyboard', 'usage', 'machines'];
  let toc = $derived<Partial<Record<SettingsTab, { id: string; label: string }[]>>>(
    Object.fromEntries(LONG_PAGES.map((id) => [id, children[id] ?? []]))
  );

  let tabs = $derived(all.filter((tab) => store.owner || !OWNER_TABS.includes(tab.id)));
  /** A tab this client has no nav entry for lands on Home rather than nowhere. */
  let tab = $derived(tabs.some((entry) => entry.id === store.settingsTab) ? store.settingsTab : 'home');

  /**
   * Single settings the search also finds, each with the card it sits on:
   * people look for "network" or "accent", not for the card's title.
   */
  let settingsWords = $derived<[SettingsTab, string | null, string][]>([
    ['general', 'conversations', strings.settings.groupWorkingThreads],
    ['general', 'conversations', strings.settings.groupOtherProjects],
    ['general', 'conversations', strings.settings.notifications],
    ['general', 'conversations', strings.settings.asyncQuestions],
    ['general', 'conversations', strings.settings.titleModel],
    ['general', 'conversations', strings.features.chatArtifacts.title],
    ...(browserBridge.paints ? [['general', 'browser-profiles', strings.browserProfiles.heading]] as [SettingsTab, string, string][] : []),
    ['general', 'archived', strings.settings.archived.doneRetentionLabel],
    // The switch lives in the shell's own card: a browser has no tray.
    ...(inShell ? [['general', 'app', strings.settings.closeToTray] as [SettingsTab, string, string]] : []),
    ...(inShell ? [['general', 'app', strings.settings.launchAtLogin] as [SettingsTab, string, string]] : []),
    ['general', 'app', strings.onboarding.label],
    ['appearance', 'theme', strings.settings.accent],
    ['appearance', 'theme', strings.settings.material],
    ['appearance', 'theme', strings.settings.language],
    ['appearance', 'reading', strings.settings.font],
    ['appearance', 'reading', strings.settings.monoFont],
    ...(inShell ? [['appearance', 'reading', strings.settings.zoom] as [SettingsTab, string, string]] : []),
    ['appearance', 'workspace', strings.settings.startIn],
    ['appearance', 'workspace', strings.settings.panelStart],
    // The buttons people most often look for by name, the ones the old developer switch hid.
    ['appearance', 'buttons', strings.terminal.title],
    ['appearance', 'buttons', strings.rightPanel.trace],
    ['accounts', null, strings.settings.modelDefaults],
    ['machines', 'updates', strings.appUpdate.heading],
    ['machines', 'updates', strings.harnessUpdates.auto],
    ['machines', 'updates', strings.harnessUpdates.heading],
    ['machines', 'updates', strings.serverUpdate.updates],
    ['resources', 'quiet', strings.settings.focusGuard],
    ['resources', 'quiet', strings.settings.muteAgents],
    ['resources', 'limits', strings.settings.memoryProtection],
    ['resources', 'tasks', strings.settings.reapOrphans],
    ['machines', 'devices', strings.settings.listenOnLan],
    ['machines', 'devices', strings.settings.pairing.mint],
    ['machines', 'phone', strings.phone.publicUrl],
    ['advanced', 'execution', strings.settings.warmProcessMinutes]
  ]);

  /** Every page, every section the nav names and the settings above: what the home page's search looks through. */
  let entries = $derived<SettingsEntry[]>(tabs.flatMap((entry) => {
    const sections = children[entry.id] ?? [];
    const words = settingsWords.filter(([tab, section]) => tab === entry.id && (section === null || sections.some((child) => child.id === section)));
    return [
      { tab: entry.id, section: null, label: entry.label, trail: '' },
      ...sections.map((child) => ({ tab: entry.id, section: child.id, label: child.label, trail: entry.label })),
      ...words.map(([, section, label]) => ({
        tab: entry.id,
        section,
        label,
        trail: [entry.label, sections.find((child) => child.id === section)?.label].filter(Boolean).join(' · ')
      }))
    ];
  }));

  let selectedSection = $state('');
  let chosenSection = $derived(store.settingsSection?.id ?? selectedSection);
  /** While a click scrolls to a card, the spy waits: the scroll passes other cards on its way. */
  let jumping = 0;

  const motion = (): ScrollBehavior => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth');

  function jump(id: string) {
    if (tab === 'machines') {
      store.showSettings('machines', id);
      return;
    }
    store.settingsSection = null;
    selectedSection = id;
    const target = document.getElementById(`settings-${id}`);
    if (!target) return;
    jumping = Date.now();
    target.scrollIntoView({ behavior: motion(), block: 'start' });
  }

  function open(entry: SettingsEntry) {
    selectedSection = '';
    store.showSettings(entry.tab, entry.section);
  }

  /**
   * Scroll spy: the section whose top has passed the top of the scrolling
   * page is the one being read. At the very bottom the last one wins, since a
   * short card there never reaches the top. The page scrolls, not the panel,
   * and a scroll does not bubble, so the panel listens in the capture phase.
   */
  function spy(event: Event) {
    const page = event.target;
    if (!(page instanceof HTMLElement) || Date.now() - jumping < 900) return;
    const sections = toc[tab] ?? [];
    if (sections.length === 0) return;
    const top = page.getBoundingClientRect().top + 24;
    let current = '';
    for (const section of sections) {
      const element = document.getElementById(`settings-${section.id}`);
      if (element && element.getBoundingClientRect().top <= top) current = section.id;
    }
    if (page.scrollTop + page.clientHeight >= page.scrollHeight - 2) {
      const last = sections.findLast((section) => document.getElementById(`settings-${section.id}`));
      if (last) current = last.id;
    }
    if (current !== chosenSection) {
      store.settingsSection = null;
      selectedSection = current;
    }
  }

  // A caller can name a card before this lazy settings subtree is mounted.
  // Effects run after its DOM is present, so the normal navigation path can
  // perform the first scroll without timing guesses in the caller.
  $effect(() => {
    const section = store.settingsSection;
    if (!section || tab !== store.settingsTab) return;
    void section.request;
    void tick().then(() => {
      const target = document.getElementById(`settings-${section.id}`);
      if (!target) return;
      jumping = Date.now();
      target.scrollIntoView({ behavior: motion(), block: 'start' });
    });
  });
</script>

{#if narrow.current && !inShell}
  <MobileSettings {store} {onopenthread} />
{:else}
<div class="settings" data-testid="settings">
  <nav aria-label={strings.settings.heading}>
    <button type="button" class="ghost back" data-testid="settings-back" onclick={() => store.showChat()}>
      <ArrowLeft size={15} strokeWidth={1.75} />
      <span class="ui-label">{strings.settings.back}</span>
    </button>
    {#each tabs as entry, index (entry.id)}
      {@const Icon = entry.icon}
      {#if index > 0 && tabs[index - 1]?.group !== entry.group}<div class="rule" role="separator"></div>{/if}
      <div class="category">
      <button
        type="button"
        class="ghost tab"
        class:active={tab === entry.id}
        data-testid="settings-tab-{entry.id}"
        aria-current={tab === entry.id ? 'page' : undefined}
        aria-expanded={toc[entry.id] ? tab === entry.id : undefined}
        onclick={() => { selectedSection = ''; store.showSettings(entry.id, entry.id === 'machines' ? 'updates' : undefined); }}
      >
        <Icon size={15} strokeWidth={1.75} />
        <span class="ui-label">{entry.label}</span>
        {#if toc[entry.id]}<ChevronRight size={14} class={tab === entry.id ? 'expanded' : ''} />{/if}
      </button>
      {#if toc[entry.id]}
        <div class="subcategories" class:open={tab === entry.id} inert={tab !== entry.id}>
          <div>
            {#each toc[entry.id] ?? [] as child (child.id)}
              <button class="ghost subsection" class:chosen={chosenSection === child.id} data-settings-section={child.id} title={child.label} onclick={() => jump(child.id)}><span class="ui-label">{child.label}</span></button>
            {/each}
          </div>
        </div>
      {/if}
      </div>
    {/each}
  </nav>

  {#if toc[tab]}
    <div class="mobile-subcategories">
      {#each toc[tab] ?? [] as child (child.id)}
        <button class="ghost" class:active={chosenSection === child.id} data-settings-section={child.id} onclick={() => jump(child.id)}><span class="ui-label">{child.label}</span></button>
      {/each}
    </div>
  {/if}

  <!-- The panel is keyed on the tab, so switching tabs fades the new page in
       rather than swapping it in one frame. -->
  {#key tab}
    <section class="framed" onscrollcapture={spy}>
      {#if tab === 'home'}
        <SettingsHome {store} tiles={tabs} {entries} onopen={open} />
      {:else if tab === 'brain'}
        <BrainPage {store} />
      {:else if tab === 'voice'}
        <VoiceSettings {store} />
      {:else if tab === 'general'}
        <GeneralSettings {store} />
      {:else if tab === 'machines'}
        <MachinesPage />
      {:else if tab === 'advanced'}
        <AdvancedSettings {store} />
      {:else if tab === 'appearance'}
        <AppearancePage {store} />
      {:else if tab === 'keyboard'}
        <KeyboardPage {store} />
      {:else if tab === 'accounts'}
        <AccountsPage {store} />
      {:else if tab === 'usage'}
        <UsagePage {store} />
      {:else if tab === 'limits'}
        <LimitsPage {store} />
      {:else if tab === 'task-manager'}
        <TaskManagerLoader {store} {onopenthread} />
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
{/if}

<style>
  .mobile-subcategories { display: none; }
  .category { flex: none; }
  .rule { flex: none; height: 1px; margin: 8px 10px; background: var(--color-border); }
  .tab span { flex: 1; text-align: left; }
  .tab :global(svg:last-child) { transition: transform var(--dur-3) var(--ease-out-quint); }
  .tab :global(.expanded) { transform: rotate(90deg); }
  .subcategories { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows var(--dur-3) var(--ease-out-quint), opacity var(--dur-2); }
  .subcategories.open { grid-template-rows: 1fr; opacity: 1; }
  .subcategories > div { overflow: hidden; min-height: 0; }
  /* Block rather than flex, and a label longer than the rail wraps onto a second
     line: French says most of these in more letters, and a cut label hides the word
     that tells two sections apart. */
  .subsection { display: block; text-align: left; white-space: normal; text-wrap: pretty; height: auto; min-height: var(--control); padding-block: 5px; line-height: 1.3; width: calc(100% - 24px); margin-left: 24px; padding-left: 15px; border-left: 1px solid var(--color-edge); border-radius: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); transition: color var(--dur-2), border-color var(--dur-2), background var(--dur-2); }
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
  }


  .back {
    justify-content: flex-start;
    margin-bottom: 10px;
  }

  .tab {
    justify-content: flex-start;
    width: 100%;
    min-height: var(--row);
    height: auto;
    padding: 6px 10px;
    white-space: normal;
    line-height: 1.35;
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
      background: var(--color-surface);
      border-bottom: 1px solid var(--color-border);
    }

    .rule { width: 1px; height: auto; align-self: stretch; margin: 6px 4px; }
    .subcategories { display: none; }
    .mobile-subcategories { display: flex; gap: 4px; padding: 8px 14px; overflow-x: auto; flex: none; border-bottom: 1px solid var(--color-border); }
    .mobile-subcategories button { flex: none; font-size: var(--text-sm); }
    .back { display: none; }
    .category { min-width: 0; }
  }
</style>
