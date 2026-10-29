<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import TitleModelSetting from './TitleModelSetting.svelte';
  import GoalTrackerSetting from './GoalTrackerSetting.svelte';
  import ShellSettings from './ShellSettings.svelte';
  import TelemetrySettings from './TelemetrySettings.svelte';
  import ArchivedThreads from './ArchivedThreads.svelte';
  import WorktreesCard from './WorktreesCard.svelte';
  import WindowAllowlistCard from './WindowAllowlistCard.svelte';
  import WindowExclusionsCard from './WindowExclusionsCard.svelte';
  import SecretsCard from './SecretsCard.svelte';
  import BrowserProfilesCard from './BrowserProfilesCard.svelte';
  import { strings } from '../lib/strings';
  import { openTour } from '../lib/onboarding.svelte';
  import type { Store } from '../lib/store.svelte';
  import ConversationSwitches from './ConversationSwitches.svelte';
  import NotificationKinds from './NotificationKinds.svelte';
  import SyncMark from './SyncMark.svelte';

  /**
   * What the app does for the person in front of it: how a thread
   * reaches them, the archive, the window and the tour. Where agents run and
   * how many at once live under Machines and Advanced.
   */
  /** `store` is the machine whose settings these are; `here`, this window's, holds its notifications and tour. */
  let { store, here = store }: { store: Store; here?: Store } = $props();
  const uid = $props.id();
  const inShell = window.__TAURI_INTERNALS__ !== undefined;

  /** A switch saves when it flips, as every other switch in Settings does; a refusal puts it back. */
  async function toggle(key: 'asyncQuestions' | 'shortAnswers' | 'toolSummaries', input: HTMLInputElement) {
    const ok = await store.saveSettings({ [key]: input.checked });
    if (!ok) input.checked = store.settings?.[key] ?? (key === 'toolSummaries' ? false : true);
  }
</script>

<div class="page" data-testid="settings-page">
  <header>
    <h1>{strings.settings.tabs.general}</h1>
  </header>

  <section class="card" id="settings-conversations">
    <h2>{strings.settings.conversations}</h2>
    <ConversationSwitches />
    <label for="{uid}-notifications" class="switch-row">
      <span class="text ui-label-box">
        <span class="ui-label" id="{uid}-notifications-name">{strings.settings.notifications}</span><InfoTip topic={strings.settings.notifications} text={strings.settings.notificationsHint} />
      </span>
      <input id="{uid}-notifications" aria-labelledby="{uid}-notifications-name" type="checkbox" role="switch" data-testid="setting-notifications"
        checked={here.notifications} onchange={(event) => void here.setNotifications(event.currentTarget.checked)} />
    </label>
    <NotificationKinds store={here} />
    {#if store.owner}
      <label for="{uid}-async" class="switch-row">
        <span class="text ui-label-box">
          <span class="ui-label" id="{uid}-async-name">{strings.settings.asyncQuestions}</span><InfoTip topic={strings.settings.asyncQuestions} text={strings.settings.asyncQuestionsHint} /><SyncMark {store} key="asyncQuestions" />
        </span>
        <input id="{uid}-async" aria-labelledby="{uid}-async-name" type="checkbox" role="switch" data-testid="setting-async-questions"
          checked={store.settings?.asyncQuestions ?? true} disabled={!store.settings} onchange={(event) => void toggle('asyncQuestions', event.currentTarget)} />
      </label>
      <label for="{uid}-short" class="switch-row">
        <span class="text ui-label-box">
          <span class="ui-label" id="{uid}-short-name">{strings.settings.shortAnswers}</span><InfoTip topic={strings.settings.shortAnswers} text={strings.settings.shortAnswersHint} /><SyncMark {store} key="shortAnswers" />
        </span>
        <input id="{uid}-short" aria-labelledby="{uid}-short-name" type="checkbox" role="switch" data-testid="setting-short-answers"
          checked={store.settings?.shortAnswers ?? true} disabled={!store.settings} onchange={(event) => void toggle('shortAnswers', event.currentTarget)} />
      </label>
      <label for="{uid}-tool-summaries" class="switch-row">
        <span class="text ui-label-box">
          <span class="ui-label" id="{uid}-tool-summaries-name">{strings.settings.toolSummaries}</span><InfoTip topic={strings.settings.toolSummaries} text={strings.settings.toolSummariesHint} /><SyncMark {store} key="toolSummaries" />
        </span>
        <input id="{uid}-tool-summaries" aria-labelledby="{uid}-tool-summaries-name" type="checkbox" role="switch" data-testid="setting-tool-summaries"
          checked={store.settings?.toolSummaries ?? false} disabled={!store.settings} onchange={(event) => void toggle('toolSummaries', event.currentTarget)} />
      </label>
      {#if store.settings}<TitleModelSetting {store} /><GoalTrackerSetting {store} />{/if}
    {/if}
  </section>

  <ArchivedThreads {store} />
  <WorktreesCard {store} />
  <WindowAllowlistCard {store} />
  <WindowExclusionsCard {store} />
  <SecretsCard />
  <!-- Profiles also configure the core's agent browser from a plain web client. -->
  {#if here.owner}<BrowserProfilesCard />{/if}

  <section class="card" id="settings-app">
    <h2>{strings.settings.app}</h2>
    {#if inShell}<ShellSettings />{/if}
    <div class="switch-row">
      <span class="text">
        <span>{strings.onboarding.label}</span>
      </span>
      <button type="button" data-testid="settings-tour" onclick={() => { here.showChat(); openTour(); }}><span class="ui-label">{strings.settings.tourReplay}</span></button>
    </div>
  </section>

  <TelemetrySettings {store} />
</div>
