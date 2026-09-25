<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { AppWindow, ArrowLeftRight, Bell, Check, FileDiff, Languages, MessageCircle, Mic, Minimize2, Palette, SquareTerminal, VolumeX, X } from '@lucide/svelte';
  import type { SpeechStatus } from '@boite/contracts';
  import TelemetryDeal from './TelemetryDeal.svelte';
  import OnboardingScene from './OnboardingScene.svelte';
  import BoiteMark from './BoiteMark.svelte';
  import { Closing } from '../lib/closing.svelte';
  import { focusedElement, restoreFocus } from '../lib/focus';
  import { fill, LOCALES, localeSetting, setLocaleSetting, strings, type LocaleSetting } from '../lib/i18n.svelte';
  import { steps, type OnboardingStep } from '../lib/onboarding';
  import { closeTour } from '../lib/onboarding.svelte';
  import { readTheme, setTheme, type Theme } from '../lib/theme';
  import { work, type Profile } from '../lib/work-prefs.svelte';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();
  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  const screens = $derived(steps(store.owner));
  let index = $state(0);
  $effect(() => { if (index >= screens.length) index = screens.length - 1; });
  const step = $derived<OnboardingStep>(screens[index] ?? 'welcome');
  const last = $derived(index === screens.length - 1);
  let panel = $state<HTMLDivElement>();
  let example = $state<'agents' | 'voice' | 'panel'>('agents');
  let locale = $state<LocaleSetting>(localeSetting());
  let theme = $state<Theme>(readTheme());
  const themes = $derived([{ id: 'system', label: strings.settings.themeSystem }, { id: 'dark', label: strings.settings.themeDark }, { id: 'light', label: strings.settings.themeLight }] as const);
  const examples = $derived([{ id: 'agents', label: strings.onboarding.demo.conversation }, { id: 'voice', label: strings.onboarding.demo.voice }, { id: 'panel', label: strings.onboarding.demo.panel }] as const);
  const profiles = $derived([
    { id: 'everyday', label: strings.onboarding.profile.everyday, hint: strings.onboarding.profile.everydayHint },
    { id: 'developer', label: strings.onboarding.profile.developer, hint: strings.onboarding.profile.developerHint }
  ] as const);
  /** Picking writes the preset at once: skipping the rest of the tour keeps the answer. */
  function pickProfile(profile: Profile) { store.applyProfile(profile); }
  const overlay = new Closing();
  overlay.show();
  $effect(() => { if (!overlay.shown) closeTour(); });
  /** What had the keyboard when the tour opened; the composer when that was nothing. */
  const previous = focusedElement();
  onMount(() => panel?.focus({ preventScroll: true }));
  function finish() { overlay.hide(); restoreFocus(previous); }
  function go(next: number) {
    index = Math.min(screens.length - 1, Math.max(0, next));
    void tick().then(() => {
      panel?.querySelector('.screen')?.scrollTo?.(0, 0);
      panel?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
    });
  }
  function onkeydown(event: KeyboardEvent) {
    if (!overlay.open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(); return; }
    if (event.key !== 'Tab' || !panel) return;
    const stops = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
    const first = stops[0], end = stops.at(-1), active = document.activeElement;
    if (!first || !end) return;
    if (event.shiftKey ? panel.contains(active) && active !== first && active !== panel && active?.tagName !== 'H1' : panel.contains(active) && active !== end) return;
    event.preventDefault(); (event.shiftKey ? end : first).focus({ preventScroll: true });
  }
  let tray = $state(false), trayReady = $state(false), trayBusy = $state(false);
  let error = $state('');
  async function readTray() {
    if (!inShell) return;
    try { const { invoke } = await import('@tauri-apps/api/core'); tray = await invoke<boolean>('close_behavior', {}); trayReady = true; }
    catch (cause) { error = String(cause); }
  }
  async function setTray(enabled: boolean) {
    trayBusy = true; error = '';
    try { const { invoke } = await import('@tauri-apps/api/core'); tray = await invoke<boolean>('close_behavior', { enabled }); }
    catch (cause) { error = String(cause); }
    finally { trayBusy = false; }
  }
  let speech = $state<SpeechStatus | null>(null), speechBusy = $state(false), speechError = $state(''), speechPollError = $state('');
  $effect(() => {
    const client = store.client;
    if (step !== 'agents' || example !== 'voice' || !client || !store.owner) return;
    let active = true;
    speech = null;
    speechPollError = '';
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try { const value = await client.call('speech.status', {}); if (active) { speech = value; speechPollError = ''; } }
      catch (cause) { if (active) speechPollError = String(cause); }
      if (active) timer = setTimeout(() => void read(), 1500);
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  });
  async function setupVoice(cancel = false) {
    const client = store.client;
    if (!client || !store.owner) return;
    speechBusy = true; speechError = '';
    try {
      if (!cancel) {
        const config = await client.call('speech.config', {});
        if (store.client !== client || !store.owner) return;
        await client.call('speech.configure', { ...config, engine: 'local' });
      }
      if (store.client !== client || !store.owner) return;
      const value = await client.call(cancel ? 'speech.installCancel' : 'speech.install', {});
      if (store.client === client) speech = value;
    } catch (cause) { if (store.client === client) speechError = String(cause); }
    finally { speechBusy = false; }
  }
  $effect(() => { if (step === 'quiet') untrack(() => void readTray()); });
