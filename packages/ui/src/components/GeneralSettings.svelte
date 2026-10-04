<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import TitleModelSetting from './TitleModelSetting.svelte';
  import ShellSettings from './ShellSettings.svelte';
  import TelemetrySettings from './TelemetrySettings.svelte';
  import ArchivedThreads from './ArchivedThreads.svelte';
  import WorktreesCard from './WorktreesCard.svelte';
  import BrowserProfilesCard from './BrowserProfilesCard.svelte';
  import { browserBridge } from '../lib/browser-bridge';
  import { strings } from '../lib/strings';
  import { openTour } from '../lib/onboarding.svelte';
  import type { Store } from '../lib/store.svelte';
  import ThreadGroupingSettings from './ThreadGroupingSettings.svelte';

  /**
   * What the app does for the person in front of it: how a thread
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

  <section class="card" id="settings-conversations">
    <h2>{strings.settings.conversations}</h2>
    <ThreadGroupingSettings />
    <label for="{uid}-notifications" class="switch-row">
      <span class="text ui-label-box">
        <span class="ui-label" id="{uid}-notifications-name">{strings.settings.notifications}</span><InfoTip topic={strings.settings.notifications} text={strings.settings.notificationsHint} />
      </span>
      <input id="{uid}-notifications" aria-labelledby="{uid}-notifications-name" type="checkbox" role="switch" data-testid="setting-notifications"
        checked={store.notifications} onchange={(event) => void store.setNotifications(event.currentTarget.checked)} />
    </label>
    {#if store.owner}
      <label for="{uid}-async" class="switch-row">
        <span class="text ui-label-box">
          <span class="ui-label" id="{uid}-async-name">{strings.settings.asyncQuestions}</span><InfoTip topic={strings.settings.asyncQuestions} text={strings.settings.asyncQuestionsHint} />
        </span>
        <input id="{uid}-async" aria-labelledby="{uid}-async-name" type="checkbox" role="switch" data-testid="setting-async-questions"
          checked={store.settings?.asyncQuestions ?? true} disabled={!store.settings} onchange={(event) => void toggleAsync(event.currentTarget)} />
      </label>
      {#if store.settings}<TitleModelSetting {store} />{/if}
    {/if}
  </section>

  <ArchivedThreads {store} />
  <WorktreesCard {store} />
  <!-- Only a window that shows pages has profiles to keep them in. -->
  {#if browserBridge.paints}<BrowserProfilesCard />{/if}

  <section class="card" id="settings-app">
    <h2>{strings.settings.app}</h2>
    {#if inShell}<ShellSettings />{/if}
    <div class="switch-row">
      <span class="text">
        <span>{strings.onboarding.label}</span>
      </span>
      <button type="button" data-testid="settings-tour" onclick={() => { store.showChat(); openTour(); }}><span class="ui-label">{strings.settings.tourReplay}</span></button>
    </div>
  </section>

  <TelemetrySettings {store} />
</div>
