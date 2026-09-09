<script lang="ts">
  import { providerLogos } from '../lib/provider-logos';

  /**
   * The provider's mark in `currentColor`, or its initial when nothing is drawn
   * for that id. The tile around it carries the name and the colour.
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
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    data-logo={providerId}
    fill={logo.stroke === undefined ? 'currentColor' : 'none'}
    stroke={logo.stroke === undefined ? undefined : 'currentColor'}
    stroke-width={logo.stroke}
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d={logo.path} />
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

  .initial {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    font-weight: 600;
    line-height: 1;
  }
</style>
