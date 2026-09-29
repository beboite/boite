<script lang="ts">
  import { ExternalLink, RefreshCw } from '@lucide/svelte';
  import { appUpdater, type AppUpdater, type UpdateChannel } from '../lib/app-update.svelte';
  import { appUpdateInstall } from '../lib/app-update-install.svelte';
  import { bytes, time } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import { formatLocale } from '../lib/i18n.svelte';
  import { releaseAge } from '../lib/release-age';

  let { beforeInstall, updater = appUpdater }: { beforeInstall: () => void; updater?: AppUpdater } = $props();
  const openedAt = Date.now();
  let update = $derived(updater.snapshot);
  let age = $derived(releaseAge(update.publishedAt, openedAt, formatLocale()));
  let progress = $derived(update.total && update.total > 0 ? Math.min(100, (update.received / update.total) * 100) : null);

  function choose(channel: UpdateChannel): void {
    if (channel === update.channel && update.phase !== 'error' && update.phase !== 'idle' && update.phase !== 'current') return;
    updater.check(channel);
  }

  function phaseText(): string {
    switch (update.phase) {
      case 'checking': return strings.appUpdate.checking;
      case 'available': return fill(strings.appUpdate.available, { version: update.version ?? '' });
      case 'downloading':
        return update.total === null
          ? fill(strings.appUpdate.downloaded, { received: bytes(update.received) })
          : fill(strings.appUpdate.downloading, { received: bytes(update.received), total: bytes(update.total) });
      case 'ready': return fill(strings.appUpdate.ready, { version: update.version ?? '' });
      case 'installing': return strings.appUpdate.installing;
      case 'current': return strings.appUpdate.current;
      case 'error': return update.error ?? strings.appUpdate.failed;
      default: return strings.appUpdate.idle;
    }
  }
</script>

<div class="update-content" data-testid="app-update-content">
  {#if !update.supported}
    <p class="hint">{strings.appUpdate.unsupported}</p>
  {:else}
    {#if update.version}
      <h3>{update.channel === 'nightly' ? strings.appUpdate.nightly : strings.appUpdate.stable} {update.version}</h3>
      {#if age}<p class="published" data-testid="app-update-published">{fill(strings.appUpdate.released, { time: age })}</p>{/if}
      <a class="changelog" href={`https://github.com/beboite/boite/releases/tag/v${encodeURIComponent(update.version)}`} target="_blank" rel="noopener noreferrer" data-testid="app-update-changelog">{strings.appUpdate.changelog}<ExternalLink size={13} /></a>
    {/if}

    <div class="status" class:ready={update.phase === 'ready'} class:error={update.phase === 'error'} role="status" aria-live="polite" data-testid="app-update-status">
      <span>{phaseText()}</span>
      {#if updater.lastCheckedAt !== null}
        <span class="subtle">{fill(strings.appUpdate.lastChecked, { time: time(updater.lastCheckedAt) })}</span>
      {/if}
    </div>

    {#if update.phase === 'downloading'}
      <div
        class="track"
        class:indeterminate={progress === null}
        role="progressbar"
        aria-label={strings.appUpdate.progress}
        aria-valuemin={progress === null ? undefined : 0}
        aria-valuemax={progress === null ? undefined : 100}
        aria-valuenow={progress === null ? undefined : Math.round(progress)}
      >
        <span style:width={progress === null ? '40%' : `${progress}%`}></span>
      </div>
    {/if}

    <div class="actions">
      {#if update.phase === 'ready'}
        <button type="button" class="primary" disabled={appUpdateInstall.preparing} onclick={() => { beforeInstall(); void appUpdateInstall.request(updater); }} data-testid="app-update-install">
          {strings.appUpdate.install}
        </button>
      {:else if update.phase === 'available'}
        <button type="button" onclick={() => updater.download()} data-testid="app-update-download">
          {strings.appUpdate.download}
        </button>
      {:else if update.phase === 'error'}
        <button type="button" onclick={() => updater.check(update.channel)} data-testid="app-update-retry">
          {strings.appUpdate.retry}
        </button>
      {:else if update.phase !== 'downloading' && update.phase !== 'installing'}
        <!-- Keep the running check visible and disabled. -->
        <button
          type="button"
          disabled={update.phase === 'checking'}
          aria-busy={update.phase === 'checking'}
          onclick={() => updater.check(update.channel)}
          data-testid="app-update-check"
        >
          <RefreshCw size={13} class={update.phase === 'checking' ? 'spinning' : undefined} />
          {update.phase === 'checking' ? strings.appUpdate.checkingAction : strings.appUpdate.check}
        </button>
      {/if}
    </div>
    <details class="options">
      <summary>{strings.appUpdate.channel}<span>{update.channel === 'nightly' ? strings.appUpdate.nightly : strings.appUpdate.stable}</span></summary>
      <div class="segmented" role="group" aria-label={strings.appUpdate.channel}>
        {#each ['stable', 'nightly'] as const as channel (channel)}
          <button type="button" class:on={update.channel === channel} aria-pressed={update.channel === channel}
            disabled={update.phase === 'installing'} onclick={() => choose(channel)} data-testid={`app-update-${channel}`}>
            {channel === 'nightly' ? strings.appUpdate.nightly : strings.appUpdate.stable}
          </button>
        {/each}
      </div>
      {#if update.channel === 'nightly'}<p class="hint">{strings.appUpdate.nightlyHint}</p>{/if}
      <p class="hint">{strings.appUpdate.installedVersion}: {update.currentChannel === 'nightly' ? strings.appUpdate.nightly : strings.appUpdate.stable} {update.currentVersion}</p>
      <p class="hint">{strings.appUpdate.retained}</p>
    </details>
  {/if}
</div>

<style>
  .update-content { padding: 14px; font-size: var(--text-sm); }
  h3 { margin: 0; font-size: var(--text-base); font-weight: 600; overflow-wrap: anywhere; }
  .published { margin: 3px 0 12px; color: var(--color-muted-foreground); }
  .changelog { display: inline-flex; align-items: center; gap: 6px; color: var(--color-muted-foreground); text-decoration: none; }
  .changelog:hover { color: var(--color-foreground); text-decoration: underline; }
  .status { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  .status.ready { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .status.error { color: var(--color-danger); }
  .subtle { color: var(--color-subtle); font-size: var(--text-xs); }
  .actions { display: flex; margin-top: 14px; }
  .actions button { width: 100%; }
  .options { margin-top: 14px; border-top: 1px solid var(--color-border); padding-top: 10px; }
  summary { cursor: pointer; color: var(--color-muted-foreground); }
  summary span { float: right; }
  .segmented { display: flex; gap: 2px; padding: 2px; margin-top: 10px; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .segmented button { flex: 1; height: var(--control-sm); border-color: transparent; background: transparent; color: var(--color-muted-foreground); }
  .segmented button.on { background: var(--color-foreground); color: var(--color-background); }
  .hint { margin: 10px 0 0; color: var(--color-muted-foreground); line-height: 1.5; }
  .track { height: 3px; margin-top: 8px; overflow: hidden; border-radius: var(--radius-sm); background: var(--color-surface-3); }
  .track span { display: block; height: 100%; border-radius: inherit; background: var(--color-foreground); transition: width var(--dur-2) var(--ease-out-quint); }
  .track.indeterminate span { opacity: 0.4; }
  .actions :global(.spinning) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .actions :global(.spinning) { animation: none; } }
  :global(html[data-motion='reduced']) .actions :global(.spinning) { animation: none; }
</style>

