<script lang="ts">
  import type { SurfaceKind } from '../lib/right-panel.svelte';
  import { strings } from '../lib/strings';
  import { offeredCards, kindHint, kindName, unavailable } from '../lib/surface-labels';
  import SurfaceIcon from './SurfaceIcon.svelte';

  /** The empty panel: one card per kind of surface, each with the letter that opens it. */
  let {
    available,
    remoteBrowser = false,
    onlaunch,
    onmenu,
    oncustomize
  }: {
    available: (kind: SurfaceKind) => boolean;
    remoteBrowser?: boolean;
    onlaunch: (kind: SurfaceKind) => void;
    /** A card's right click, which offers to put it away. */
    onmenu: (event: MouseEvent, kind: SurfaceKind) => void;
    /** Where the cards come back from once every one is put away. */
    oncustomize: () => void;
  } = $props();
  let cards = $derived(offeredCards());
</script>

<div class="launcher" data-testid="panel-launcher">
  <p class="section-label">{strings.rightPanel.launcher}</p>
  {#if cards.length === 0}
    <div class="none" data-testid="launcher-none">
      <p>{strings.controls.allHidden}</p>
      <button type="button" data-testid="launcher-customize" onclick={oncustomize}>{strings.controls.customize}</button>
    </div>
  {/if}
  <div class="cards">
    <!-- A card that cannot open stays and says why: a page needs the
         desktop shell's webview, and the rest read what a paired device
         is refused. -->
    {#each cards as card (card.kind)}
      <button
        type="button"
        class="card"
        disabled={!available(card.kind)}
        data-testid="launch-{card.kind}"
        onclick={() => onlaunch(card.kind)}
        oncontextmenu={(event) => onmenu(event, card.kind)}
      >
        <SurfaceIcon kind={card.kind} size={16} />
        <span class="card-name">{remoteBrowser && card.kind === 'browser' ? strings.remoteBrowser.title : kindName(card.kind)}</span>
        <span class="card-hint">{available(card.kind) ? remoteBrowser && card.kind === 'browser' ? strings.remoteBrowser.hint : kindHint(card.kind) : unavailable(card.kind)}</span>
        <span class="kbd">{card.key}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .launcher {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .none {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }

  .cards {
    display: grid;
    /* Five cards now, on a panel dragged to any width: the row fills with what
       fits instead of staying at two columns. */
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
  }

  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    height: auto;
    padding: 12px 12px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface-2);
    color: var(--color-muted-foreground);
    text-align: left;
    white-space: normal;
  }

  .card:hover:not(:disabled) {
    border-color: var(--color-edge);
    background: var(--color-surface-3);
  }

  .card-name {
    color: var(--color-foreground);
    font-weight: 600;
    margin-top: 6px;
  }

  .card-hint {
    font-size: var(--text-sm);
    line-height: 1.4;
  }

  .card .kbd {
    position: absolute;
    top: 8px;
    right: 8px;
  }
</style>
