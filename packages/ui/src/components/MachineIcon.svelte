<script lang="ts">
  import { Apple, Monitor, Server, Laptop, Cloud, Cpu, ServerCog } from '@lucide/svelte';
  import type { MachineIconName } from '../lib/workspace.svelte';
  let { os, icon, size = 13 }: { os?: string; icon?: MachineIconName; size?: number } = $props();
  const icons = { desktop: Monitor, laptop: Laptop, server: Server, rack: ServerCog, cloud: Cloud, cpu: Cpu };
  let Icon = $derived(icon ? icons[icon] : os === 'macos' ? Apple : os === 'linux' ? Server : Monitor);
</script>

<Icon {size} strokeWidth={1.6} />