</script>

<svelte:window onkeydowncapture={onkeydown} />
{#if overlay.shown}
  <div class="scrim" class:shell={inShell} class:closing={overlay.closing} role="presentation" data-testid="onboarding">
    <div class="panel" class:closing={overlay.closing} role="dialog" aria-modal="true" aria-labelledby="onboarding-title" tabindex="-1" bind:this={panel} use:overlay.attach onanimationend={overlay.end}>
      <header><BoiteMark size={18} /><span>{strings.onboarding.label}</span><button class="ghost icon" data-testid="onboarding-skip" aria-label={strings.onboarding.skip} onclick={finish}><X size={16} /></button></header>
      {#key step}
        <div class="screen" data-testid="onboarding-step" data-step={step}>
          <h1 id="onboarding-title" tabindex="-1" class:soul={step === 'privacy'}>{strings.onboarding[step].title}</h1>
          {#if step === 'welcome'}
            <p class="lead">{strings.onboarding.welcome.body}</p>
            <OnboardingScene scene="welcome" />
            <div class="preferences">
              <div class="preference"><Languages size={17} /><span>{strings.settings.language}</span><div class="segmented" role="group" aria-label={strings.settings.language}>
                <button class:on={locale === 'system'} aria-pressed={locale === 'system'} data-testid="onboarding-locale-system" onclick={() => { locale = 'system'; setLocaleSetting(locale); }}>{strings.settings.languageSystem}</button>
                {#each LOCALES as id (id)}<button class:on={locale === id} aria-pressed={locale === id} data-testid="onboarding-locale-{id}" onclick={() => { locale = id; setLocaleSetting(id); }}>{strings.settings.languageNames[id]}</button>{/each}
              </div></div>
              <div class="preference"><Palette size={17} /><span>{strings.settings.theme}</span><div class="segmented" role="group" aria-label={strings.settings.theme}>
                {#each themes as option (option.id)}<button class:on={theme === option.id} aria-pressed={theme === option.id} data-testid="onboarding-theme-{option.id}" onclick={() => { theme = option.id; setTheme(theme); }}>{option.label}</button>{/each}
              </div></div>
            </div>
          {:else if step === 'profile'}
            <div class="profiles" role="group" aria-labelledby="onboarding-title">
              {#each profiles as item (item.id)}
                <button class:on={work.current.profile === item.id} aria-pressed={work.current.profile === item.id} data-testid="onboarding-profile-{item.id}" onclick={() => pickProfile(item.id)}>
                  {#if item.id === 'everyday'}<MessageCircle size={20} />{:else}<SquareTerminal size={20} />{/if}
                  <span class="answer"><strong>{item.label}</strong><span>{item.hint}</span></span>
                  {#if work.current.profile === item.id}<Check size={13} class="selected-mark" />{/if}
                </button>
              {/each}
            </div>
            <p class="detail">{strings.onboarding.profile.later}</p>
          {:else if step === 'agents'}
            <p class="lead">{strings.onboarding.demo.workspaceBody}</p>
            <div class="examples" role="group" aria-label={strings.onboarding.agents.title}>
              {#each examples as item (item.id)}
                <button class:on={example === item.id} aria-pressed={example === item.id} data-testid="onboarding-example-{item.id}" onclick={() => { example = item.id; }}>
                  {#if item.id === 'agents'}<ArrowLeftRight size={20} />{:else if item.id === 'voice'}<Mic size={20} />{:else}<FileDiff size={20} />{/if}
                  <span>{item.label}</span>
                  {#if example === item.id}<Check size={13} class="selected-mark" />{/if}
                </button>
              {/each}
            </div>
            <OnboardingScene scene={example} />
            {#if example === 'voice' && store.owner}
              <div class="voice-setup">
                {#if speech?.ready}<p data-testid="onboarding-voice-ready">{strings.onboarding.demo.readyVoice}</p>
                {:else if speech?.installing}
                  <label>{strings.onboarding.demo.installingVoice}<progress max={speech.totalBytes || 1} value={speech.downloadedBytes}></progress></label>
                  <button disabled={speechBusy} onclick={() => void setupVoice(true)}>{strings.onboarding.demo.cancelVoice}</button>
                {:else if speech?.canInstallRuntime}
                  <span>{strings.onboarding.demo.downloadVoice}</span><button data-testid="onboarding-voice-install" disabled={speechBusy} onclick={() => void setupVoice()}>{strings.onboarding.demo.installVoice}</button>
                {:else}<p>{speech ? strings.onboarding.changeLater : strings.onboarding.voice.reading}</p>{/if}
                {#if speechError || speechPollError || speech?.error}<p role="alert">{speechError || speechPollError || speech?.error}</p>{/if}
              </div>
            {/if}
          {:else if step === 'usage'}
            <p class="lead">{strings.onboarding.usage.body}</p>
            <OnboardingScene scene="usage" />
            <p class="caption">{strings.onboarding.demo.tray}</p><p class="detail">{strings.onboarding.demo.trayHint}</p>
          {:else if step === 'reach'}
            <p class="lead">{strings.onboarding.demo.reachHint}</p>
            <OnboardingScene scene="reach" />
            <p class="detail">{strings.onboarding.reach.machinesBody}</p>
          {:else if step === 'quiet'}
            <p class="lead">{strings.onboarding.demo.quietBody}</p>
            <div class="quiet-scene"><OnboardingScene scene="quiet" /></div>
            <div class="rows">
              <label class="row"><Bell size={18} /><span>{strings.settings.notifications}</span><input type="checkbox" role="switch" data-testid="onboarding-notifications" checked={store.notifications} onchange={event => void store.setNotifications(event.currentTarget.checked)} /></label>
              {#if inShell}<label class="row"><Minimize2 size={18} /><span>{strings.settings.closeToTray}</span><input type="checkbox" role="switch" data-testid="onboarding-tray" checked={tray} disabled={!trayReady || trayBusy} onchange={event => void setTray(event.currentTarget.checked)} /></label>{/if}
              {#if store.owner}
                <label class="row"><AppWindow size={18} /><span>{strings.settings.focusGuard}</span><input type="checkbox" role="switch" data-testid="onboarding-focus-guard" checked={store.settings?.focusGuard ?? true} onchange={event => void store.saveSettings({ focusGuard: event.currentTarget.checked })} /></label>
                <label class="row"><VolumeX size={18} /><span>{strings.settings.muteAgents}</span><input type="checkbox" role="switch" data-testid="onboarding-mute" checked={store.settings?.muteAgents ?? true} onchange={event => void store.saveSettings({ muteAgents: event.currentTarget.checked })} /></label>
              {/if}
            </div>
            {#if error}<p role="alert">{error}</p>{/if}
          {:else if step === 'privacy'}
            <TelemetryDeal {store} onchosen={finish} />
          {/if}
        </div>
      {/key}
      <footer>
        <div class="dots" role="group" aria-label={strings.onboarding.label}>
          {#each screens as id, position (id)}<button class="dot" class:on={position === index} aria-current={position === index ? 'step' : undefined} aria-label={fill(strings.onboarding.progress, { index: String(position + 1), title: strings.onboarding[id].title })} data-testid="onboarding-dot-{id}" onclick={() => go(position)}></button>{/each}
        </div>
        <button class="ghost" disabled={index === 0} data-testid="onboarding-back" onclick={() => go(index - 1)}>{strings.onboarding.back}</button>
        <!-- The consent rows are the privacy screen's way out. -->
        {#if step !== 'privacy'}<button class="primary" data-testid="onboarding-next" onclick={() => last ? finish() : go(index + 1)}>{last ? strings.onboarding.done : strings.onboarding.next}</button>{/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 55; display: grid; place-items: center; padding: 16px; background: var(--color-scrim); backdrop-filter: blur(4px); animation: fade var(--dur-2) var(--ease-out-quint); }
  .scrim.closing { animation-name: fade-out; pointer-events: none; }
  /* The title bar stays above the tour: the window can still be moved, minimized or closed. */
  .scrim.shell { top: var(--titlebar); }
  /* In the shell the scrim starts under the title bar, so the panel's room is that much shorter. */
  .scrim.shell .panel { height: min(808px, calc(100dvh - 32px - var(--titlebar))); }
  /* One height for every step, so Next stays under the pointer from one screen to the next; a longer step scrolls. */
  .panel { display: flex; flex-direction: column; width: min(640px, 100%); height: min(808px, calc(100dvh - 32px)); background: var(--color-surface); border: 1px solid var(--color-edge); border-radius: var(--radius-xl); box-shadow: var(--shadow-e3); animation: pop var(--dur-3) var(--ease-out-quint); }
  .panel:focus, h1:focus { outline: none; }
  .panel.closing { animation: pop-out var(--dur-2) var(--ease-out-quint); }
  header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  header button { margin-left: auto; }
  .screen { flex: 1; overflow-y: auto; min-height: 0; padding: 12px 28px 24px; }
  h1 { font-size: var(--text-lg); line-height: 1.35; margin: 0 0 8px; }
  h1.soul { text-align: center; font-size: var(--text-xl); font-weight: 900; letter-spacing: .08em; animation: soul 10s linear forwards; }
  @keyframes soul {
    from { color: var(--color-foreground); text-shadow: 0 0 0 transparent; }
    40% { color: color-mix(in srgb, var(--color-danger) 65%, var(--color-foreground)); text-shadow: 0 0 6px color-mix(in srgb, var(--color-danger) 20%, transparent); }
    to { color: var(--color-danger); text-shadow: 0 0 18px color-mix(in srgb, var(--color-danger) 60%, transparent); }
  }
  p { margin: 0; }
  .lead, .detail { color: var(--color-muted-foreground); font-size: var(--text-base); line-height: 1.6; }
  .caption { font-size: var(--text-base); font-weight: 500; margin-top: 12px; }
  .detail { margin-top: 6px; }
  .preferences { display: grid; gap: 12px; }
  .preference { display: flex; align-items: center; gap: 10px; }
  .preference > span { margin-right: auto; }
  .segmented { display: flex; gap: 4px; }
  .segmented { padding: 3px; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .segmented button { border: 0; background: transparent; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .segmented button.on { background: var(--color-accent-soft); color: var(--color-foreground); }
  .examples { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 16px; }
  .examples button { position: relative; display: flex; flex-direction: column; justify-content: center; gap: 8px; height: auto; min-height: 76px; padding: 12px 8px; white-space: normal; line-height: 1.3; border: 1px solid var(--color-edge); border-radius: var(--radius-lg); background: var(--color-surface-2); color: var(--color-muted-foreground); font-size: var(--text-sm); cursor: pointer; }
  .examples button:hover { color: var(--color-foreground); background: var(--color-hover); border-color: var(--color-accent); }
  .examples button.on { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-foreground); box-shadow: inset 0 -2px var(--color-accent); }
  .examples :global(.selected-mark) { position: absolute; top: 7px; right: 7px; color: var(--color-accent); }
  .profiles { display: grid; gap: 8px; margin: 16px 0 12px; }
  .profiles button { position: relative; display: flex; align-items: flex-start; gap: 14px; height: auto; padding: 16px 36px 16px 16px; white-space: normal; text-align: left; border: 1px solid var(--color-edge); border-radius: var(--radius-lg); background: var(--color-surface-2); color: var(--color-muted-foreground); cursor: pointer; }
  .profiles button :global(svg) { flex: none; margin-top: 2px; }
  .profiles button:hover { color: var(--color-foreground); background: var(--color-hover); border-color: var(--color-accent); }
  .profiles button.on { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-foreground); }
  .profiles :global(.selected-mark) { position: absolute; top: 10px; right: 10px; color: var(--color-accent); }
  .answer { display: grid; gap: 4px; }
  .answer strong { font-size: var(--text-base); font-weight: 600; line-height: 1.4; color: var(--color-foreground); }
  .answer span { font-size: var(--text-sm); line-height: 1.5; }
  .voice-setup { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 12px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .voice-setup progress { display: block; width: 100%; margin-top: 6px; accent-color: var(--color-accent); }
  .quiet-scene { margin: auto; }
  .rows { display: grid; gap: 4px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--color-border); }
  .row > span { flex: 1; font-size: var(--text-base); }
  .row :global(svg) { flex: none; color: var(--color-muted-foreground); }
  input[type=checkbox] { appearance: none; position: relative; flex: 0 0 36px; width: 36px; height: 22px; margin: 0; border: 1px solid var(--color-edge); border-radius: 999px; background: var(--color-surface-3); cursor: pointer; }
  input::after { content: ''; position: absolute; width: 14px; height: 14px; top: 3px; left: 3px; border-radius: 50%; background: var(--color-muted-foreground); transition: transform var(--dur-2) var(--ease-out-quint); }
  input:checked { background: var(--color-foreground); } input:checked::after { background: var(--color-background); transform: translateX(14px); }
  [role=alert] { color: var(--color-danger); overflow-wrap: anywhere; }
  footer { display: flex; align-items: center; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--color-border); }
  .dots { display: flex; margin-right: auto; }
  .dot { position: relative; width: 26px; height: 32px; padding: 0; border: 0; background: transparent; }
  .dot::after { content: ''; position: absolute; width: 6px; height: 6px; left: 10px; top: 13px; border-radius: 999px; background: var(--color-edge); }
  .dot.on::after { background: var(--color-accent); width: 14px; left: 6px; }
  @media (max-width: 480px) {
    .screen { padding: 8px 18px 18px; } .preference { flex-wrap: wrap; } .segmented { flex-basis: 100%; } .segmented button { flex: 1; }
    footer { padding: 12px; gap: 4px; } .dot { width: 20px; } .dot::after { left: 7px; } .dot.on::after { left: 3px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .scrim, .panel { animation: none; }
    h1.soul { animation: none; color: var(--color-danger); }
    /* Keep animationend so closing also persists the completed tour. */
    .scrim.closing, .panel.closing { animation-duration: 1ms; }
  }
</style>
