<script lang="ts">
  import { Apple, Monitor, Server } from '@lucide/svelte';
  let { os, size = 13 }: { os?: string; size?: number } = $props();
</script>

{#if os === 'macos'}<Apple {size} strokeWidth={1.6} />
{:else if os === 'linux'}<Server {size} strokeWidth={1.6} />
{:else}<Monitor {size} strokeWidth={1.6} />{/if}
