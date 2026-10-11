<script lang="ts">
  import { SlidersHorizontal } from '@lucide/svelte';
  import { Closing } from '../lib/closing.svelte';
  import type { ProjectEntry } from '../lib/project-view.svelte';
  import { strings } from '../lib/strings';
  import type { Project } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';

  /**
   * The sliders over the thread list and the panel of display options they
   * open (DisplayOptionsPanel.svelte). The panel loads on its own, a moment
   * after the list has drawn, so it stays out of the entry chunk and the first
   * press still opens it at once. It stays open while the user adjusts it; a
   * press outside or Escape puts it away.
   */
  let { entries, target, owner, prefix = '' }: { entries: ProjectEntry[]; target: Project | undefined; owner: Store; prefix?: string } = $props();

  const popover = new Closing();
  let root = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  let Panel = $state.raw<typeof import('./DisplayOptionsPanel.svelte').default>();
  let loading: Promise<void> | undefined;
  function load(): Promise<void> {
    loading ??= import('./DisplayOptionsPanel.svelte').then((module) => { Panel = module.default; }).catch(() => { loading = undefined; popover.hide(); });
    return loading;
  }
  $effect(() => {
    const timer = setTimeout(() => void load(), 1500);
    return () => clearTimeout(timer);
  });

  function toggle(event: MouseEvent): void {
    event.stopPropagation();
    void load();
    popover.toggle();
  }
  function close(refocus = false): void {
    popover.hide();
    if (refocus) trigger?.focus({ preventScroll: true });
  }
  function onWindowPointerdown(event: PointerEvent): void {
    if (!popover.open || (root && event.target instanceof Node && root.contains(event.target))) return;
    // A tooltip opened from the panel lives in the top layer, outside it.
    if (event.target instanceof Element && event.target.closest('.info-bubble')) return;
    close();
  }
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

<div class="display-options" bind:this={root}>
  <button type="button" class="ghost icon small trigger" bind:this={trigger} aria-haspopup="dialog" aria-expanded={popover.open}
    aria-label={strings.sidebar.groupingOptions} title={strings.sidebar.groupingOptions} data-testid={`${prefix}grouping-options`} onclick={toggle}>
    <SlidersHorizontal size={16} />
  </button>
  {#if popover.shown && Panel}
    <Panel {popover} anchor={() => trigger ?? null} onclose={close} {entries} {target} {owner} {prefix} />
  {/if}
</div>

<style>
  .display-options { position: relative; display: inline-flex; }
  .trigger[aria-expanded='true'] { background: var(--color-surface-3); color: var(--color-foreground); }
</style>
