<script lang="ts">
  import type { IconKey } from "$lib/types";
  import { getBrandGlyph } from "./brand";
  import Zap from "@lucide/svelte/icons/zap";
  import TerminalIcon from "@lucide/svelte/icons/terminal";

  type Props = {
    iconKey?: IconKey;
    size?: number;
    /**
     * Colour replacing the glyph's own. Any CSS colour: the shortcut editor stores hex,
     * while the model tint passes a `var(--color-term-…)` so it follows the theme.
     */
    color?: string | null;
  };
  let { iconKey = null, size = 14, color = null }: Props = $props();

  const brand = $derived(iconKey ? getBrandGlyph(iconKey) : null);

  const ASSET_BY_KEY: Partial<Record<NonNullable<IconKey>, string>> = {
    codex: "/icons/chatgpt.svg",
    antigravity: "/icons/antigravity.png",
    opencode: "/icons/opencode.svg",
    grok: "/icons/grok.svg",
    hermes: "/icons/hermes.svg",
  };
  const asset = $derived(iconKey ? ASSET_BY_KEY[iconKey] : null);
</script>

{#if asset}
  {#if color}
    <!-- The asset is an opaque file, so recolor it by masking a solid fill
         with the artwork's own alpha instead of drawing the image. -->
    <span
      class="shrink-0"
      style:width="{size}px"
      style:height="{size}px"
      style:background-color={color}
      style:-webkit-mask="url({asset}) center / contain no-repeat"
      style:mask="url({asset}) center / contain no-repeat"
      aria-hidden="true"
    ></span>
  {:else}
    <img
      src={asset}
      alt=""
      decoding="async"
      width={size}
      height={size}
      class="shrink-0"
      style:width="{size}px"
      style:height="{size}px"
      aria-hidden="true"
      draggable="false"
    />
  {/if}
{:else if brand}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill={color ?? `#${brand.hex}`}
    aria-hidden="true"
  >
    <path d={brand.path} />
  </svg>
{:else if iconKey === "terminal"}
  <span class="inline-flex" style:color={color ?? undefined}>
    <TerminalIcon {size} class={color ? undefined : "text-muted-foreground"} />
  </span>
{:else}
  <span class="inline-flex" style:color={color ?? undefined}>
    <Zap {size} class={color ? undefined : "text-muted-foreground"} />
  </span>
{/if}
