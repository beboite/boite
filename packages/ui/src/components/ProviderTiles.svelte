<script lang="ts">
  import { Star } from '@lucide/svelte';
  import type { ProviderSummary } from '@boite/contracts';
  import ProviderLogo from './ProviderLogo.svelte';
  import { strings } from '../lib/strings';
  import type { Choice, Store } from '../lib/store.svelte';

  /**
   * The model picker's rail: the favorites tile, then one tile per provider in
   * the order the core listed them. A tile only moves the column beside it.
   */
  let {
    store,
    choice,
    locked,
    current,
    favoritesOpen,
    onfavorites,
    onpick
  }: {
    store: Store;
    choice: Choice | null;
    locked: boolean;
    /** The provider whose column is shown. */
    current: string | null;
    favoritesOpen: boolean;
    onfavorites: () => void;
    onpick: (providerId: string) => void;
  } = $props();

  interface Tile {
    provider: ProviderSummary;
    /** Why this provider cannot run, or null: it dims the tile and rides in its title. */
    reason: string | null;
    /** True while an open thread holds the choice on another provider. */
    held: boolean;
  }

  /** One tile per provider, in the order the core listed them. */
  let tiles = $derived.by((): Tile[] =>
    store.providers.map((entry) => {
      const reason = !entry.available
        ? strings.composer.unavailable
        : store.accountsOf(entry.id).length === 0
          ? strings.composer.noAccount
          : null;
      return { provider: entry, reason, held: locked && choice?.providerId !== entry.id };
    })
  );

  function tileTitle(tile: Tile): string {
    if (tile.held) return strings.composer.lockedHint;
    return tile.reason === null ? tile.provider.name : `${tile.provider.name}, ${tile.reason}`;
  }

  /** A tile only moves the column: the choice follows a model or an account chip. */
  function pickTile(tile: Tile) {
    if (tile.held) return;
    onpick(tile.provider.id);
  }
</script>

<button type="button" class="tile" class:current={favoritesOpen} role="menuitem" data-row data-provider="favorites" title={strings.composer.favorites} aria-label={strings.composer.favorites} onclick={onfavorites}><Star size={24} /></button>
{#each tiles as tile (tile.provider.id)}
  <button
    type="button"
    class="tile"
    class:current={!favoritesOpen && current === tile.provider.id}
    class:dim={tile.reason !== null}
    disabled={tile.held}
    role="menuitem"
    data-row
    data-provider={tile.provider.id}
    title={tileTitle(tile)}
    aria-label={tile.provider.name}
    onclick={() => pickTile(tile)}
  >
    <ProviderLogo providerId={tile.provider.id} size={28} />
  </button>
{/each}

<style>
  .tile {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: var(--control-lg);
    height: var(--control-lg);
    padding: 0;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-muted-foreground);
    transition:
      background var(--dur-2) var(--ease-out-quint),
      color var(--dur-2) var(--ease-out-quint);
  }

  .tile:hover:not(:disabled),
  .tile:focus-visible {
    background: var(--color-hover);
    color: var(--color-foreground);
    outline: none;
  }

  .tile.current {
    background: var(--color-active);
    color: var(--color-foreground);
  }

  /* Nothing runs on it: still pickable, so its column can say why. */
  .tile.dim {
    opacity: 0.45;
  }

  @media (max-width: 720px) {
    /* The rail is the finger's first stop on a phone, so its tiles take a
       full touch target like every other control. */
    .tile { justify-content: center; padding: 0; }
    .tile {
      width: var(--touch-target);
      height: var(--touch-target);
    }
  }
</style>
