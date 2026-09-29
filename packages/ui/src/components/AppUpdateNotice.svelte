<script lang="ts">
  import { tick } from 'svelte';
  import { CircleArrowDown, X } from '@lucide/svelte';
  import AppUpdateContent from './AppUpdateContent.svelte';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import { appUpdater, showAppUpdateUi } from '../lib/app-update.svelte';
  import { appUpdateInstall } from '../lib/app-update-install.svelte';
  import { strings } from '../lib/strings';

  const popover = new Closing();
  let trigger = $state<HTMLButtonElement>();
  let content = $state<HTMLDivElement>();

  $effect(() => {
    if (!popover.open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !trigger?.contains(target) && !content?.contains(target)) popover.hide();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  });

  function close() {
    popover.hide();
    trigger?.focus({ preventScroll: true });
  }

  async function toggle() {
    if (popover.open) return close();
    popover.show();
    await tick();
    if (popover.open) content?.focus({ preventScroll: true });
  }

  function onkeydown(event: KeyboardEvent) {
    if (!popover.open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab' && content) {
      const items = Array.from(content.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary'))
        .filter(item => item.getClientRects().length > 0);
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === content)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }
  }
</script>

{#if showAppUpdateUi()}
  <button type="button" class="ghost icon update-trigger" class:ready={appUpdater.announceReady}
    bind:this={trigger} title={strings.appUpdate.heading} aria-label={strings.appUpdate.heading}
    aria-haspopup="dialog" aria-expanded={popover.open} disabled={appUpdateInstall.preparing}
    onclick={toggle} data-testid="nav-app-update">
    <CircleArrowDown size={16} strokeWidth={1.75} />
    {#if appUpdater.announceReady}<span class="badge" data-testid="app-update-badge"></span>{/if}
  </button>
  {#if popover.shown}
    <div class="update-popover" class:closing={popover.closing} bind:this={content}
      role="dialog" tabindex="-1" aria-label={strings.appUpdate.heading} {onkeydown} data-testid="app-update-popover"
      use:popover.attach onanimationend={popover.end}
      use:floating={{ anchor: () => trigger ?? null, placement: 'top', cap: 560, dismiss: close }}>
      <header><h2>{strings.appUpdate.heading}</h2><button class="ghost small icon" aria-label={strings.common.close} title={strings.common.close} onclick={close}><X size={14} /></button></header>
      <div class="body"><AppUpdateContent beforeInstall={close} /></div>
      {#if appUpdater.announceReady}
        <footer><button class="ghost small" onclick={() => { appUpdater.dismiss(); close(); }} data-testid="update-notice-dismiss">{strings.appUpdate.hideReminder}</button></footer>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .update-trigger { position: relative; flex: none; }
  .update-trigger.ready { color: var(--color-foreground); }
  .badge { position: absolute; width: 5px; height: 5px; right: 3px; top: 3px; border-radius: 50%; background: var(--color-success); }
  .update-popover { display: flex; flex-direction: column; width: 320px; padding: 0; color: var(--color-foreground); background: var(--color-surface-2); border: 1px solid var(--color-edge); border-radius: var(--radius-lg); box-shadow: var(--shadow-e2); overflow: hidden; animation: pop var(--dur-2) var(--ease-out-quint); }
  .update-popover:focus { outline: none; }
  .update-popover.closing { animation-name: pop-out; pointer-events: none; }
  header { display: flex; align-items: center; justify-content: space-between; flex: none; gap: 8px; padding: 6px 8px 6px 14px; border-bottom: 1px solid var(--color-border); }
  h2 { margin: 0; font-size: var(--text-sm); font-weight: 600; }
  .body { min-height: 0; overflow-y: auto; }
  footer { display: flex; justify-content: flex-end; flex: none; padding: 6px 8px; border-top: 1px solid var(--color-border); }
</style>
