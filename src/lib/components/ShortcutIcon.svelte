<script lang="ts">
  import type { IconKey } from "$lib/settings.svelte";
  import Zap from "@lucide/svelte/icons/zap";
  import MousePointer2 from "@lucide/svelte/icons/mouse-pointer-2";
  import Bot from "@lucide/svelte/icons/bot";
  import Code2 from "@lucide/svelte/icons/code-2";
  import TerminalIcon from "@lucide/svelte/icons/terminal";

  type Props = {
    iconKey?: IconKey;
    size?: number;
    monochrome?: boolean;
  };
  let { iconKey = null, size = 14, monochrome = false }: Props = $props();
</script>

{#if iconKey === "claude"}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill={monochrome ? "currentColor" : "#d97757"}
    aria-hidden="true"
  >
    <path
      d="M12 2.5l1.18 6.04L19 7.4l-3.6 4.6L19 16.6l-5.82-1.14L12 21.5l-1.18-6.04L5 16.6l3.6-4.6L5 7.4l5.82 1.14L12 2.5z"
    />
  </svg>
{:else if iconKey === "codex"}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill={monochrome ? "currentColor" : "#10a37f"}
    aria-hidden="true"
  >
    <path
      d="M12 3a4 4 0 0 1 3.46 6 4 4 0 0 1 0 6 4 4 0 0 1-6.92 0 4 4 0 0 1 0-6A4 4 0 0 1 12 3zm-1.5 5.6L8.6 9.7v4.6l1.9 1.1V8.6zm3 0v6.8l1.9-1.1V9.7l-1.9-1.1zM12 6.6l-1.5.85v1.95l1.5.85 1.5-.85V7.45L12 6.6zm0 7.95l-1.5.85v1.95l1.5.85 1.5-.85V15.4l-1.5-.85z"
    />
  </svg>
{:else if iconKey === "gemini"}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill={monochrome ? "currentColor" : "#4285f4"}
    aria-hidden="true"
  >
    <path
      d="M12 2c.6 4.6 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8z"
    />
  </svg>
{:else if iconKey === "cursor"}
  <span
    class="inline-flex"
    style="color: {monochrome ? 'currentColor' : '#e4e6eb'}"
  >
    <MousePointer2 {size} />
  </span>
{:else if iconKey === "copilot"}
  <span
    class="inline-flex"
    style="color: {monochrome ? 'currentColor' : '#a371f7'}"
  >
    <Bot {size} />
  </span>
{:else if iconKey === "opencode"}
  <span
    class="inline-flex"
    style="color: {monochrome ? 'currentColor' : '#f97316'}"
  >
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
