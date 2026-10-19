<script lang="ts">
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * The two tabs at the start of the drawer under the chat: the project's
   * board and the thread's terminal. A paired device runs no shell, so it
   * shows the board alone.
   */
  let { store, current }: { store: Store; current: 'board' | 'terminal' } = $props();
</script>

<div class="tabs" role="tablist" aria-label={strings.board.tabs} data-testid="drawer-tabs">
  <button type="button" class="ghost tab ui-label" role="tab" aria-selected={current === 'board'} class:selected={current === 'board'}
    data-testid="drawer-tab-board" onclick={() => { if (current !== 'board') store.showBoard(); }}>
    {strings.board.tab}
  </button>
  {#if store.owner}
    <button type="button" class="ghost tab ui-label" role="tab" aria-selected={current === 'terminal'} class:selected={current === 'terminal'}
      data-testid="drawer-tab-terminal" onclick={() => { if (current !== 'terminal') store.toggleTerminal(); }}>
      {strings.board.terminalTab}
    </button>
  {/if}
</div>

<style>
  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
    margin-left: -6px;
  }

  .tab {
    height: var(--control-sm);
    padding: 0 8px;
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-muted-foreground);
    background: none;
    white-space: nowrap;
  }

  .tab:not(.selected):hover { background: var(--color-hover); color: var(--color-foreground); }
  .tab.selected { background: var(--color-active); color: var(--color-foreground); }
</style>
