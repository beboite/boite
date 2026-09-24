<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { untrack } from 'svelte';
  import type { PairedSession } from '@boite/contracts';
  import ShellSettings from './ShellSettings.svelte';
  import PhoneSettings from './PhoneSettings.svelte';
  import ModelDefaultsSettings from './ModelDefaultsSettings.svelte';
  import AppUpdateCard from './AppUpdateCard.svelte';
  import { showAppUpdateUi } from '../lib/app-update.svelte';
  import TelemetrySettings from './TelemetrySettings.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { ago, projectName, time } from '../lib/format';
  import { qrSvg } from '../lib/qr';
  import { fill, strings } from '../lib/strings';
  import { openTour } from '../lib/onboarding.svelte';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();
  const uid = $props.id();

  const inShell = window.__TAURI_INTERNALS__ !== undefined;

  // Off mints a phone's link; on mints one for another computer of the owner's.
  let ownerLink = $state(false);


  // The devices list is read on arrival and after every `sessions.updated`;
  // the pairing link is minted on the button, never on its own.
  $effect(() => {
    if (store.connection === 'ready') void store.loadSessions();
  });

  // The QR code follows the minted link: a new link redraws it, no link clears it.
  let qr = $state('');
  $effect(() => {
    const url = store.pairing?.url;
    if (!url) {
      qr = '';
      return;
    }
    let live = true;
    void qrSvg(url).then((svg) => {
      if (live) qr = svg;
    });
    return () => {
      live = false;
    };
  });

  async function revoke(session: PairedSession) {
    const ok = await confirm.ask({
      title: strings.settings.pairing.revokeTitle,
      body: strings.settings.pairing.revokeBody,
      confirmLabel: strings.settings.pairing.revoke,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (ok) await store.revokeSession(session.id);
  }


  let maxConcurrentTurns = $state(untrack(() => store.settings?.maxConcurrentTurns ?? 6));
  let perAccountConcurrency = $state(untrack(() => store.settings?.perAccountConcurrency ?? 2));
  let warmProcessMinutes = $state(untrack(() => store.settings?.warmProcessMinutes ?? 5));
  let listenOnLan = $state(untrack(() => store.settings?.listenOnLan ?? false));
  let asyncQuestions = $state(untrack(() => store.settings?.asyncQuestions ?? true));
  let savedAt = $state<number | null>(null);

  async function save() {
    await store.saveSettings({
      maxConcurrentTurns,
      perAccountConcurrency,
      warmProcessMinutes,
      listenOnLan,
      asyncQuestions
    });
    savedAt = Date.now();
  }

</script>

<div class="page" data-testid="settings-page">
  <header>
    <h1>{strings.settings.tabs.general}</h1>
  </header>

  {#if inShell}<ShellSettings />{/if}
  {#if showAppUpdateUi()}<AppUpdateCard />{/if}

  <section class="card" id="settings-projects">
    <h2>{strings.settings.projects}{#if store.owner}<InfoTip topic={strings.settings.projects} text={strings.settings.projectsHint} />{/if}</h2>
    {#if store.projects.length > 0}
      <ul class="projects">
        {#each store.projects as project (project.id)}
          <li>
            <span class="name">{projectName(project)}</span>
            <span class="mono subtle path" title={project.path}>{project.path}</span>
          </li>
        {/each}
      </ul>
    {/if}
    <!-- `projects.add` is the owner's, so a paired device reads the list and
         is told where the folders come from. -->
    {#if store.owner}
      <div data-testid="settings-add-project">
        <button type="button" data-testid="settings-project-add" onclick={() => (store.projectPickerOpen = true)}>{strings.firstRun.pick}</button>
      </div>
    {:else}
      <!-- In place of the button a device lacks: a state, so it stays in view. -->
      <p class="subtle hint">{strings.settings.projectsDevice}</p>
    {/if}
  </section>

  <section class="card" id="settings-background">
    <h2>{strings.settings.background}</h2>
    <label for="{uid}-notifications" class="switch-row">
      <span class="text">
        <span id="{uid}-notifications-name">{strings.settings.notifications}</span><InfoTip topic={strings.settings.notifications} text={strings.settings.notificationsHint} />
      </span>
      <input id="{uid}-notifications" aria-labelledby="{uid}-notifications-name"
        type="checkbox"
        role="switch"
        data-testid="setting-notifications"
        checked={store.notifications}
        onchange={(event) => void store.setNotifications(event.currentTarget.checked)}
      />
    </label>
  </section>

  <ModelDefaultsSettings {store} />

  <section class="card" id="settings-machines">
    <h2>{strings.machines.heading}<InfoTip topic={strings.machines.heading} text={strings.machines.intro} /></h2>
    <button data-testid="settings-machines" onclick={() => store.showSettings('machines')}>
      {strings.machines.heading}
    </button>
  </section>

  <section class="card" id="settings-devices" data-testid="pairing-card">
    <h2>{strings.settings.pairing.heading}<InfoTip topic={strings.settings.pairing.heading} text={strings.settings.pairing.intro} /></h2>
    {#if store.principal === 'owner'}
      {#if store.settings && !store.settings.listenOnLan}
        <p class="subtle hint">{strings.settings.pairing.lanHint}</p>
      {/if}
      <label for="{uid}-pairing-owner" class="switch-row">
        <span class="text">
          <span id="{uid}-pairing-owner-name">{strings.settings.pairing.owner}</span><InfoTip topic={strings.settings.pairing.owner} text={strings.settings.pairing.ownerHint} />
        </span>
        <input id="{uid}-pairing-owner" aria-labelledby="{uid}-pairing-owner-name" type="checkbox" role="switch" data-testid="pairing-owner" bind:checked={ownerLink} />
      </label>
      <div class="actions">
        <button
          type="button"
          class="primary"
          data-testid="pairing-mint"
          onclick={() => void store.mintPairing(ownerLink ? 'owner' : 'device')}
        >
          {strings.settings.pairing.mint}
        </button>
        {#if store.pairing}
          <button type="button" onclick={() => void store.copy(store.pairing?.url ?? '')}>
            {strings.settings.pairing.copy}
          </button>
        {/if}
      </div>
      {#if store.pairing}
        <div class="minted">
          <!-- A computer takes the link pasted, so its QR code would only be
               a camera away from the wrong device. -->
          {#if qr && store.pairing.role !== 'owner'}
            <div class="qr" data-testid="pairing-qr" aria-label={strings.settings.pairing.qr}>{@html qr}</div>
          {/if}
          <div class="minted-text">
            <p class="mono wrap link" data-testid="pairing-link">{store.pairing.url}</p>
            <p class="subtle hint">{fill(strings.settings.pairing.expires, { time: time(store.pairing.expiresAt) })}</p>
            <p class="subtle hint">
              {store.pairing.role === 'owner' ? strings.settings.pairing.pasteOwner : strings.settings.pairing.scan}
            </p>
          </div>
        </div>
      {/if}
    {:else}
      <p class="subtle hint">{strings.settings.pairing.paired}</p>
    {/if}
    <h3>{strings.settings.pairing.devices}</h3>
    {#if store.sessions.length === 0}
      <p class="muted">{strings.settings.pairing.noDevices}</p>
    {:else}
      <ul class="devices" data-testid="paired-devices">
        {#each store.sessions as session (session.id)}
          <li data-session-id={session.id}>
            <span class="name">
              {session.client.name} {session.client.version}
              {#if session.role === 'owner'}<span class="subtle">({strings.settings.pairing.ownerTag})</span>{/if}
              {#if session.current}<span class="subtle">({strings.settings.pairing.thisDevice})</span>{/if}
            </span>
            <span class="subtle seen">{fill(strings.settings.pairing.lastSeen, { when: ago(session.lastSeenAt) })}</span>
            {#if store.principal === 'owner'}
              <button type="button" class="ghost small danger" onclick={() => void revoke(session)}>
                {strings.settings.pairing.revoke}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Every field here ends in one `settings.set` under the Save button, and
       `listenOnLan` decides whether the phone can reach the core at all. The
       whole card is the owner's machine, so the device does not see it. -->
  {#if store.owner}
    <section class="card" id="settings-scheduler">
      <h2>{strings.settings.scheduler}</h2>
      <div class="grid">
        <label>
          <span>{strings.settings.maxConcurrentTurns}</span>
          <input type="number" min="1" max="64" bind:value={maxConcurrentTurns} />
        </label>
        <label>
          <span>{strings.settings.perAccountConcurrency}</span>
          <input type="number" min="1" max="32" bind:value={perAccountConcurrency} />
        </label>
        <label>
          <span>{strings.settings.warmProcessMinutes}</span>
          <input type="number" min="0" max="120" bind:value={warmProcessMinutes} />
        </label>
      </div>
      <label for="{uid}-listen-on-lan" class="switch-row">
        <span class="text">
          <span id="{uid}-listen-on-lan-name">{strings.settings.listenOnLan}</span><InfoTip topic={strings.settings.listenOnLan} text={strings.settings.listenOnLanHint} />
        </span>
        <input id="{uid}-listen-on-lan" aria-labelledby="{uid}-listen-on-lan-name" type="checkbox" role="switch" data-testid="setting-listen-on-lan" bind:checked={listenOnLan} />
      </label>
      <label class="switch-row">
        <span class="text">
          {strings.settings.asyncQuestions}
          <span class="hint">{strings.settings.asyncQuestionsHint}</span>
        </span>
        <input type="checkbox" role="switch" data-testid="setting-async-questions" bind:checked={asyncQuestions} />
      </label>
      <div class="actions">
        <button type="button" class="primary" onclick={() => void save()}>{strings.settings.save}</button>
        {#if savedAt !== null}
          <span class="muted">{strings.settings.saved} {time(savedAt)}</span>
        {/if}
      </div>
    </section>
  {/if}

  <section class="card" id="settings-tour">
    <h2>{strings.onboarding.label}<InfoTip topic={strings.onboarding.label} text={strings.onboarding.replayHint} /></h2>
    <button type="button" data-testid="settings-tour" onclick={() => { store.showChat(); openTour(); }}>
      {strings.onboarding.replay}
    </button>
  </section>

  <TelemetrySettings {store} />
  <!-- Serving the app over HTTPS behind a reverse proxy is a server's
       business: it sits under everything a person on a laptop uses. -->
  <PhoneSettings {store} />

  <section class="card" id="settings-core">
    <h2>{strings.settings.core}</h2>
    {#if store.core}
      <dl>
        <dt>{strings.settings.version}</dt>
        <dd class="mono" data-testid="settings-version">{store.core.version}</dd>
        <dt>{strings.settings.protocol}</dt>
        <dd class="mono">{store.core.protocolVersion}</dd>
        <dt>{strings.settings.os}</dt>
        <dd class="mono">{store.core.os}</dd>
        <dt>{strings.settings.pid}</dt>
        <dd class="mono">{store.core.pid}</dd>
        <dt>{strings.settings.endpoint}</dt>
        <dd class="mono" data-testid="settings-endpoint">
          {store.core.endpoint.host}:{store.core.endpoint.port}
        </dd>
        <dt>{strings.settings.dataDir}</dt>
        <dd class="mono">{store.core.dataDir}</dd>
      </dl>
    {:else}
      <p class="muted">{strings.settings.noCore}</p>
    {/if}
  </section>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 10px;
  }

  input {
    width: 100%;
  }

  .hint {
    font-size: var(--text-sm);
    margin: 0 0 12px;
  }


  .projects {
    list-style: none;
    margin: 0 0 6px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .projects li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }

  .projects .name {
    font-weight: 600;
    flex: none;
  }

  .projects .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
  }



  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
  }

  dl {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 4px 12px;
    margin: 0;
  }

  dt {
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    padding-top: 2px;
  }

  dd {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .wrap {
    word-break: break-all;
    white-space: normal;
  }

  h3 {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-muted-foreground);
    margin: 16px 0 6px;
  }

  .minted {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    margin-top: 10px;
  }

  .minted-text {
    flex: 1;
    min-width: 0;
  }

  .minted-text .link {
    margin-top: 0;
  }

  .qr {
    flex: none;
    width: 132px;
    height: 132px;
    padding: 8px;
    box-sizing: border-box;
    border-radius: var(--radius-md);
    background: #ffffff;
    border: 1px solid var(--color-border);
  }

  .qr :global(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }

  .link {
    margin: 10px 0 2px;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
    user-select: all;
  }

  .devices {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .devices li {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--row);
    padding: 0 4px 0 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .devices .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .devices .seen {
    font-size: var(--text-xs);
    flex: none;
  }

  .danger {
    color: var(--color-danger);
  }
</style>
