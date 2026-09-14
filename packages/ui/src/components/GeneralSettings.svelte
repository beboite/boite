<script lang="ts">
  import { untrack } from 'svelte';
  import type { PairedSession } from '@boite/contracts';
  import ShellSettings from './ShellSettings.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { ago, time } from '../lib/format';
  import { readStoredEndpoint } from '../lib/endpoint';
  import { qrSvg } from '../lib/qr';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  const stored = readStoredEndpoint();
  const inShell = window.__TAURI_INTERNALS__ !== undefined;

  let url = $state(
    untrack(() => stored?.url ?? (store.core ? `http://${store.core.endpoint.host}:${store.core.endpoint.port}` : ''))
  );
  let token = $state(stored?.paired ? '' : (stored?.token ?? ''));

  // A link minted by a core somewhere else, pasted here to drive that core.
  let pairingLink = $state('');
  // Off mints a phone's link; on mints one for another computer of the owner's.
  let ownerLink = $state(false);

  async function pair(event: SubmitEvent) {
    event.preventDefault();
    const link = pairingLink.trim();
    if (link.length === 0) return;
    if (await store.pairWith(link)) pairingLink = '';
  }

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

  let projectPath = $state('');

  let maxConcurrentTurns = $state(untrack(() => store.settings?.maxConcurrentTurns ?? 6));
  let perAccountConcurrency = $state(untrack(() => store.settings?.perAccountConcurrency ?? 2));
  let warmProcessMinutes = $state(untrack(() => store.settings?.warmProcessMinutes ?? 5));
  let listenOnLan = $state(untrack(() => store.settings?.listenOnLan ?? false));
  let agentCpuCapPercent = $state(untrack(() => store.settings?.agentCpuCapPercent ?? 75));
  let threadMemoryCapMb = $state(untrack(() => store.settings?.threadMemoryCapMb ?? 0));
  let focusGuard = $state(untrack(() => store.settings?.focusGuard ?? true));
  let muteAgents = $state(untrack(() => store.settings?.muteAgents ?? true));
  let savedAt = $state<number | null>(null);

  // A switch is the whole control, so it writes on its own rather than waiting
  // behind the scheduler card's Save button.
  async function saveFocusGuard() {
    await store.saveSettings({ focusGuard });
  }

  async function saveMuteAgents() {
    await store.saveSettings({ muteAgents });
  }

  async function save() {
    await store.saveSettings({
      maxConcurrentTurns,
      perAccountConcurrency,
      warmProcessMinutes,
      listenOnLan,
      agentCpuCapPercent,
      threadMemoryCapMb,
      focusGuard,
      muteAgents
    });
    savedAt = Date.now();
  }

  async function addProject(event: SubmitEvent) {
    event.preventDefault();
    const path = projectPath.trim();
    if (path.length === 0) return;
    const project = await store.addProject(path);
    if (project) projectPath = '';
  }
</script>

