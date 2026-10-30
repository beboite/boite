<script lang="ts">
  import { Apple, Bot, Cloud, Cpu, Database, Gamepad2, HardDrive, House, Laptop, Monitor, Router, Server, ServerCog, Smartphone, Tablet, Terminal, Tv } from '@lucide/svelte';
  import type { MachineIconName } from '../lib/workspace.svelte';
  let { os, icon, size = 13 }: { os?: string; icon?: MachineIconName; size?: number } = $props();
  const icons = {
    desktop: Monitor, laptop: Laptop, phone: Smartphone, tablet: Tablet, apple: Apple, server: Server, rack: ServerCog, nas: HardDrive,
    database: Database, cloud: Cloud, cpu: Cpu, router: Router, terminal: Terminal, bot: Bot, gamepad: Gamepad2, tv: Tv, house: House,
  };
  let Icon = $derived(icon ? icons[icon] : os === 'macos' ? Apple : os === 'linux' ? Server : Monitor);
</script>

<Icon {size} strokeWidth={1.6} />
