<script lang="ts">
  // The explanation behind a setting, one "i" away. A mouse shows it on hover,
  // a finger or a click pins it open, Escape or a press elsewhere puts it away.
  // Screen readers get it as the button's description while it is shown, and
  // the button names what it explains, so nothing hides from them.
  import { Info } from '@lucide/svelte';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import { fill, strings } from '../lib/strings';

  let { text, topic, testid }: { text: string; topic: string; testid?: string } = $props();

  const tip = new Closing();
  const id = `info-${Math.random().toString(36).slice(2, 10)}`;
  let trigger = $state<HTMLButtonElement>();
  let bubble = $state<HTMLElement>();
  /** Opened by a click or a tap: a pointer leaving does not close it. */
  let pinned = $state(false);

  function close(): void {
    pinned = false;
    tip.hide();
  }

  function onclick(event: MouseEvent): void {
    // Inside a `label`, the click must not also flip the switch it sits beside.
    event.preventDefault();
    if (pinned) close();
    else {
      pinned = true;
      tip.show();
    }
  }

  function onpointerenter(event: PointerEvent): void {
    if (event.pointerType === 'mouse') tip.show();
  }

  function onpointerleave(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && !pinned) tip.hide();
  }

  $effect(() => {
    if (!tip.open) return;
    const onkey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
      trigger?.focus();
    };
    const onpress = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (trigger?.contains(target) || bubble?.contains(target))) return;
      close();
    };
    window.addEventListener('keydown', onkey, true);
    document.addEventListener('pointerdown', onpress, true);
    return () => {
      window.removeEventListener('keydown', onkey, true);
      document.removeEventListener('pointerdown', onpress, true);
    };
  });
</script>

<button
  type="button"
  class="info-tip ghost icon"
  aria-label={fill(strings.common.moreInfo, { topic })}
  aria-expanded={tip.open}
  aria-describedby={tip.shown ? id : undefined}
  data-testid={testid ?? 'info-tip'}
  bind:this={trigger}
  {onclick}
  {onpointerenter}
  {onpointerleave}
  onfocus={(event) => { if (event.currentTarget.matches(':focus-visible')) tip.show(); }}
  onblur={() => { if (!pinned) tip.hide(); }}
>
  <Info size={14} strokeWidth={1.75} />
</button>
{#if tip.shown}
  <span
    {id}
    class="info-bubble"
    class:closing={tip.closing}
    role="tooltip"
    data-testid="{testid ?? 'info-tip'}-text"
    bind:this={bubble}
    use:tip.attach
    use:floating={{ anchor: () => trigger ?? null, dismiss: close }}
    onanimationend={tip.end}
  >{text}</span>
{/if}

<style>
  .info-tip {
    width: 22px;
    height: 22px;
    margin: -2px 0 -2px 4px;
    padding: 0;
    border-radius: 50%;
    vertical-align: middle;
    color: var(--color-muted-foreground);
  }

  .info-tip[aria-expanded='true'] {
    color: var(--color-foreground);
    background: var(--color-surface-3);
  }

  .info-bubble {
    position: fixed;
    z-index: 60;
    display: block;
    max-width: min(340px, calc(100vw - 24px));
    padding: 8px 10px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    box-shadow: var(--shadow-e2);
    color: var(--color-foreground);
    font-size: var(--text-sm);
    font-weight: 400;
    line-height: 1.5;
    letter-spacing: normal;
    text-transform: none;
    white-space: normal;
    animation: pop var(--dur-2) var(--ease-out-quint);
  }

  .info-bubble.closing {
    animation-name: pop-out;
  }

  /* A phone gets it as a sheet, where there is room to read. */
  .info-bubble:global([data-mobile-sheet='true']) {
    max-width: none;
    padding: 14px 16px;
    font-size: var(--text-md);
  }

  /* A finger gets a bigger target that takes no more room on the line, and
     the open state shows in the icon alone: a filled disc that size is loud. */
  @media (max-width: 720px) {
    .info-tip { width: 30px; height: 30px; margin: -8px -6px -8px -2px; }
    .info-tip[aria-expanded='true'] { background: transparent; color: var(--color-accent); }
  }
</style>
