<script lang="ts">
  import { ArrowRight, CircleArrowDown, ExternalLink, RefreshCw } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { bytes, time } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  let { store, label }: { store: Store; label: string } = $props();
  const updater = $derived(store.serverUpdater);
  let state = $derived(updater.snapshot);
  let active = $derived(!!state && ['downloading', 'waiting', 'installing'].includes(state.phase));
  let progress = $derived(state?.total ? Math.min(100, 100 * state.received / state.total) : null);
  let connected = $derived(store.connection === 'ready');
  let checked = $derived(state?.checkedAt ? fill(strings.appUpdate.lastChecked, { time: time(state.checkedAt) }) : undefined);
  $effect(() => { if (connected && store.owner && !state && !updater.legacy && !updater.busy && !updater.error) void updater.load(); });
  function phaseText(): string {
    switch (state?.phase) {
      case 'checking': return strings.appUpdate.checking;
      case 'available': return fill(strings.appUpdate.available, { version: state.version ?? '' });
      case 'downloading': return state.total ? fill(strings.appUpdate.downloading, { received: bytes(state.received), total: bytes(state.total) }) : fill(strings.appUpdate.downloaded, { received: bytes(state.received) });
      case 'waiting': return strings.serverUpdate.waiting;
      case 'installing': return connected ? strings.serverUpdate.installing : strings.serverUpdate.reconnecting;
      case 'current': return strings.serverUpdate.current;
      case 'error': return state.error ?? strings.appUpdate.failed;
      default: return strings.appUpdate.idle;
    }
  }
</script>

<div class="server-update" data-testid="server-update-card">
  <div class="update-row">
    <div class="version">
      <span>{strings.serverUpdate.heading}</span>
      <span class="number">{state?.currentVersion ?? store.core?.version ?? ''}</span>
      {#if state?.version && updater.offered}<span class="next"><ArrowRight size={12} aria-hidden="true" /><span class="number target" data-testid="server-update-target">{state.version}</span></span>{/if}
    </div>
    {#if store.owner}
      {#if state?.mode === 'systemd' && updater.offered && !active}
        <button class="primary small" disabled={!connected || updater.busy || updater.preparing} onclick={() => void updater.install(label)} data-testid="server-update-install"><CircleArrowDown size={14} />{strings.appUpdate.readyAction}</button>
      {:else if active && state?.phase !== 'installing'}
        <button class="small" disabled={!connected || updater.busy} onclick={() => void updater.cancel()} data-testid="server-update-cancel">{strings.common.cancel}</button>
      {:else if state?.mode === 'systemd' && !active}
        <button class="ghost small check" title={checked} disabled={!connected || updater.busy || state.phase === 'checking'} onclick={() => void updater.load(true)} data-testid="server-update-check"><RefreshCw size={13} class={updater.busy || state.phase === 'checking' ? 'spinning' : undefined} />{updater.busy || state.phase === 'checking' ? strings.appUpdate.checkingAction : strings.appUpdate.check}</button>
      {/if}
    {/if}
  </div>
  {#if state?.mode === 'systemd'}
    <p class="status" class:offer={state.phase === 'available'} class:error={state.phase === 'error'} role="status" aria-live="polite" data-testid="server-update-status">{phaseText()}</p>
    {#if state.phase === 'downloading'}
      <div class="track" role="progressbar" aria-label={strings.serverUpdate.progress}
        aria-valuemin={progress === null ? undefined : 0} aria-valuemax={progress === null ? undefined : 100} aria-valuenow={progress === null ? undefined : Math.round(progress)}>
        <span style:width={progress === null ? '40%' : `${progress}%`}></span>
      </div>
    {/if}
    {#if state.version && updater.offered}
      <div class="metadata">
        <a class="release" href={`https://github.com/beboite/boite/releases/tag/v${encodeURIComponent(state.version)}`} target="_blank" rel="noopener noreferrer">{strings.serverUpdate.release}<ExternalLink size={12} /></a>
        <details class="update-details" data-testid="server-update-details">
          <summary data-testid="server-update-details-toggle">{strings.serverUpdate.details}</summary>
          <p>{strings.serverUpdate.timing}</p>
          <p>{strings.serverUpdate.backup}</p>
          <p>{strings.serverUpdate.reconnect}</p>
          {#if checked}<p class="checked">{checked}</p>{/if}
        </details>
      </div>
    {/if}
  {:else if store.owner && (state || updater.legacy)}
    <details class="disclosure">
      <summary>{strings.serverUpdate.manualTitle}</summary>
      <p>{updater.legacy ? strings.serverUpdate.legacy : state?.mode === 'docker' ? strings.serverUpdate.docker : strings.serverUpdate.manual}</p>
      {#if state?.mode === 'docker'}<code>docker compose pull &amp;&amp; docker compose up -d</code>{/if}
      <a class="release" href="https://github.com/beboite/boite/blob/main/docs/server.md" target="_blank" rel="noopener noreferrer">{strings.serverUpdate.guide}<ExternalLink size={12} /></a>
    </details>
  {/if}
  {#if updater.error}<p class="error" role="alert">{updater.error}</p><button class="ghost small" disabled={!connected || updater.busy} onclick={() => void updater.load()}>{strings.appUpdate.retry}</button>{/if}
</div>

<style>
  .server-update { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--color-border); font-size: var(--text-sm); }
  .update-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .version { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; flex: 1; }
  .number { min-width: 0; color: var(--color-muted-foreground); overflow-wrap: anywhere; font-size: var(--text-xs); }
  .next { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
  .next :global(svg) { flex: none; }
  .target { color: var(--color-foreground); }
  .status, .checked { margin: 8px 0 0; color: var(--color-muted-foreground); line-height: 1.5; overflow-wrap: anywhere; }
  .status.offer { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .checked { font-size: var(--text-xs); color: var(--color-subtle); }
  .release { display: inline-flex; align-items: center; gap: 5px; margin-top: 8px; color: var(--color-muted-foreground); text-decoration: none; }
  .release:hover { color: var(--color-foreground); text-decoration: underline; }
  .metadata { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 8px; }
  .metadata .release, .metadata details { margin-top: 0; }
  .update-details[open] { flex-basis: 100%; }
  .check { flex: none; }
  .update-row button { flex: none; }
  .error { color: var(--color-danger); overflow-wrap: anywhere; }
  .track { height: 3px; margin-top: 8px; border-radius: var(--radius-sm); overflow: hidden; background: var(--color-surface-3); }
  .track span { display: block; height: 100%; background: var(--color-foreground); }
  details { margin-top: 8px; color: var(--color-muted-foreground); }
  details p { line-height: 1.5; }
  summary { cursor: pointer; }
  code { display: block; overflow-wrap: anywhere; }
  :global(.spinning) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 720px) {
    .update-row { flex-wrap: wrap; }
    button, .metadata .release { min-height: var(--touch-target); }
    summary { min-height: var(--touch-target); line-height: var(--touch-target); }
  }
  @media (prefers-reduced-motion: reduce) { :global(.spinning) { animation: none; } }
</style>
