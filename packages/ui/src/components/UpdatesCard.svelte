<script lang="ts">
  import { lockedBy } from '../lib/policy';
  import { ArrowRight, CircleArrowDown, ExternalLink, RefreshCw, RotateCw } from '@lucide/svelte';
  import { appUpdater, showAppUpdateUi, type AppUpdater, type UpdateChannel } from '../lib/app-update.svelte';
  import { appUpdateInstall } from '../lib/app-update-install.svelte';
  import { updateEverything, type PartState } from '../lib/update-everything.svelte';
  import { listedName, workspace } from '../lib/workspace.svelte';
  import { bytes, time } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';
  import PolicyLock from './PolicyLock.svelte';

  /**
   * Boite's updates in one card, nothing folded: the version this app runs
   * and the one found, the channel it follows, one button to look and one to
   * update. What the other machines have pending, Boite there and its agents,
   * is listed under it and goes with the same button.
   */

  /** The desktop app's updater; `native` is false in a browser, which has none. */
  let { updater = appUpdater, native = showAppUpdateUi() }: { updater?: AppUpdater; native?: boolean } = $props();

  /** No stable release is published yet: the channel opens with the first one. */
  const RELEASE_PUBLISHED = false;

  const uid = $props.id();
  let checking = $state(false);
  const app = $derived(native ? updater.snapshot : null);
  const supported = $derived(app?.supported === true);
  /** In a browser, Boite is the machine the page shows. */
  const current = $derived(supported ? app!.currentVersion : workspace.active.core?.version ?? '');
  const found = $derived(supported && app!.version && ['available', 'downloading', 'ready', 'waiting', 'installing', 'error'].includes(app!.phase) ? app!.version : null);
  const progress = $derived(app?.phase === 'downloading' && app.total ? Math.min(100, (app.received / app.total) * 100) : null);
  /** What the other machines would update, and this computer's agents. */
  const others = $derived(updateEverything.plan.flatMap((machine) => machine.parts
    .filter((part) => !(machine.local && part.id === 'app'))
    .map((part) => ({ id: machine.id, machine: workspace.machines.find((entry) => entry.id === machine.id), label: machine.label, part }))));
  /** A server's own refusal (a cancel, a release it would not take): said under the list, not lost. */
  const failures = $derived(workspace.machines.filter((machine) => machine.store.owner && !machine.store.localCore && machine.store.serverUpdater.error));
  const othersStartable = $derived(others.some(({ part }) => part.startable));
  /** A release downloaded and nothing else to start: the button restarts into it. */
  const restarts = $derived(app?.phase === 'ready' && !othersStartable);
  const busy = $derived(updateEverything.running || appUpdateInstall.preparing || ['downloading', 'installing'].includes(app?.phase ?? ''));
  const appStartable = $derived(supported && ['available', 'ready', 'error'].includes(app!.phase) && app!.version !== null);
  const canUpdate = $derived(!busy && (restarts ? !updateEverything.localBusy : appStartable || othersStartable));
  const connected = $derived(workspace.machines.some((machine) => machine.store.connection === 'ready'));
  /** The core this window's shell started: `autoInstallUpdates` is its setting. */
  const local = $derived(workspace.machines.find((machine) => machine.store.localCore)?.store);
  const autoShown = $derived(supported && local?.owner === true && local.settings !== null && local.settings !== undefined);
  /** The admin policy of this computer decides the app's updates: `off` checks nothing, any value holds the automatic install. */
  const appPolicy = $derived(lockedBy(local?.policy, 'updates.app') ? local?.policy?.values.updates?.app ?? null : null);

  async function toggleAuto(input: HTMLInputElement) {
    if (!local || !await local.saveSettings({ autoInstallUpdates: input.checked })) input.checked = local?.settings?.autoInstallUpdates === true;
  }

  function status(): string {
    if (!app) return strings.serverUpdate.current;
    if (!app.supported) return strings.appUpdate.unsupported;
    switch (app.phase) {
      case 'checking': return strings.appUpdate.checking;
      case 'available': return strings.harnessUpdates.availableShort;
      case 'downloading':
        return app.total === null
          ? fill(strings.appUpdate.downloaded, { received: bytes(app.received) })
          : fill(strings.appUpdate.downloading, { received: bytes(app.received), total: bytes(app.total) });
      case 'ready': return strings.updateAll.ready;
      case 'waiting': return strings.appUpdate.waiting;
      case 'installing': return strings.appUpdate.installing;
      case 'current': return strings.serverUpdate.current;
      case 'error': return app.error ?? strings.appUpdate.failed;
      default: return strings.appUpdate.idle;
    }
  }

  function partState(state: PartState, percent: number | null, message: string | null): string | null {
    switch (state) {
      case 'downloading': return strings.updateAll.downloading(percent);
      case 'ready': return strings.updateAll.restartsNext;
      case 'waiting': return strings.updateAll.waiting;
      case 'installing': return strings.updateAll.installing;
      case 'updating': return strings.updateAll.updating;
      case 'failed': return message ?? strings.updateAll.failed;
      default: return null;
    }
  }

  /** One button for everything that updates: this app, Boite on each machine and the agents there. */
  async function check() {
    if (checking) return;
    checking = true;
    try {
      if (supported && appPolicy !== 'off') updater.check();
      await Promise.all(workspace.machines.filter((machine) => machine.store.connection === 'ready' && machine.store.owner).flatMap((machine) => [
        machine.store.loadHarnessUpdates(true),
        ...(machine.store.localCore ? [] : [machine.store.serverUpdater.load(true), machine.store.serverUpdater.loadDesktop()])
      ]));
    } finally {
      checking = false;
    }
  }

  function update() {
    if (restarts) void appUpdateInstall.request(updater);
    else void updateEverything.run();
  }

  function choose(channel: UpdateChannel): void {
    if (!app || channel === app.channel) return;
    updater.check(channel);
  }
