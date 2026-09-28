<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import TitleModelSetting from './TitleModelSetting.svelte';
  import ShellSettings from './ShellSettings.svelte';
  import AppUpdateCard from './AppUpdateCard.svelte';
  import { showAppUpdateUi } from '../lib/app-update.svelte';
  import TelemetrySettings from './TelemetrySettings.svelte';
  import ArchivedThreads from './ArchivedThreads.svelte';
  import { strings } from '../lib/strings';
  import { openTour } from '../lib/onboarding.svelte';
  import { work } from '../lib/work-prefs.svelte';
  import type { Store } from '../lib/store.svelte';

  /**
   * What the app does for the person in front of it: updates, how a thread
   * reaches them, the archive, the window and the tour. Where agents run and
   * how many at once live under Machines and Advanced.
   */
  let { store }: { store: Store } = $props();
  const uid = $props.id();
  const inShell = window.__TAURI_INTERNALS__ !== undefined;

  /** A switch saves when it flips, as every other switch in Settings does; a refusal puts it back. */
  async function toggleAsync(input: HTMLInputElement) {
    const ok = await store.saveSettings({ asyncQuestions: input.checked });
    if (!ok) input.checked = store.settings?.asyncQuestions ?? !input.checked;
  }
</script>

<div class="page" data-testid="settings-page">
  <header>
    <h1>{strings.settings.tabs.general}</h1>
  </header>

  {#if showAppUpdateUi()}<AppUpdateCard />{/if}

  <section class="card" id="settings-conversations">
    <h2>{strings.settings.conversations}</h2>
    <label for="{uid}-notifications" class="switch-row">
      <span class="text">
        <span id="{uid}-notifications-name">{strings.settings.notifications}</span><InfoTip topic={strings.settings.notifications} text={strings.settings.notificationsHint} />
      </span>
      <input id="{uid}-notifications" aria-labelledby="{uid}-notifications-name" type="checkbox" role="switch" data-testid="setting-notifications"
        checked={store.notifications} onchange={(event) => void store.setNotifications(event.currentTarget.checked)} />
    </label>
    {#if store.owner}
      <label for="{uid}-async" class="switch-row">
        <span class="text">
          <span id="{uid}-async-name">{strings.settings.asyncQuestions}</span><InfoTip topic={strings.settings.asyncQuestions} text={strings.settings.asyncQuestionsHint} />
        </span>
        <input id="{uid}-async" aria-labelledby="{uid}-async-name" type="checkbox" role="switch" data-testid="setting-async-questions"
          checked={store.settings?.asyncQuestions ?? true} disabled={!store.settings} onchange={(event) => void toggleAsync(event.currentTarget)} />
      </label>
      {#if store.settings}<TitleModelSetting {store} />{/if}
    {/if}
  </section>

  <ArchivedThreads {store} />

  <section class="card" id="settings-app">
    <h2>{strings.settings.app}</h2>
    {#if inShell}<ShellSettings />{/if}
    <label for="{uid}-developer" class="switch-row">
      <span class="text">
        <span id="{uid}-developer-name">{strings.settings.developer}</span><InfoTip topic={strings.settings.developer} text={strings.settings.developerHint} />
      </span>
      <input id="{uid}-developer" aria-labelledby="{uid}-developer-name" type="checkbox" role="switch" data-testid="setting-developer"
        checked={work.current.developer} onchange={(event) => work.setDeveloper(event.currentTarget.checked)} />
    </label>
    <div class="switch-row">
      <span class="text">
        <span>{strings.onboarding.label}</span><InfoTip topic={strings.onboarding.label} text={strings.onboarding.replayHint} />
      </span>
      <button type="button" data-testid="settings-tour" onclick={() => { store.showChat(); openTour(); }}>{strings.settings.tourReplay}</button>
    </div>
  </section>

  <TelemetrySettings {store} />
</div>
