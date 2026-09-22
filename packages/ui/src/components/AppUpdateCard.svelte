<script lang="ts">
  import Prose from './Prose.svelte';
  import { appUpdater, type AppUpdater, type UpdateChannel } from '../lib/app-update.svelte';
  import { appUpdateInstall } from '../lib/app-update-install.svelte';
  import { bytes, time } from '../lib/format';
  import { fill, strings } from '../lib/strings';

  let { updater = appUpdater }: { updater?: AppUpdater } = $props();
  let update = $derived(updater.snapshot);
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

<section class="card update-card" id="settings-app-update" data-testid="app-update-card">
  <h2>{strings.appUpdate.heading}</h2>
  {#if !update.supported}
    <p class="hint">{strings.appUpdate.unsupported}</p>
  {:else}
    <p class="hint">{strings.appUpdate.intro}</p>

    <div class="channel-row">
      <span class="label">{strings.appUpdate.channel}</span>
      <div class="segmented" role="group" aria-label={strings.appUpdate.channel}>
        <button
          type="button"
          class:on={update.channel === 'stable'}
          aria-pressed={update.channel === 'stable'}
          disabled={update.phase === 'installing'}
          onclick={() => choose('stable')}
          data-testid="app-update-stable"
        >{strings.appUpdate.stable}</button>
        <button
          type="button"
          class:on={update.channel === 'nightly'}
          aria-pressed={update.channel === 'nightly'}
          disabled={update.phase === 'installing'}
          onclick={() => choose('nightly')}
          data-testid="app-update-nightly"
        >{strings.appUpdate.nightly}</button>
      </div>
    </div>

    {#if update.channel === 'nightly'}
      <p class="nightly">{strings.appUpdate.nightlyHint}</p>
    {/if}

    <dl>
      <dt>{strings.appUpdate.installedVersion}</dt>
      <dd class="mono">{update.currentVersion}</dd>
      <dt>{strings.appUpdate.installedChannel}</dt>
      <dd>{update.currentChannel === 'stable' ? strings.appUpdate.stable : strings.appUpdate.nightly}</dd>
      {#if update.version}
        <dt>{strings.appUpdate.targetVersion}</dt>
        <dd class="mono">{update.version}</dd>
      {/if}
      {#if update.publishedAt}
        <dt>{strings.appUpdate.published}</dt>
        <dd>{new Date(update.publishedAt).toLocaleDateString()}</dd>
      {/if}
    </dl>

    <div class="status" class:error={update.phase === 'error'} role="status" aria-live="polite" data-testid="app-update-status">
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

    {#if update.notes}
      <div class="notes">
        <h3>{strings.appUpdate.notes}</h3>
        <Prose text={update.notes} />
      </div>
    {/if}

    <p class="retained">{strings.appUpdate.retained}</p>

    <div class="actions">
      {#if update.phase === 'ready'}
        <button type="button" class="primary" disabled={appUpdateInstall.preparing} onclick={() => void appUpdateInstall.request(updater)} data-testid="app-update-install">
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
      {:else if !updater.busy}
        <button type="button" onclick={() => updater.check(update.channel)} data-testid="app-update-check">
          {strings.appUpdate.check}
        </button>
      {/if}
    </div>
  {/if}
</section>

<style>
  .channel-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
  }

  .label { font-weight: 500; }

  .segmented {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
  }

  .segmented button {
    height: var(--control-sm);
    padding: 0 10px;
    border-color: transparent;
    background: transparent;
    color: var(--color-muted-foreground);
  }

  .segmented button.on {
    background: var(--color-foreground);
    border-color: var(--color-foreground);
    color: var(--color-background);
  }

  .nightly,
  .retained {
    margin: 10px 0 0;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  dl {
    display: grid;
    grid-template-columns: 150px 1fr;
    gap: 5px 12px;
    margin: 18px 0 0;
  }

  dt { color: var(--color-muted-foreground); }
  dd { margin: 0; }

  .status {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-top: 18px;
    font-size: var(--text-sm);
  }

  .status.error { color: var(--color-danger); }
  .status .subtle { color: var(--color-subtle); }

  .track {
    height: 3px;
    margin-top: 8px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--color-surface-3);
  }

  .track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--color-foreground);
    transition: width var(--dur-2) var(--ease-out-quint);
  }

  .track.indeterminate span { opacity: 0.4; }

  .notes {
    margin-top: 18px;
    padding: 12px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
  }

  .notes h3 {
    margin: 0 0 8px;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }

  @media (max-width: 540px) {
    .channel-row { align-items: flex-start; flex-direction: column; gap: 8px; }
    dl { grid-template-columns: 1fr; gap: 2px; }
    dd + dt { margin-top: 8px; }
    .status { flex-direction: column; gap: 4px; }
  }
</style>
