<script module lang="ts">
  import type { HarnessUpdate, ProviderSummary } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';

  /** Boite's own copy of the agent has a newer download waiting. */
  export function updatable(store: Store, provider: ProviderSummary): boolean {
    const install = store.installOf(provider.id);
    // When the agent that runs is not Boite's copy, its own updater owns the
    // version; an Update here would refresh a copy nothing uses.
    if (store.harnessUpdates.some((update) => update.providerId === provider.id && update.route === 'self')) return false;
    return install?.state === 'installed' && install.available !== install.version;
  }

  function newer(update: HarnessUpdate): boolean {
    return update.latest !== null && update.current !== null && update.latest !== update.current && (update.pending || update.skipped === update.latest || update.state === 'failed');
  }

  const skippedNow = (update: HarnessUpdate): boolean => update.skipped !== null && update.skipped === update.latest;
  /** The release a row offers: the arrow and the Update button go together. */
  const offered = (update: HarnessUpdate): boolean => !skippedNow(update) && (update.pending || (update.state === 'failed' && newer(update)));
</script>

<script lang="ts">
  import { strings } from '../lib/strings';

  /**
   * A provider row's installed version and, when a release is out, the one
   * thing to do about it. `main` makes that button the row's primary action.
   */
  let { store, provider, main = false, installing = false, oninstall }: {
    store: Store;
    provider: ProviderSummary;
    main?: boolean;
    /** Boite's own copy is downloading: the progress bar speaks for it. */
    installing?: boolean;
    /** Downloads the newer copy of the agent Boite manages. */
    oninstall: () => void;
  } = $props();

  let update = $derived(store.harnessUpdates.find((entry) => entry.providerId === provider.id));
  let install = $derived(store.installOf(provider.id));
  /** The agent's own updater ran from here: its answer, even "nothing newer", is shown once it lands. */
  let asked = $state(false);
  let answered = $derived(asked && update?.state === 'idle' && update.latest !== null && update.latest === update.current);

  function runUpdater(providerId: string) {
    asked = true;
    void store.updateHarness(providerId);
  }

  /** What the version says on hover: whose install it is and where it stands. */
  function versionTitle(update: HarnessUpdate): string {
    const where = strings.harnessUpdates.route[update.route];
    if (update.latest === null) return `${where} · ${strings.harnessUpdates.unknown}`;
    if (offered(update)) return `${where} · ${strings.harnessUpdates.availableShort}`;
    return `${where} · ${strings.harnessUpdates.upToDate}`;
  }
</script>

<!-- An agent that is not on this machine has nothing to update, whatever the last reading said. -->
{#if update && ((provider.available && update.current !== null) || update.state !== 'idle')}
  <span class="update" data-testid="provider-update" data-update-provider={provider.id} data-state={update.state}>
    {#if update.current !== null}
      <span class="version ui-label" title={versionTitle(update)}>{offered(update) ? `${update.current} → ${update.latest}` : update.current}</span>
    {/if}
    {#if update.state === 'updating' || update.state === 'checking'}
      <span class="note-inline live ui-label" role="status">{update.state === 'updating' ? strings.providerSettings.updating : strings.harnessUpdates.checking}</span>
    {:else if skippedNow(update) && update.latest !== null}
      <span class="note-inline ui-label">{strings.harnessUpdates.skipped(update.latest)}</span>
    {:else if answered}
      <span class="note-inline ui-label" role="status" data-testid="harness-update-current">{strings.harnessUpdates.upToDate}</span>
    {/if}
    {#if skippedNow(update)}
      <button type="button" class="quiet small" data-testid="harness-update-unskip" onclick={() => void store.skipHarnessUpdate(update.providerId, null)}><span class="ui-label">{strings.harnessUpdates.unskip}</span></button>
    {:else if offered(update) && update.state !== 'updating'}
      <button type="button" class="small" class:primary={main} data-testid="harness-update-row-run" onclick={() => void store.updateHarness(update.providerId)}>
        <span class="ui-label">{update.state === 'failed' ? strings.harnessUpdates.retry : strings.harnessUpdates.update}</span>
      </button>
    {:else if update.route === 'self' && update.latest === null && update.current !== null && update.state !== 'updating'}
      <button type="button" class="quiet small" data-testid="harness-update-row-blind" onclick={() => runUpdater(update.providerId)}><span class="ui-label">{strings.harnessUpdates.runUpdater}</span></button>
    {/if}
  </span>
{:else if provider.available && install?.state === 'installed' && !installing}
  <span class="update" data-testid="install-version">
    <span class="version ui-label" title={strings.harnessUpdates.route.managed}>{updatable(store, provider) ? `${install.version} → ${install.available}` : install.version}</span>
    {#if updatable(store, provider)}
      <button type="button" class="small" class:primary={main} data-testid="install-update" onclick={oninstall}><span class="ui-label">{strings.install.update}</span></button>
    {/if}
  </span>
{/if}

<style>
  .update { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
  .version { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--color-muted-foreground); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .note-inline { font-size: var(--text-sm); color: var(--color-muted-foreground); white-space: nowrap; }
  .note-inline.live { color: var(--color-live); }
</style>