<div class="page" data-testid="settings-page">
  <header>
    <h1>{strings.settings.tabs.general}</h1>
  </header>

  {#if inShell}<ShellSettings />{/if}

  <section class="card">
    <h2>{strings.settings.projects}</h2>
    {#if store.projects.length > 0}
      <ul class="projects">
        {#each store.projects as project (project.id)}
          <li>
            <span class="name">{project.name}</span>
            <span class="mono subtle path" title={project.path}>{project.path}</span>
          </li>
        {/each}
      </ul>
      {#if store.owner}<p class="subtle hint">{strings.settings.projectsHint}</p>{/if}
    {/if}
    <!-- `projects.add` is the owner's, so a paired device reads the list and
         is told where the folders come from. -->
    {#if store.owner}
      <form class="row" onsubmit={addProject} data-testid="settings-add-project">
        {#if store.pickerAvailable}
          <button type="button" onclick={() => void store.pickProject()}>{strings.firstRun.pick}</button>
        {/if}
        <input
          bind:value={projectPath}
          placeholder={strings.firstRun.pathPlaceholder}
          data-testid="settings-project-path"
          class="mono grow"
          spellcheck="false"
        />
        <button type="submit" class="primary" data-testid="settings-project-add" disabled={projectPath.trim().length === 0}>
          {strings.firstRun.add}
        </button>
      </form>
    {:else}
      <p class="subtle hint">{strings.settings.projectsDevice}</p>
    {/if}
  </section>

  <section class="card">
    <h2>{strings.settings.background}</h2>
    <label class="switch-row">
      <span class="text">
        {strings.settings.notifications}
        <span class="hint">{strings.settings.notificationsHint}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        data-testid="setting-notifications"
        checked={store.notifications}
        onchange={(event) => void store.setNotifications(event.currentTarget.checked)}
      />
    </label>
    <!-- Both write `settings.set`, and both are about the machine the agents
         run on, which is never the device reading this. -->
    {#if store.owner}
      <label class="switch-row">
        <span class="text">
          {strings.settings.focusGuard}
          <span class="hint">{strings.settings.focusGuardHint}</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          data-testid="setting-focus-guard"
          bind:checked={focusGuard}
          onchange={() => void saveFocusGuard()}
        />
      </label>
      <label class="switch-row">
        <span class="text">
          {strings.settings.muteAgents}
          <span class="hint">{strings.settings.muteAgentsHint}</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          data-testid="setting-mute-agents"
          bind:checked={muteAgents}
          onchange={() => void saveMuteAgents()}
        />
      </label>
    {/if}
  </section>

  <section class="card">
    <h2>{strings.settings.connection}</h2>
    {#if store.endpointUrl}
      <p class="subtle hint" data-testid="settings-target">
        {store.localCore ? strings.settings.localCore : fill(strings.settings.coreAt, { url: store.endpointUrl })}
      </p>
    {/if}
    {#if store.environments.length > 0}
      <h3>{strings.settings.environments}</h3>
      <p class="subtle hint">{strings.settings.environmentsHint}</p>
      <ul class="projects" data-testid="settings-envs">
        {#each store.environments as env (env.url)}
          <li>
            <span class="name">{env.label}</span>
            <span class="mono subtle path" title={env.url}>{env.url}</span>
            {#if store.endpointUrl === env.url}
              <span class="subtle" data-testid="settings-env-current">{strings.settings.envCurrent}</span>
            {:else}
              <button
                type="button"
                data-testid="settings-env-switch"
                onclick={() => void store.switchEnvironment(env.url)}
              >
                {strings.settings.envSwitch}
              </button>
            {/if}
            <button
              type="button"
              class="ghost small"
              data-testid="settings-env-forget"
              onclick={() => void store.forgetEnvironment(env.url)}
            >
              {strings.settings.envForget}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <form class="row" onsubmit={pair} data-testid="settings-pair-form">
      <input
        bind:value={pairingLink}
        aria-label={strings.settings.pairingLink}
        placeholder={strings.settings.pairingLinkPlaceholder}
        data-testid="settings-pairing-link"
        class="mono grow"
        spellcheck="false"
        autocomplete="off"
      />
      <button type="submit" class="primary" data-testid="settings-pair" disabled={pairingLink.trim().length === 0}>
        {strings.settings.pair}
      </button>
    </form>
    <p class="subtle hint below">{strings.settings.pairHint}</p>
    {#if inShell && store.paired}
      <div class="actions">
        <button type="button" data-testid="settings-use-local" onclick={() => void store.useLocalCore()}>
          {strings.settings.useLocal}
        </button>
        <span class="subtle small-hint">{strings.settings.useLocalHint}</span>
      </div>
    {/if}
    <h3>{strings.settings.manual}</h3>
    <div class="grid">
      <label>
        <span>{strings.settings.coreUrl}</span>
        <input bind:value={url} data-testid="settings-core-url" placeholder="http://127.0.0.1:8777" class="mono" />
      </label>
      <label>
        <span>{strings.settings.token}</span>
        <input bind:value={token} type="password" autocomplete="off" />
      </label>
    </div>
    <div class="actions">
      <button type="button" class="primary" disabled={url.trim().length === 0} onclick={() => void store.connectTo(url.trim(), token)}>
        {strings.settings.connect}
      </button>
      <span class="muted">{strings.connection[store.connection]}</span>
    </div>
  </section>

  <section class="card" data-testid="pairing-card">
    <h2>{strings.settings.pairing.heading}</h2>
    {#if store.principal === 'owner'}
      <p class="subtle hint">{strings.settings.pairing.intro}</p>
      {#if store.settings && !store.settings.listenOnLan}
        <p class="subtle hint">{strings.settings.pairing.lanHint}</p>
      {/if}
      <label class="switch-row">
        <span class="text">
          {strings.settings.pairing.owner}
          <span class="hint">{strings.settings.pairing.ownerHint}</span>
        </span>
        <input type="checkbox" role="switch" data-testid="pairing-owner" bind:checked={ownerLink} />
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
    <section class="card">
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
        <label>
          <span>{strings.settings.agentCpuCapPercent}</span>
          <input type="number" min="0" max="100" bind:value={agentCpuCapPercent} />
        </label>
        <label>
          <span>{strings.settings.threadMemoryCapMb}</span>
          <input type="number" min="0" max="65536" bind:value={threadMemoryCapMb} />
        </label>
      </div>
      <label class="switch-row">
        <span class="text">
          {strings.settings.listenOnLan}
          <span class="hint">{strings.settings.listenOnLanHint}</span>
        </span>
        <input type="checkbox" role="switch" data-testid="setting-listen-on-lan" bind:checked={listenOnLan} />
      </label>
      <div class="actions">
        <button type="button" class="primary" onclick={() => void save()}>{strings.settings.save}</button>
        {#if savedAt !== null}
          <span class="muted">{strings.settings.saved} {time(savedAt)}</span>
        {/if}
      </div>
    </section>
  {/if}

  <section class="card">
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

  .hint.below {
    margin: 6px 0 0;
  }

  .small-hint {
    font-size: var(--text-sm);
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

  .grow {
    flex: 1;
    min-width: 0;
  }

  form button {
    flex: none;
  }

  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 12px;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .switch-row .text {
    color: var(--color-foreground);
    font-size: var(--text-base);
    margin: 0;
  }

  .switch-row .hint {
    display: block;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    margin-top: 2px;
  }

  .switch-row input {
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

  .switch-row input::after {
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

  .switch-row input:checked {
    background: var(--color-foreground);
  }

  .switch-row input:checked::after {
    transform: translateX(12px);
  }

  /* The track is small and round, so the ring stands off it rather than
     hugging the pill where it would read as part of the control. */
  .switch-row input:focus-visible {
    outline-offset: 3px;
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
