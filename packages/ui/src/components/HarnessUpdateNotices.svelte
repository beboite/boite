<script lang="ts">
  import type { HarnessUpdate } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import ProviderLogo from './ProviderLogo.svelte';

  /** More than this many at once would bury the thread; the settings page lists the rest. */
  const MOST = 3;

  interface Notice {
    key: string;
    machine: string;
    store: Store;
    update: HarnessUpdate;
  }

  /**
   * One notice per agent and per machine: each core reports its own agents, so
   * the same agent behind on two machines is two notices, each answered by the
   * store of the machine that owns it.
   */
  let notices = $derived.by(() => {
    const out: Notice[] = [];
    for (const machine of workspace.machines) {
      if (machine.store.connection !== 'ready' || !machine.store.owner) continue;
      for (const update of machine.store.harnessUpdates) {
        // A failure with nothing newer behind it is a failed check, which belongs to the settings page.
        const failedUpdate = update.state === 'failed' && update.latest !== null && update.latest !== update.current && update.skipped !== update.latest;
        // An update runs in the background once asked for: only a failure brings the notice back.
        if (!update.pending && !failedUpdate) continue;
        out.push({ key: `${machine.id}::${update.providerId}`, machine: machine.label, store: machine.store, update });
      }
    }
    return out.slice(0, MOST);
  });
  let several = $derived(workspace.machines.length > 1);
  /** A phone's settings are one narrow column: the notices wait for the conversation. */
  let offChat = $derived(workspace.active.page !== 'chat');
</script>

{#if notices.length > 0}
  <div class="update-notices" class:off-chat={offChat} data-testid="harness-update-notices" role="region" aria-label={strings.harnessUpdates.heading}>
    {#each notices as notice (notice.key)}
      {@const update = notice.update}
      <article class="notice" data-testid="harness-update-notice" data-update-provider={update.providerId} data-state={update.state}>
        <span class="logo"><ProviderLogo providerId={update.providerId} size={20} /></span>
        <div class="lines">
          {#if update.state === 'failed'}
            <span class="heading bad">{strings.harnessUpdates.failed(update.name)}</span>
            <p class="message">{update.message}</p>
          {:else}
            <span class="heading">{strings.harnessUpdates.available(update.name, update.latest ?? '')}</span>
            <p>
              {strings.harnessUpdates.installed(update.current ?? '')}{#if several}<span class="sep" aria-hidden="true"> · </span>{strings.harnessUpdates.on(notice.machine)}{/if}
            </p>
          {/if}
        </div>
        <div class="actions">
          <button type="button" class="quiet small" data-testid="harness-update-skip" onclick={() => void notice.store.skipHarnessUpdate(update.providerId, update.latest)}>
            {strings.harnessUpdates.skip}
          </button>
          <button type="button" class="primary small" data-testid="harness-update-run" onclick={() => void notice.store.updateHarness(update.providerId)}>
            {update.state === 'failed' ? strings.harnessUpdates.retry : strings.harnessUpdates.update}
          </button>
        </div>
      </article>
    {/each}
  </div>
{/if}

<style>
  /* Pinned under the title bar and never auto-dismissed: a notice leaves only
     on Update, on Skip, or when the core says the agent is current. The top
     right corner is the one the composer, the sidebar and the tab bar of a
     phone all leave alone. */
  .update-notices {
    position: absolute;
    right: max(16px, env(safe-area-inset-right));
    top: calc(var(--titlebar, 44px) + 12px + env(safe-area-inset-top, 0px));
    z-index: 70;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(400px, calc(100vw - 32px));
    pointer-events: none;
  }

  .notice {
    pointer-events: auto;
    position: relative;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--color-surface-2) 96%, transparent);
    backdrop-filter: blur(10px);
    box-shadow: var(--shadow-e3);
    overflow: hidden;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .logo {
    display: grid;
    place-items: center;
    width: var(--control);
    height: var(--control);
    border-radius: var(--radius-md);
    background: var(--color-surface-3);
  }

  .lines { min-width: 0; }
  .heading { display: block; font-size: var(--text-sm); font-weight: 600; overflow-wrap: anywhere; }
  .heading.bad { color: var(--color-danger); }

  p {
    margin: 2px 0 0;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .message {
    max-height: 72px;
    overflow-y: auto;
    user-select: text;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  @media (prefers-reduced-motion: reduce) {
    .notice { animation: none; }
  }

  /* A phone shows one at a time: answering it brings the next. */
  @media (max-width: 720px) {
    .update-notices {
      top: calc(56px + env(safe-area-inset-top, 0px));
      left: 16px;
      right: 16px;
      width: auto;
    }
    /* A conversation adds its header row under the phone's own: the card sits below both. */
    :global(.app.phone-chat) .update-notices { top: calc(56px + var(--titlebar, 44px) + 8px + env(safe-area-inset-top, 0px)); }
    .notice:nth-child(n + 2) { display: none; }
    .update-notices.off-chat { display: none; }
  }
</style>
