<script lang="ts">
  /*
   * The tour, once per device. Nine owner screens, each one carrying the switch or
   * the button for what it explains, so reading it and setting it up are the
   * same pass: the language and the theme, the agent picker, dictation, the
   * panel and its keys, the usage bars, the phone and the other machines, the
   * four quiet switches, and the first project.
   *
   * Nothing here invents a setting. Every control writes through the same
   * function the Settings page writes through, so a choice made in the tour
   * and one made afterwards are the same choice.
   */
  import { onMount, tick, untrack } from 'svelte';
  import { AppWindow, Bell, Brain, Coins, FolderOpen, GitCompare, Keyboard, Languages, ListTodo, Mic, Minimize2, Palette, Server, ShieldCheck, Smartphone, Files as FilesIcon, VolumeX, X } from '@lucide/svelte';
  import type { AccountQuota, KeybindingCommand, SpeechStatus } from '@boite/contracts';
  import TelemetrySettings from './TelemetrySettings.svelte';
  import BoiteMark from './BoiteMark.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import { Closing } from '../lib/closing.svelte';
  import { fill, LOCALES, localeSetting, setLocaleSetting, strings, type LocaleSetting } from '../lib/i18n.svelte';
  import { steps, type OnboardingStep } from '../lib/onboarding';
  import { closeTour } from '../lib/onboarding.svelte';
  import { readTheme, setTheme, type Theme } from '../lib/theme';
  import type { SettingsTab, Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

  const screens = $derived(steps(store.owner));
  let index = $state(0);
  let step = $derived<OnboardingStep>(screens[index] ?? 'welcome');
  let last = $derived(index === screens.length - 1);
  let panel = $state<HTMLDivElement | undefined>(undefined);

  /** The heading of a screen, for the dots the keyboard walks. */
  function titleOf(id: OnboardingStep): string {
    return strings.onboarding[id].title;
  }

  // The overlay owns its own exit: the tour is unmounted by the state it
  // writes, so it plays the reverse animation first and calls `closeTour` when
  // the node is done rather than on a timer.
  const overlay = new Closing();
  overlay.show();
  $effect(() => {
    if (!overlay.shown) closeTour();
  });

  // The keyboard starts inside the dialog, so Escape and Tab answer before
  // anything behind it does.
  onMount(() => panel?.focus({ preventScroll: true }));

  function finish(): void {
    overlay.hide();
  }

  function go(next: number): void {
    index = Math.min(screens.length - 1, Math.max(0, next));
    void tick().then(() => panel?.querySelector<HTMLElement>('[data-step-start]')?.focus({ preventScroll: true }));
  }

  /** The tour is modal: Escape leaves it, Tab stays inside it. */
  function onkeydown(event: KeyboardEvent): void {
    if (!overlay.open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish();
      return;
    }
    if (event.key !== 'Tab') return;
    const el = panel;
    if (!el) return;
    const stops = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = stops[0];
    const end = stops[stops.length - 1];
    if (!first || !end) return;
    const active = document.activeElement;
    const inside = active instanceof Node && el.contains(active);
    if (event.shiftKey ? inside && active !== first : inside && active !== end) return;
    event.preventDefault();
    (event.shiftKey ? end : first).focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------------
  // The switches, each one writing where the Settings page writes.
  // ---------------------------------------------------------------------

  let locale = $state<LocaleSetting>(localeSetting());
  function pickLocale(next: LocaleSetting): void {
    locale = next;
    setLocaleSetting(next);
  }

  let theme = $state<Theme>(readTheme());
  function pickTheme(next: Theme): void {
    theme = next;
    setTheme(next);
  }

  let themes = $derived<{ id: Theme; label: string }[]>([
    { id: 'system', label: strings.settings.themeSystem },
    { id: 'dark', label: strings.settings.themeDark },
    { id: 'light', label: strings.settings.themeLight }
  ]);

  /** The shell's own switch, an `invoke` rather than a core setting. */
  let tray = $state(false);
  let trayReady = $state(false);
  async function readTray(): Promise<void> {
    if (!inShell) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      tray = await invoke<boolean>('close_behavior', {});
      trayReady = true;
    } catch {
      trayReady = false;
    }
  }
  async function setTray(value: boolean): Promise<void> {
    tray = value;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      tray = await invoke<boolean>('close_behavior', { enabled: value });
    } catch {
      trayReady = false;
    }
  }

  // The quota rows fill the usage screen: one switch per account, or the one
  // line saying there is no account to read yet. Only the owner may ask.
  let quotas = $state<AccountQuota[]>([]);
  let quotaBusy = $state(false);
  async function readQuotas(): Promise<void> {
    const client = store.client;
    if (!client || !store.owner || quotaBusy) return;
    quotaBusy = true;
    try {
      quotas = await client.call('quotas.list', { refresh: false });
    } catch {
      quotas = [];
    } finally {
      quotaBusy = false;
    }
  }
  async function monitor(accountId: string, enabled: boolean): Promise<void> {
    const client = store.client;
    if (!client || quotaBusy) return;
    quotaBusy = true;
    try {
      quotas = await client.call('quotas.configure', { accountId, enabled });
    } catch (cause) {
      store.error = String(cause);
    } finally {
      quotaBusy = false;
    }
  }

  let monitored = $derived(quotas.filter((row) => row.status !== 'unsupported'));

  // The voice screen says where this core stands rather than describing a
  // feature that may need a 200 MB download first. A core from before dictation
  // has no such method, which reads the same as not set up.
  let speech = $state<SpeechStatus | null>(null);
  let speechBusy = $state(false);
  async function readSpeech(): Promise<void> {
    const client = store.client;
    if (!client || speechBusy) return;
    speechBusy = true;
    try {
      speech = await client.call('speech.status', {});
    } catch {
      speech = null;
    } finally {
      speechBusy = false;
    }
  }

  /** The panel's four surfaces, each with the key that opens it today. */
  const SURFACES: { id: KeybindingCommand; icon: typeof Coins; label: () => string; hint: () => string }[] = [
    { id: 'changes', icon: GitCompare, label: () => strings.rightPanel.changes, hint: () => strings.rightPanel.changesHint },
    { id: 'files', icon: FilesIcon, label: () => strings.rightPanel.files, hint: () => strings.rightPanel.filesHint },
    { id: 'tasks', icon: ListTodo, label: () => strings.rightPanel.tasks, hint: () => strings.rightPanel.tasksHint },
    { id: 'browser', icon: AppWindow, label: () => strings.rightPanel.browser, hint: () => strings.rightPanel.browserHint }
  ];

  // The screen is the only thing this watches. Every reader writes the state
  // it guards itself on, so tracking their reads would have the effect fire on
  // its own answer and ask the core again, for ever.
  $effect(() => {
    const at = step;
    untrack(() => {
      if (at === 'quiet') void readTray();
      if (at === 'usage') void readQuotas();
      if (at === 'voice') void readSpeech();
    });
  });

  /** A settings page the tour hands over to: the tour ends on the page asked for. */
  function leaveFor(tab: SettingsTab): void {
    store.showSettings(tab);
    finish();
  }

  function openProjectPicker(): void {
    store.projectPickerOpen = true;
    finish();
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />

{#if overlay.shown}
  <div class="scrim" class:closing={overlay.closing} role="presentation" data-testid="onboarding">
    <div
      class="panel"
      class:closing={overlay.closing}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      tabindex="-1"
      bind:this={panel}
      use:overlay.attach
      onanimationend={overlay.end}
    >
      <header>
        <span class="mark"><BoiteMark size={16} /></span>
        <span class="label">{strings.onboarding.label}</span>
        <span class="count">{fill(strings.onboarding.step, { index: String(index + 1), total: String(screens.length) })}</span>
        <button type="button" class="ghost icon" data-testid="onboarding-skip" aria-label={strings.onboarding.skip} title={strings.onboarding.skip} onclick={finish}>
          <X size={15} strokeWidth={1.75} />
        </button>
      </header>

      <!-- Keyed, so one screen fades out and the next one rises, the way the
           settings panel swaps a tab. -->
      {#key step}
        <div class="screen" data-testid="onboarding-step" data-step={step}>
          {#if step === 'welcome'}
            <div class="hero"><BoiteMark size={30} /></div>
            <h1 id="onboarding-title">{strings.onboarding.welcome.title}</h1>
            <p class="lead">{strings.onboarding.welcome.body}</p>
            <p class="muted small">{strings.onboarding.welcome.pick}</p>
            <div class="rows">
              <div class="row">
                <Languages size={18} strokeWidth={1.5} />
                <span class="text">{strings.settings.language}<span class="hint">{strings.settings.languageHint}</span></span>
                <div class="segmented" role="group" aria-label={strings.settings.language}>
                  <button type="button" data-step-start class:on={locale === 'system'} aria-pressed={locale === 'system'} data-testid="onboarding-locale-system" onclick={() => pickLocale('system')}>
                    {strings.settings.languageSystem}
                  </button>
                  {#each LOCALES as id (id)}
                    <button type="button" class:on={locale === id} aria-pressed={locale === id} data-testid="onboarding-locale-{id}" onclick={() => pickLocale(id)}>
                      {strings.settings.languageNames[id]}
                    </button>
                  {/each}
                </div>
              </div>
              <div class="row">
                <Palette size={18} strokeWidth={1.5} />
                <span class="text">{strings.settings.theme}</span>
                <div class="segmented" role="group" aria-label={strings.settings.theme}>
                  {#each themes as option (option.id)}
                    <button type="button" class:on={theme === option.id} aria-pressed={theme === option.id} data-testid="onboarding-theme-{option.id}" onclick={() => pickTheme(option.id)}>
                      {option.label}
                    </button>
                  {/each}
                </div>
              </div>
            </div>
          {:else if step === 'privacy'}
            <h1 id="onboarding-title">{strings.onboarding.privacy.title}</h1>
            <p class="lead">{strings.onboarding.privacy.body}</p>
            <TelemetrySettings {store} embedded />
          {:else if step === 'agents'}
            <h1 id="onboarding-title">{strings.onboarding.agents.title}</h1>
            <p class="lead">{strings.onboarding.agents.body}</p>
            <!-- The composer's own bottom row, drawn still: the three chips the
                 sentence above is about, in the order they sit in. -->
            <div class="demo" aria-hidden="true">
              <span class="chip"><ProviderLogo providerId="claude" size={14} />{strings.onboarding.agents.demoModel}</span>
              <span class="chip"><Brain size={13} strokeWidth={1.75} />{strings.onboarding.agents.demoEffort}</span>
              <span class="chip"><ShieldCheck size={13} strokeWidth={1.75} />{strings.onboarding.agents.demoMode}</span>
            </div>
            <p>{strings.onboarding.agents.effort}</p>
            <p class="note">{strings.onboarding.agents.locked}</p>
          {:else if step === 'voice'}
            <h1 id="onboarding-title">{strings.onboarding.voice.title}</h1>
            <p class="lead">{strings.onboarding.voice.body}</p>
            <div class="demo" aria-hidden="true">
              <span class="chip"><Mic size={13} strokeWidth={1.75} />{strings.speech.start}</span>
            </div>
            <p class="note">{strings.onboarding.voice.hint}</p>
            {#if !store.owner}
              <p class="note">{strings.speech.ownerSetup}</p>
            {:else if speech === null && speechBusy}
              <p class="note">{strings.onboarding.voice.reading}</p>
            {:else if speech?.ready}
              <p class="note" data-testid="onboarding-voice-ready">{strings.speech.statusReady}</p>
            {:else}
              <p class="note">{strings.speech.statusSetup}</p>
              <button type="button" data-step-start data-testid="onboarding-voice" onclick={() => leaveFor('voice')}>{strings.onboarding.voice.open}</button>
            {/if}
          {:else if step === 'panel'}
            <h1 id="onboarding-title">{strings.onboarding.panel.title}</h1>
            <p class="lead">{strings.onboarding.panel.body}</p>
            <div class="rows">
              {#each SURFACES as surface (surface.id)}
                {@const Icon = surface.icon}
                <div class="row">
                  <Icon size={18} strokeWidth={1.5} />
                  <span class="text">{surface.label()}<span class="hint">{surface.hint()}</span></span>
                  <kbd class:none={store.keyLabel(surface.id) === null}>{store.keyLabel(surface.id) ?? strings.onboarding.panel.noKey}</kbd>
                </div>
              {/each}
            </div>
            <p class="note">{strings.onboarding.panel.agent}</p>
            <p class="note">{strings.onboarding.panel.keys}</p>
            <button type="button" data-step-start data-testid="onboarding-keyboard" onclick={() => leaveFor('keyboard')}>
              <Keyboard size={15} strokeWidth={1.75} />
              {strings.onboarding.panel.open}
            </button>
          {:else if step === 'usage'}
            <h1 id="onboarding-title">{strings.onboarding.usage.title}</h1>
            <p class="lead">{strings.onboarding.usage.body}</p>
            <!-- Two full bars and one near its end: what a window that has been
                 used looks like, so the row above is read as a measurement. -->
            <div class="demo bars" aria-hidden="true">
              <Coins size={16} strokeWidth={1.5} />
              <span class="meters"><progress max="100" value="72"></progress><progress max="100" value="94"></progress><progress class="low" max="100" value="12"></progress></span>
            </div>
            <p>{strings.onboarding.usage.tokens}</p>
            {#if !store.owner}
              <p class="note">{strings.onboarding.usage.deviceHint}</p>
            {:else if monitored.length > 0}
              <div class="rows">
                {#each monitored as row (row.accountId)}
                  <!-- The provider first, the account under it: several
                       providers ship an account called "Default", and the row
                       has to say which one the switch reads. -->
                  <label class="row">
                    <ProviderLogo providerId={row.providerId} size={18} />
                    <span class="text">{row.providerName}{#if row.label}<span class="hint">{row.label}</span>{/if}</span>
                    <input type="checkbox" role="switch" aria-label={fill(strings.onboarding.usage.monitor, { account: row.label ? `${row.providerName}, ${row.label}` : row.providerName })} data-testid="onboarding-quota-{row.accountId}" checked={row.enabled} disabled={quotaBusy} onchange={(event) => void monitor(row.accountId, event.currentTarget.checked)} />
                  </label>
                {/each}
              </div>
            {:else}
              <p class="note">{strings.onboarding.usage.noAccounts}</p>
              <button type="button" data-testid="onboarding-providers" onclick={() => leaveFor('accounts')}>{strings.onboarding.usage.connect}</button>
            {/if}
          {:else if step === 'reach'}
            <h1 id="onboarding-title">{strings.onboarding.reach.title}</h1>
            <div class="half">
              <h2><Smartphone size={16} strokeWidth={1.5} />{strings.onboarding.reach.phone}</h2>
              <p>{strings.onboarding.reach.phoneBody}</p>
              {#if store.owner}
                <label class="row">
                  <span class="text">{strings.settings.listenOnLan}<span class="hint">{strings.settings.listenOnLanHint}</span></span>
                  <input
                    type="checkbox"
                    role="switch"
                    data-testid="onboarding-lan"
                    checked={store.settings?.listenOnLan ?? false}
                    onchange={(event) => void store.saveSettings({ listenOnLan: event.currentTarget.checked })}
                  />
                </label>
                <button type="button" data-testid="onboarding-pair" onclick={() => leaveFor('general')}>{strings.onboarding.reach.pair}</button>
              {/if}
            </div>
            <div class="half">
              <h2><Server size={16} strokeWidth={1.5} />{strings.onboarding.reach.machines}</h2>
              <p>{strings.onboarding.reach.machinesBody}</p>
              <button type="button" data-testid="onboarding-machines" onclick={() => leaveFor('machines')}>{strings.onboarding.reach.connect}</button>
            </div>
            {#if !store.owner}<p class="note">{strings.onboarding.reach.deviceHint}</p>{/if}
          {:else if step === 'quiet'}
            <h1 id="onboarding-title">{strings.onboarding.quiet.title}</h1>
            <p class="lead">{strings.onboarding.quiet.body}</p>
            <div class="rows">
              <label class="row">
                <Bell size={18} strokeWidth={1.5} />
                <span class="text">{strings.settings.notifications}<span class="hint">{strings.settings.notificationsHint}</span></span>
                <input type="checkbox" role="switch" data-testid="onboarding-notifications" checked={store.notifications} onchange={(event) => void store.setNotifications(event.currentTarget.checked)} />
              </label>
              {#if inShell}
                <label class="row">
                  <Minimize2 size={18} strokeWidth={1.5} />
                  <span class="text">{strings.settings.closeToTray}<span class="hint">{strings.settings.closeToTrayHint}</span></span>
                  <input type="checkbox" role="switch" data-testid="onboarding-tray" checked={tray} disabled={!trayReady} onchange={(event) => void setTray(event.currentTarget.checked)} />
                </label>
              {/if}
              {#if store.owner}
                <label class="row">
                  <AppWindow size={18} strokeWidth={1.5} />
                  <span class="text">{strings.settings.focusGuard}<span class="hint">{strings.settings.focusGuardHint}</span></span>
                  <input type="checkbox" role="switch" data-testid="onboarding-focus-guard" checked={store.settings?.focusGuard ?? true} onchange={(event) => void store.saveSettings({ focusGuard: event.currentTarget.checked })} />
                </label>
                <label class="row">
                  <VolumeX size={18} strokeWidth={1.5} />
                  <span class="text">{strings.settings.muteAgents}<span class="hint">{strings.settings.muteAgentsHint}</span></span>
                  <input type="checkbox" role="switch" data-testid="onboarding-mute" checked={store.settings?.muteAgents ?? true} onchange={(event) => void store.saveSettings({ muteAgents: event.currentTarget.checked })} />
                </label>
              {/if}
            </div>
            <p class="note">{store.owner ? strings.onboarding.quiet.windows : strings.onboarding.quiet.deviceHint}</p>
          {:else}
            <h1 id="onboarding-title">{strings.onboarding.project.title}</h1>
            <p class="lead">{store.owner ? strings.onboarding.project.body : strings.onboarding.project.deviceBody}</p>
            {#if store.owner}
              {#if store.projects.length > 0}
                <p class="note">
                  {fill(store.projects.length === 1 ? strings.onboarding.project.opened : strings.onboarding.project.openedMany, { count: String(store.projects.length) })}
                </p>
              {:else}
                <button type="button" class="primary big" data-testid="onboarding-add-project" onclick={openProjectPicker}>
                  <FolderOpen size={16} strokeWidth={1.75} />
                  {strings.firstRun.pick}
                </button>
                <p class="subtle small">{strings.firstRun.dropHint}</p>
              {/if}
            {/if}
            <p class="note">{strings.onboarding.changeLater}</p>
          {/if}
        </div>
      {/key}

      <footer>
        <div class="dots" role="group" aria-label={strings.onboarding.label}>
          {#each screens as id, position (id)}
            <button
              type="button"
              class="dot"
              class:on={position === index}
              class:past={position < index}
              aria-current={position === index ? 'step' : undefined}
              aria-label={fill(strings.onboarding.progress, { index: String(position + 1), title: titleOf(id) })}
              data-testid="onboarding-dot-{id}"
              onclick={() => go(position)}
            ></button>
          {/each}
        </div>
        <button type="button" class="ghost" disabled={index === 0} data-testid="onboarding-back" onclick={() => go(index - 1)}>
          {strings.onboarding.back}
        </button>
        <button type="button" class="primary" data-testid="onboarding-next" onclick={() => (last ? finish() : go(index + 1))}>
          {last ? strings.onboarding.done : strings.onboarding.next}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 55;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: var(--color-scrim);
    backdrop-filter: blur(4px);
    animation: fade var(--dur-2) var(--ease-out-quint);
  }

  .scrim.closing {
    animation-name: fade-out;
    pointer-events: none;
  }

  .panel {
    display: flex;
    flex-direction: column;
    width: min(560px, 100%);
    max-height: min(640px, calc(100dvh - 32px));
    background: var(--color-surface);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-e3);
    animation: pop var(--dur-3) var(--ease-out-quint);
  }

  /* The dialog takes the focus on open so Escape and Tab answer here, and a
     ring around the whole panel is not what that should look like. Every
     control inside it keeps its own. */
  .panel:focus,
  .panel:focus-visible {
    outline: none;
  }

  .panel.closing {
    animation: pop-out var(--dur-2) var(--ease-out-quint);
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    padding: 12px 10px 12px 16px;
    border-bottom: 1px solid var(--color-border);
  }

  .mark {
    display: grid;
    place-items: center;
    color: var(--color-muted-foreground);
  }

  header .label {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-muted-foreground);
  }

  header .count {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--color-subtle);
    font-variant-numeric: tabular-nums;
  }

  .screen {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 20px 24px 22px;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .hero {
    display: grid;
    place-items: center;
    margin-bottom: 10px;
  }

  h1 {
    font-size: var(--text-lg);
    margin-bottom: 8px;
  }

  h2 {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-base);
    font-weight: 600;
    margin-bottom: 4px;
  }

  p {
    margin: 0 0 10px;
    color: var(--color-muted-foreground);
  }

  .lead {
    color: var(--color-foreground);
    line-height: 1.65;
  }

  .note {
    color: var(--color-subtle);
    font-size: var(--text-sm);
  }

  .small {
    font-size: var(--text-sm);
  }

  .half + .half {
    margin-top: 18px;
    padding-top: 16px;
    border-top: 1px solid var(--color-border);
  }

  /* A still of the composer's chip row, and of a usage bar: the screen names a
     control, so it draws it rather than asking the reader to picture it. */
  .demo {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0 14px;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface-2);
    box-shadow: var(--shadow-e1);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: var(--control-sm);
    padding: 0 9px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-foreground);
    font-size: var(--text-sm);
    white-space: nowrap;
  }

  .bars .meters {
    display: flex;
    flex: 1;
    gap: 4px;
  }

  progress {
    flex: 1;
    width: 0;
    min-width: 0;
    appearance: none;
    border: 0;
    height: 4px;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--color-surface-3);
  }

  progress::-webkit-progress-bar { background: var(--color-surface-3); }
  progress::-webkit-progress-value { background: var(--color-success); border-radius: var(--radius-sm); }
  progress::-moz-progress-bar { background: var(--color-success); }
  progress.low::-webkit-progress-value { background: var(--color-live); }
  progress.low::-moz-progress-bar { background: var(--color-live); }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 12px 0 4px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-muted-foreground);
  }

  .row .text {
    flex: 1;
    min-width: 0;
    color: var(--color-foreground);
    font-size: var(--text-base);
  }

  .row .hint {
    display: block;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    margin-top: 2px;
  }

  /* The key as the Keyboard page prints it, so the row reads as the shortcut
     it really has rather than the one the default table would give. */
  kbd {
    flex: none;
    padding: 2px 7px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    color: var(--color-foreground);
    font-family: inherit;
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  kbd.none {
    color: var(--color-subtle);
    background: transparent;
  }

  .segmented {
    display: inline-flex;
    flex: none;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
  }

  .segmented button {
    height: var(--control-sm);
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }

  .segmented button:hover:not(.on) {
    background: var(--color-surface-3);
    color: var(--color-foreground);
  }

  .segmented button.on {
    background: var(--color-foreground);
    border-color: var(--color-foreground);
    color: var(--color-on-foreground);
  }

  .row input[type='checkbox'] {
    flex: none;
    width: 28px;
    height: 16px;
    margin: 0;
    appearance: none;
    border-radius: 999px;
    background: var(--color-edge);
    position: relative;
    cursor: pointer;
    transition: background var(--dur-2) var(--ease-out-quint);
  }

  .row input[type='checkbox']::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--color-background);
    transition: transform var(--dur-2) var(--ease-out-quint);
  }

  .row input[type='checkbox']:checked { background: var(--color-foreground); }
  .row input[type='checkbox']:checked::after { transform: translateX(12px); }
  .row input[type='checkbox']:focus-visible { outline-offset: 3px; }

  .big {
    height: 36px;
    padding: 0 16px;
    margin: 4px 0 6px;
  }

  footer {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
    padding: 12px 16px;
    border-top: 1px solid var(--color-border);
  }

  .dots {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-right: auto;
  }

  /* A dot is a target, not a decoration: the hit area is the row's height and
     only the mark inside it is small. */
  .dot {
    width: 16px;
    height: 16px;
    min-height: 0;
    padding: 0;
    border: none;
    border-radius: 999px;
    background: transparent;
    position: relative;
  }

  .dot::after {
    content: '';
    position: absolute;
    inset: 5px;
    border-radius: 999px;
    background: var(--color-edge);
    transition: background var(--dur-2) var(--ease-out-quint), inset var(--dur-2) var(--ease-out-quint);
  }

  .dot.past::after { background: var(--color-muted-foreground); }
  .dot.on::after { inset: 4px; background: var(--color-foreground); }
  .dot:hover::after { background: var(--color-foreground); }

  @media (max-width: 720px) {
    .panel { max-height: calc(100dvh - 32px); }
    .screen { padding: 16px 16px 18px; }
    .row { flex-wrap: wrap; }
    .segmented { width: 100%; justify-content: stretch; }
    .segmented button { flex: 1; }
    footer { flex-wrap: wrap; justify-content: flex-end; }
    .dots { flex-basis: 100%; justify-content: center; margin-right: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .scrim, .panel, .screen { animation: none; }
  }
</style>