</script>

<section class="card updates" id="settings-updates" data-testid="app-updates-card" aria-label={strings.appUpdate.updates}>
  <div class="line">
    <p class="version" data-testid="updates-version">
      <span class="name">Boite</span>
      <span class="number">{current}</span>
      {#if found}<ArrowRight size={13} aria-hidden="true" /><span class="number target" data-testid="updates-found">{found}</span>{/if}
    </p>
    {#if supported}
      <div class="channel" role="group" aria-label={strings.appUpdate.channel}>
        <button type="button" class:on={app!.channel === 'nightly'} aria-pressed={app!.channel === 'nightly'} data-testid="app-update-nightly"
          disabled={app!.phase === 'waiting' || app!.phase === 'installing'} onclick={() => choose('nightly')}><span class="ui-label">{strings.appUpdate.nightlyShort}</span></button>
        <button type="button" class:on={app!.channel === 'stable'} aria-pressed={app!.channel === 'stable'} data-testid="app-update-stable"
          disabled={!RELEASE_PUBLISHED || app!.phase === 'waiting' || app!.phase === 'installing'} title={RELEASE_PUBLISHED ? undefined : strings.appUpdate.noRelease}
          onclick={() => choose('stable')}><span class="ui-label">{strings.appUpdate.releaseShort}</span></button>
      </div>
    {/if}
  </div>
  <div class="line">
    <p class="status" class:offer={app?.phase === 'available' || app?.phase === 'ready'} class:error={app?.phase === 'error'} role="status" aria-live="polite" data-testid="app-update-status">
      <span>{status()}</span>
      {#if appPolicy === 'off'}<PolicyLock store={local!} keys={['updates.app']} />{/if}
      {#if supported && updater.lastCheckedAt !== null && app!.phase !== 'checking'}<span class="subtle">{fill(strings.appUpdate.lastChecked, { time: time(updater.lastCheckedAt) })}</span>{/if}
      {#if found}<a class="changelog" href={`https://github.com/mtsu-dev/boite/releases/tag/v${encodeURIComponent(found)}`} target="_blank" rel="noopener noreferrer" data-testid="app-update-changelog"><span class="ui-label">{strings.appUpdate.changelog}</span><ExternalLink size={12} /></a>{/if}
    </p>
    <div class="actions">
      <button type="button" class="small" data-testid="updates-check-all" disabled={checking || app?.phase === 'checking' || (!connected && !supported)} aria-busy={checking || app?.phase === 'checking'} onclick={() => void check()}>
        <RefreshCw size={13} class={checking || app?.phase === 'checking' ? 'spinning' : undefined} /><span class="ui-label">{checking || app?.phase === 'checking' ? strings.appUpdate.checkingAction : strings.appUpdate.check}</span>
      </button>
      {#if app?.phase === 'waiting'}
        <button type="button" class="small" data-testid="app-update-cancel" disabled={updater.cancelling} aria-busy={updater.cancelling} onclick={() => void updater.cancelInstall()}>
          <span class="ui-label">{strings.common.cancel}</span>
        </button>
      {:else}
        <button type="button" class="primary small" data-testid="updates-run-all" disabled={!canUpdate} aria-busy={busy} onclick={update}>
          {#if restarts}<RotateCw size={13} />{:else}<CircleArrowDown size={13} />{/if}
          <span class="ui-label">{busy ? strings.updateAll.busy : restarts ? strings.updateAll.restart : strings.appUpdate.readyAction}</span>
        </button>
      {/if}
    </div>
  </div>
  {#if app?.phase === 'downloading'}
    <div class="track" class:indeterminate={progress === null} role="progressbar" aria-label={strings.appUpdate.progress}
      aria-valuemin={progress === null ? undefined : 0} aria-valuemax={progress === null ? undefined : 100} aria-valuenow={progress === null ? undefined : Math.round(progress)}>
      <span style:width={progress === null ? '40%' : `${progress}%`}></span>
    </div>
  {/if}
  {#if autoShown}
    <label class="auto" for="{uid}-auto-install" data-testid="app-update-auto">
      <span class="ui-label-box"><span class="ui-label">{strings.appUpdate.autoInstall}</span><InfoTip topic={strings.appUpdate.autoInstall} text={strings.appUpdate.autoInstallHint} /><PolicyLock store={local!} keys={['updates.app']} /></span>
      <input id="{uid}-auto-install" type="checkbox" role="switch" data-testid="app-update-auto-switch"
        checked={local!.settings?.autoInstallUpdates === true} disabled={local!.connection !== 'ready' || appPolicy !== null}
        onchange={(event) => void toggleAuto(event.currentTarget)} />
    </label>
  {/if}
  {#each failures as machine (machine.id)}
    <p class="failure" role="alert" data-testid="updates-failure">
      <span>{listedName(machine)}: {machine.store.serverUpdater.error}</span>
      <button type="button" class="ghost small" disabled={machine.store.connection !== 'ready' || machine.store.serverUpdater.busy} onclick={() => void machine.store.serverUpdater.load()}><span class="ui-label">{strings.common.retry}</span></button>
    </p>
  {/each}
  {#if others.length > 0}
    <ul class="others" data-testid="updates-others">
      {#each others as { id, machine, label, part } (`${id}/${part.id}`)}
        {@const note = partState(part.state, part.percent, part.message)}
        <li data-testid="updates-other" data-part={part.id}>
          <span class="where">{machine ? listedName(machine) : label}</span>
          <span class="what">{part.name}</span>
          <span class="number">{part.from ?? ''}</span>
          <ArrowRight size={12} aria-hidden="true" />
          <span class="number target">{part.version}</span>
          {#if note}<span class="note" class:error={part.state === 'failed'}>{note}</span>{/if}
          <!-- A server still downloading or waiting for its agents can be told not to. -->
          {#if part.id === 'boite' && machine?.store.owner && (part.state === 'downloading' || part.state === 'waiting')}
            <button type="button" class="ghost small cancel" data-testid="server-update-cancel" disabled={machine.store.connection !== 'ready' || machine.store.serverUpdater.busy}
              onclick={() => void machine.store.serverUpdater.cancel()}><span class="ui-label">{strings.common.cancel}</span></button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .updates { display: grid; gap: 10px; padding: 16px 20px; }
  .line { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; min-width: 0; }
  p { margin: 0; }
  .version { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; color: var(--color-muted-foreground); }
  .name { color: var(--color-foreground); font-weight: 600; font-size: var(--text-md); }
  .number { font-family: var(--font-mono); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .target { color: var(--color-accent); }
  .status { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; min-width: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .status.offer > span:first-child { color: var(--color-accent); }
  .status.error { color: var(--color-danger); }
  .subtle { color: var(--color-subtle); font-size: var(--text-xs); }
  .changelog { display: inline-flex; align-items: center; gap: 5px; color: var(--color-muted-foreground); text-decoration: none; }
  .changelog:hover { color: var(--color-foreground); text-decoration: underline; }
  .actions { display: flex; flex: none; gap: 6px; }
  .channel { display: flex; flex: none; gap: 2px; padding: 2px; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .channel button { height: var(--control-sm); padding: 0 12px; border-color: transparent; background: transparent; color: var(--color-muted-foreground); }
  .channel button.on { background: var(--color-active); color: var(--color-foreground); }
  .channel button:disabled:not(.on) { opacity: 0.45; }
  .track { height: 3px; overflow: hidden; border-radius: var(--radius-sm); background: var(--color-surface-3); }
  .track span { display: block; height: 100%; border-radius: inherit; background: var(--color-accent); transition: width var(--dur-2) var(--ease-out-quint); }
  .track.indeterminate span { opacity: 0.4; }
  .others { list-style: none; margin: 4px 0 0; padding: 10px 0 0; border-top: 1px solid var(--color-border); display: grid; gap: 6px; font-size: var(--text-sm); }
  .others li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; color: var(--color-muted-foreground); }
  .others :global(svg) { flex: none; }
  .where { color: var(--color-foreground); font-weight: 500; }
  .note { color: var(--color-subtle); font-size: var(--text-xs); }
  .auto { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .auto > span { display: inline-flex; align-items: center; }
  .auto input { flex: 0 0 40px; width: 40px; }
  .note.error { color: var(--color-danger); }
  .cancel { margin-left: auto; }
  .failure { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .actions :global(.spinning) { animation: spin 1s linear infinite var(--loops); }
  :global(html[data-motion='reduced']) .actions :global(.spinning) { animation: none; }
  @media (prefers-reduced-motion: reduce) { .actions :global(.spinning) { animation: none; } }
  @media (max-width: 720px) {
    .updates { padding: 14px 16px; }
    .actions { width: 100%; }
    .actions button { flex: 1; min-height: var(--touch-target); }
    .channel button { min-height: var(--touch-target); }
    .auto { min-height: var(--touch-target); }
  }
</style>
