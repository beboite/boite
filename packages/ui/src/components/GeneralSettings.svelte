<script lang="ts">
  import { untrack } from 'svelte';
  import { time } from '../lib/format';
  import { readStoredEndpoint } from '../lib/endpoint';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { readTheme, setTheme, type Theme } from '../lib/theme';

  let { store }: { store: Store } = $props();

  const themes: { id: Theme; label: string }[] = [
    { id: 'system', label: strings.settings.themeSystem },
    { id: 'dark', label: strings.settings.themeDark },
    { id: 'light', label: strings.settings.themeLight }
  ];
  let theme = $state<Theme>(untrack(() => readTheme()));

  function pickTheme(next: Theme) {
    theme = next;
    setTheme(next);
  }

  const stored = readStoredEndpoint();
  const inShell = window.__TAURI_INTERNALS__ !== undefined;

  let url = $state(
    untrack(() => stored?.url ?? store.core?.pairingUrl.split('?')[0]?.replace(/\/+$/, '') ?? '')
  );
  let token = $state(stored?.token ?? '');

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
      <p class="subtle hint">{strings.settings.projectsHint}</p>
    {/if}
    <form class="row" onsubmit={addProject} data-testid="settings-add-project">
      {#if inShell}
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
  </section>

  <section class="card">
    <h2>{strings.settings.appearance}</h2>
    <div class="switch-row">
      <span class="text">{strings.settings.theme}</span>
      <div class="segmented" role="group" aria-label={strings.settings.theme}>
        {#each themes as option (option.id)}
          <button
            type="button"
            class:on={theme === option.id}
            aria-pressed={theme === option.id}
            data-testid="theme-{option.id}"
            onclick={() => pickTheme(option.id)}
          >
            {option.label}
          </button>
        {/each}
      </div>
    </div>
  </section>

  <section class="card">
    <h2>{strings.settings.background}</h2>
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
  </section>

  <section class="card">
    <h2>{strings.settings.connection}</h2>
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
        <dt>{strings.settings.pairingUrl}</dt>
        <dd class="mono wrap">{store.core.pairingUrl}</dd>
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
    font-size: var(--text-xs);
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
    font-size: var(--text-xs);
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
    font-size: var(--text-xs);
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

  /* Three buttons in one track, the chosen one filled like a primary button. */
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
    height: 24px;
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
    font-size: var(--text-xs);
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
</style>
