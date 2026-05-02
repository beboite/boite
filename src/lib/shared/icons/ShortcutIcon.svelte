<script lang="ts">
  import type { IconKey } from "$lib/types";
  import { getBrandGlyph } from "./brand";
  import Zap from "@lucide/svelte/icons/zap";
  import Code2 from "@lucide/svelte/icons/code-2";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import Sparkles from "@lucide/svelte/icons/sparkles";

  type Props = {
    iconKey?: IconKey;
    size?: number;
    monochrome?: boolean;
  };
  let { iconKey = null, size = 14, monochrome = false }: Props = $props();

  const brand = $derived(iconKey ? getBrandGlyph(iconKey) : null);
</script>

{#if brand}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill={monochrome ? "currentColor" : `#${brand.hex}`}
    aria-hidden="true"
  >
    <path d={brand.path} />
  </svg>
{:else if iconKey === "codex"}
  <span class="inline-flex" style="color: {monochrome ? 'currentColor' : '#10a37f'}">
    <Sparkles {size} />
  </span>
{:else if iconKey === "opencode"}
  <span class="inline-flex" style="color: {monochrome ? 'currentColor' : '#f97316'}">
    <Code2 {size} />
  </span>
{:else if iconKey === "terminal"}
  <span class="inline-flex text-muted-foreground">
    <TerminalIcon {size} />
  </span>
{:else}
  <span class="inline-flex text-muted-foreground">
    <Zap {size} />
  </span>
{/if}
