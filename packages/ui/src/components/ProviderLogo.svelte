<script lang="ts">
  import { providerLogos } from '../lib/provider-logos';

  /**
   * The provider's own mark in its own colours, or its initial in
   * `currentColor` when nothing is drawn for that id. The tile around it
   * carries the name.
   */
  let {
    providerId,
    size = 18
  }: {
    providerId: string;
    size?: number;
  } = $props();

  let logo = $derived(providerLogos[providerId] ?? null);
  let initial = $derived((providerId.trim()[0] ?? '?').toUpperCase());
</script>

{#if logo}
  <svg
    class="logo"
    width={size}
    height={size}
    viewBox={logo.viewBox}
    aria-hidden="true"
    focusable="false"
    data-logo={providerId}
  >
    {#if logo.kind === 'image'}
      <image href={logo.href} width={logo.width} height={logo.height} />
    {:else}
      {#if logo.tile}
        <rect width={logo.tile.width} height={logo.tile.height} rx={logo.tile.rx} fill={logo.tile.fill} />
      {/if}
      {#each logo.paths as path, index (index)}
        {#if typeof path.fill === 'string'}
          <path d={path.d} fill={path.fill} fill-rule={path.evenOdd ? 'evenodd' : undefined} />
        {:else}
          <!-- The theme decides between the two, in CSS, so a switch repaints
               the mark without touching the component. -->
          <path
            class="themed"
            d={path.d}
            fill-rule={path.evenOdd ? 'evenodd' : undefined}
            style:--fill-dark={path.fill.dark}
            style:--fill-light={path.fill.light}
          />
        {/if}
      {/each}
    {/if}
  </svg>
{:else}
  <span
    class="initial"
    aria-hidden="true"
    data-initial={providerId}
    style="width: {size}px; height: {size}px; font-size: {Math.round(size * 0.72)}px"
  >
    {initial}
  </span>
{/if}

<style>
  .logo {
    display: block;
    flex: none;
  }

  .themed {
    fill: var(--fill-dark);
  }

  :global(:root[data-theme='light']) .themed {
    fill: var(--fill-light);
  }

  .initial {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    font-weight: 600;
    line-height: 1;
  }
</style>
