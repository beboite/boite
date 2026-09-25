<script lang="ts">
  import { onMount } from 'svelte';
  import InfoTip from './InfoTip.svelte';
  import type { HarnessUpdate } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import ProviderLogo from './ProviderLogo.svelte';

  /** The store is the machine whose settings are open, so the switch and the list are that machine's. */
  let { store }: { store: Store } = $props();
  const uid = $props.id();

  let checking = $state(false);
  let busy = $derived(checking || store.harnessUpdates.some((update) => update.state === 'checking'));

  async function check() {
    checking = true;
    try {
      await store.loadHarnessUpdates(true);
    } finally {
      checking = false;
    }
  }

  // The core answers from its last reading and never runs the agents for a plain list:
  // opening this card on a core that has not read them yet is the moment to.
  onMount(() => {
    // A store with no core yet has nothing to ask, and must not show the button busy.
    if (store.client !== null && store.owner && store.harnessUpdates.length === 0 && !busy) void check();
  });

  function newer(update: HarnessUpdate): boolean {
    return update.latest !== null && update.current !== null && update.latest !== update.current && (update.pending || update.skipped === update.latest || update.state === 'failed');
  }

  function status(update: HarnessUpdate): string {
    if (update.state === 'updating') return strings.harnessUpdates.updating(update.name);
    if (update.state === 'checking') return strings.harnessUpdates.checking;
    if (update.state === 'failed') return update.message ?? strings.harnessUpdates.failed(update.name);
    if (update.latest === null) return strings.harnessUpdates.unknown;
    if (update.skipped !== null && update.skipped === update.latest) return strings.harnessUpdates.skipped(update.latest);
    if (update.pending) return strings.harnessUpdates.availableShort;
    return strings.harnessUpdates.upToDate;
  }
</script>

{#if store.owner}
  <section class="card updates" id="settings-harness-updates" data-testid="harness-updates-card">
    <div class="top">
      <div>
        <h2>{strings.harnessUpdates.heading}<InfoTip topic={strings.harnessUpdates.heading} text={strings.harnessUpdates.intro} /></h2>
      </div>
      <button type="button" class="quiet small" data-testid="harness-updates-check" disabled={busy} onclick={() => void check()}>
        {busy ? strings.harnessUpdates.checking : strings.harnessUpdates.check}
      </button>
    </div>

    <label for="{uid}-auto" class="switch-row">
      <span class="text"><span id="{uid}-auto-name">{strings.harnessUpdates.auto}</span><InfoTip topic={strings.harnessUpdates.auto} text={strings.harnessUpdates.autoHint} /></span>
      <input id="{uid}-auto" aria-labelledby="{uid}-auto-name"
        type="checkbox"
        role="switch"
        data-testid="setting-auto-update-harnesses"
        checked={store.settings?.autoUpdateHarnesses ?? false}
        onchange={(event) => void store.saveSettings({ autoUpdateHarnesses: event.currentTarget.checked })}
      />
    </label>

    {#if store.harnessUpdates.length === 0}
      <p class="hint none">{busy ? strings.harnessUpdates.checking : strings.harnessUpdates.none}</p>
    {:else}
      <ul>
        {#each store.harnessUpdates as update (update.providerId)}
          <li data-testid="harness-update-row" data-update-provider={update.providerId} data-state={update.state}>
            <ProviderLogo providerId={update.providerId} size={18} />
            <span class="name">{update.name}<span class="route">{strings.harnessUpdates.route[update.route]}</span></span>
            <span class="version mono">{update.current ?? '?'}{#if newer(update)}{' → '}{update.latest}{/if}</span>
            <span class="state" class:bad={update.state === 'failed'} title={update.state === 'failed' ? (update.message ?? '') : ''}>{status(update)}</span>
            <span class="row-actions">
              {#if update.skipped !== null && update.skipped === update.latest}
                <button type="button" class="quiet small" data-testid="harness-update-unskip" onclick={() => void store.skipHarnessUpdate(update.providerId, null)}>{strings.harnessUpdates.unskip}</button>
              {:else if update.pending || (update.state === 'failed' && newer(update))}
                <button type="button" class="primary small" data-testid="harness-update-row-run" onclick={() => void store.updateHarness(update.providerId)}>
                  {update.state === 'failed' ? strings.harnessUpdates.retry : strings.harnessUpdates.update}
                </button>
              {:else if update.route === 'self' && update.latest === null && update.current !== null && update.state !== 'updating'}
                <button type="button" class="quiet small" data-testid="harness-update-row-blind" onclick={() => void store.updateHarness(update.providerId)}>{strings.harnessUpdates.runUpdater}</button>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .updates { margin-bottom: 16px; }

  .top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  ul {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    border-top: 1px solid var(--color-border);
  }

  li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) 160px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    min-height: var(--row);
    padding: 6px 0;
    border-bottom: 1px solid var(--color-border);
    font-size: var(--text-sm);
  }

  li:last-child { border-bottom: 0; }

  .name { display: flex; flex-direction: column; min-width: 0; font-weight: 500; }
  .route { font-weight: 400; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .version { font-size: var(--text-xs); color: var(--color-muted-foreground); white-space: nowrap; }

  .state {
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state.bad { color: var(--color-danger); }
  .row-actions { display: flex; justify-content: flex-end; min-width: 0; }
  .none { margin: 8px 0 0; }

  @media (max-width: 720px) {
    li { grid-template-columns: auto minmax(0, 1fr) auto; }
    .state { grid-column: 2 / -1; white-space: normal; }
    .row-actions { grid-column: 2 / -1; justify-content: flex-start; }
  }
</style>
