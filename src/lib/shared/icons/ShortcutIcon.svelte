<script lang="ts">
  import type { IconKey } from "$lib/types";
  import { getBrandGlyph } from "./brand";
  import Zap from "@lucide/svelte/icons/zap";
  import TerminalIcon from "@lucide/svelte/icons/terminal";

  type Props = {
    iconKey?: IconKey;
    size?: number;
  };
  let { iconKey = null, size = 14 }: Props = $props();

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
  <img
    src={asset}
    alt=""
    decoding="async"
    width={size}
    height={size}
    class="shrink-0 brightness-0 invert"
    style:width="{size}px"
    style:height="{size}px"
    aria-hidden="true"
    draggable="false"
  />
{:else if brand}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="#ffffff"
    aria-hidden="true"
  >
    <path d={brand.path} />
  </svg>
{:else if iconKey === "terminal"}
  <span class="inline-flex text-foreground">
    <TerminalIcon {size} />
  </span>
{:else}
  <span class="inline-flex text-foreground">
    <Zap {size} />
  </span>
{/if}
