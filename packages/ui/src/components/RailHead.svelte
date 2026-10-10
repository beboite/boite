<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Store } from '../lib/store.svelte';
  import SurfaceSwitch from './SurfaceSwitch.svelte';

  /**
   * The top of a list: the Threads and Agents switch, then one row of tools,
   * what the list shows on the left and its actions on the right. The thread
   * list and the Agents list both draw it, so switching between them moves
   * nothing but the rows.
   */
  let { store, current, prefix = '', lead, actions }: {
    store: Store;
    current: 'threads' | 'agents';
    prefix?: string;
    lead?: Snippet;
    actions?: Snippet;
  } = $props();
</script>

<div class="rail-head">
  <SurfaceSwitch {store} {current} {prefix} />
  <div class="tools">
    {@render lead?.()}
    <div class="actions">{@render actions?.()}</div>
  </div>
</div>

<style>
  .rail-head { container-type: inline-size; min-width: 0; padding: 8px 0 6px; border-bottom: 1px solid var(--color-border); }
  .tools { display: flex; align-items: center; gap: 6px; min-height: var(--control-sm); }
  /* Under the Threads and Agents switch, when the Agents experiment draws it. */
  .tools:not(:first-child) { margin-top: 5px; }
  .actions { display: flex; align-items: center; gap: 2px; margin-left: auto; flex: none; }
  .actions :global(button.icon) { flex: none; }
  .actions :global(button.icon.active) { background: var(--color-active); color: var(--color-foreground); }
  @media (max-width: 720px) {
    .actions :global(button.icon), .actions :global(.menu .trigger.ghost) { width: var(--control-touch); height: var(--control-touch); }
  }
</style>
