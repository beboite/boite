<script lang="ts">
  import { CirclePause, CirclePlay, Network, RefreshCw } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import type { CoordinationConfig, CoordinationMode } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store, threadId }: { store: Store; threadId: string } = $props();
  const fallback: CoordinationConfig = { mode: 'off', resources: '', remote: false, paused: false };
  let view = $derived(store.coordination?.self.threadId === threadId ? store.coordination : null);
  let config = $derived(view?.config ?? fallback);
  let summary = $derived(config.mode === 'brief' ? strings.coordination.summaryBrief : config.mode === 'team' ? strings.coordination.summaryTeam : strings.coordination.summaryOff);
  onMount(() => { void store.loadCoordination(threadId, false); });

  function toggleSettings(event: Event): void {
    if ((event.currentTarget as HTMLDetailsElement).open) void store.loadCoordination(threadId, true);
  }

  function configure(patch: Partial<CoordinationConfig>): void {
    if (!store.owner) return;
    void store.configureCoordination({ ...config, ...patch });
  }

  function modeLabel(mode: CoordinationMode): string {
    return strings.coordination[mode];
  }

  function modeKey(event: KeyboardEvent, mode: CoordinationMode) {
    const modes: CoordinationMode[] = ['off', 'brief', 'team'];
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (modes.indexOf(mode) + (event.key === 'ArrowLeft' ? 2 : 1)) % 3;
    const next = modes[index]!;
    configure({ mode: next });
    (event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLButtonElement>(`[data-testid="coordination-mode-${next}"]`)?.focus();
  }
</script>

<details class="coordination disclosure" data-testid="coordination-panel" ontoggle={toggleSettings}>
  <summary>
    <Network size={14} strokeWidth={1.75} />
    <span>{strings.coordination.heading}</span>
    <span class="mode" data-mode={config.mode}>{modeLabel(config.mode)}</span>
    {#if config.paused}<span class="paused">{strings.coordination.paused}</span>{/if}
  </summary>

  <div class="body">
    <p class="summary">{summary}</p>
    {#if !store.owner}<p class="notice">{strings.coordination.ownerOnly}</p>{/if}

    <div class="modes" role="radiogroup" aria-label={strings.coordination.heading}>
      {#each ['off', 'brief', 'team'] as mode (mode)}
        <button
          type="button"
          class="quiet"
          class:chosen={config.mode === mode}
          role="radio"
          aria-checked={config.mode === mode}
          disabled={!store.owner || store.coordinationSaving}
          tabindex={config.mode === mode ? 0 : -1}
          onkeydown={(event) => modeKey(event, mode as CoordinationMode)}
          data-testid="coordination-mode-{mode}"
          onclick={() => configure({ mode: mode as CoordinationMode, paused: mode === 'off' ? false : config.paused })}
        >{modeLabel(mode as CoordinationMode)}</button>
      {/each}
    </div>

    {#if config.mode !== 'off'}
      <details class="options disclosure">
        <summary>{strings.coordination.options}</summary>
      <label class="resources">
        <span>{strings.coordination.resources}</span>
        <textarea
          rows="2"
          maxlength="500"
          value={config.resources}
          placeholder={strings.coordination.resourcesPlaceholder}
          readonly={!store.owner || store.coordinationSaving}
          data-testid="coordination-resources"
          onchange={(event) => configure({ resources: event.currentTarget.value })}
        ></textarea>
      </label>

      <label class="remote-row">
        <span><strong>{strings.coordination.remote}</strong><small>{strings.coordination.remoteHint}</small></span>
        <input
          type="checkbox"
          role="switch"
          checked={config.remote}
          disabled={!store.owner || store.coordinationSaving}
          data-testid="coordination-remote"
          onchange={(event) => configure({ remote: event.currentTarget.checked })}
        />
      </label>

      <div class="budget" data-testid="coordination-budget">
        <span>{fill(strings.coordination.sends, { used: String(view?.sent ?? 0), limit: String(view?.sendLimit ?? 0) })}</span>
        <span>{fill(strings.coordination.wakes, { used: String(view?.wakes ?? 0), limit: String(view?.wakeLimit ?? 0) })}</span>
        <span>{fill(strings.coordination.receives, { limit: config.mode === 'brief' ? '20' : '100' })}</span>
      </div>

      {#if store.owner}
        <button class="quiet pause" disabled={store.coordinationSaving} data-testid="coordination-pause" onclick={() => configure({ paused: !config.paused })}>
          {#if config.paused}<CirclePlay size={14} />{strings.coordination.resume}{:else}<CirclePause size={14} />{strings.coordination.pause}{/if}
        </button>
      {/if}

      <section class="directory" aria-labelledby="coordination-directory">
        <header>
          <h3 id="coordination-directory">{strings.coordination.directory}</h3>
           <button class="ghost small" data-testid="coordination-refresh" disabled={store.coordinationLoading} onclick={() => void store.loadCoordination(threadId, true)}>
            <RefreshCw size={13} />{strings.coordination.refresh}
          </button>
        </header>
        {#if (store.coordinationDirectory?.agents.length ?? 0) === 0}
          <p class="empty">{strings.coordination.directoryEmpty}</p>
        {:else}
          <ul class="contacts">
            {#each store.coordinationDirectory?.agents ?? [] as agent (`${agent.coreId}:${agent.threadId}`)}
              <li data-testid="coordination-contact"><span><strong>{agent.title}</strong><small>{agent.machine} · {agent.resources || modeLabel(agent.mode)}</small></span><span class="contact-status">{agent.status}</span></li>
            {/each}
          </ul>
        {/if}
        {#if (store.coordinationDirectory?.unavailable.length ?? 0) > 0}
          <div class="warnings" role="status">
            <strong>{strings.coordination.unavailable}</strong>
            {#each store.coordinationDirectory?.unavailable ?? [] as warning (warning)}<p>{warning}</p>{/each}
          </div>
        {/if}
      </section>
      </details>
    {/if}

    {#if store.coordinationError}<p class="error" role="alert">{store.coordinationError}</p>{/if}
  </div>
</details>

<style>
  .coordination { flex: none; margin: 8px auto 0; width: min(calc(100% - 40px), var(--content)); border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
  .coordination > summary { min-height: var(--control-lg); width: 100%; padding: 0 12px; display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: var(--text-sm); font-weight: 600; color: var(--color-foreground); border-radius: var(--radius-lg); }
  .coordination > summary:hover { background: var(--color-hover); }
  .mode, .paused { padding: 2px 6px; border-radius: var(--radius-sm); background: var(--color-surface-3); color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 500; }
  .mode { margin-left: auto; }
  .body { padding: 0 14px 14px; border-top: 1px solid var(--color-border); max-height: min(48dvh, 480px); overflow-y: auto; overscroll-behavior: contain; }
  .summary, .empty, .notice { margin: 10px 0; color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.45; }
  .notice { padding: 8px 10px; border-left: 2px solid var(--color-edge); background: var(--color-surface-2); }
  .modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 3px; border-radius: var(--radius-md); background: var(--color-surface-2); }
  .modes button { width: 100%; }
  .modes .chosen { background: var(--color-active); color: var(--color-foreground); box-shadow: inset 0 0 0 1px var(--color-edge); }
  .resources { display: grid; gap: 6px; margin-top: 12px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .options { margin-top: 8px; }
  .options > summary { cursor: pointer; padding: 8px 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  textarea { width: 100%; resize: vertical; }
  .remote-row { display: flex; align-items: center; gap: 16px; margin-top: 12px; }
  .remote-row > span { flex: 1; min-width: 0; }
  .remote-row strong, .remote-row small { display: block; }
  .remote-row strong { font-size: var(--text-sm); font-weight: 500; }
  .remote-row small { margin-top: 2px; color: var(--color-muted-foreground); line-height: 1.4; }
  .budget { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 12px; color: var(--color-muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .pause { margin-top: 8px; padding-left: 0; }
  section { margin-top: 16px; }
  section header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h3 { margin: 0; font-size: var(--text-sm); }
  .contacts { list-style: none; margin: 8px 0 0; padding: 0; border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; }
  .contacts li { min-height: var(--control-lg); padding: 7px 10px; display: flex; align-items: center; gap: 12px; }
  .contacts li + li { border-top: 1px solid var(--color-border); }
  .contacts li > span:first-child { flex: 1; min-width: 0; }
  .contacts strong, .contacts small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .contacts strong { font-size: var(--text-sm); font-weight: 500; }
  .contacts small, .contact-status { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .warnings { margin-top: 8px; padding: 8px 10px; border-left: 2px solid var(--color-live); background: var(--color-surface-2); font-size: var(--text-sm); }
  .warnings p { margin-top: 4px; }
  .error { margin-top: 10px; color: var(--color-danger); font-size: var(--text-sm); }
  @media (max-width: 720px) {
    .coordination { width: calc(100% - 20px); margin-top: 6px; }
    .body { padding: 0 10px 12px; }
  }
</style>
