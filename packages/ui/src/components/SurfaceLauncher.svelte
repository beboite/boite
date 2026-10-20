<script lang="ts">
  import type { SurfaceKind } from '../lib/right-panel.svelte';
  import { strings } from '../lib/strings';
  import { offeredCards, kindName } from '../lib/surface-labels';
  import SurfaceIcon from './SurfaceIcon.svelte';

  /** The empty panel: one card per kind of surface, each with the letter that opens it. */
  let {
    available,
    onlaunch,
    onmenu,
    oncustomize
  }: {
    available: (kind: SurfaceKind) => boolean;
    onlaunch: (kind: SurfaceKind) => void;
    /** A card's right click, which offers to put it away. */
    onmenu: (event: MouseEvent, kind: SurfaceKind) => void;
    /** Where the cards come back from once every one is put away. */
    oncustomize: () => void;
  } = $props();
  // A kind this client cannot open has no card: no line under a card to say why.
  let cards = $derived(offeredCards().filter((card) => available(card.kind)));
</script>

<div class="launcher" data-testid="panel-launcher">
  <p class="section-label">{strings.rightPanel.launcher}</p>
  {#if cards.length === 0}
    <div class="none" data-testid="launcher-none">
      <p>{strings.controls.allHidden}</p>
      <button type="button" data-testid="launcher-customize" onclick={oncustomize}><span class="ui-label">{strings.controls.customize}</span></button>
    </div>
  {/if}
  <div class="cards">
    {#each cards as card (card.kind)}
      <button
        type="button"
        class="card"
        data-testid="launch-{card.kind}"
        onclick={() => onlaunch(card.kind)}
        oncontextmenu={(event) => onmenu(event, card.kind)}
      >
        <SurfaceIcon kind={card.kind} size={28} />
        <span class="card-name ui-label">{kindName(card.kind)}</span>
        <span class="kbd ui-label-box"><span class="ui-label">{card.key}</span></span>
      </button>
    {/each}
  </div>
</div>

<style>
  /* The empty panel is all launcher: the cards share its whole height rather
     than sit as a strip at the top of a blank column. */
  .launcher {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    container-type: inline-size;
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

  /* Two columns, four once the panel is wide: eight cards then make full rows. */
  .cards {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-auto-rows: minmax(96px, 1fr);
    gap: 10px;
  }

  @container (min-width: 560px) {
    .cards { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }

  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    height: auto;
    padding: 16px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface-2);
    color: var(--color-muted-foreground);
    text-align: center;
    white-space: normal;
    transition: border-color var(--dur-2) var(--ease-out-quint), background var(--dur-2) var(--ease-out-quint), color var(--dur-2) var(--ease-out-quint);
  }

  .card:hover:not(:disabled) {
    border-color: var(--color-edge);
    background: var(--color-surface-3);
    color: var(--color-foreground);
  }

  .card-name {
    color: var(--color-foreground);
    font-weight: 600;
  }


  .card .kbd {
    position: absolute;
    top: 8px;
    right: 8px;
  }

  /* A phone has no keyboard to press the letter with. */
  @media (max-width: 720px) {
    .card .kbd { display: none; }
  }
</style>
