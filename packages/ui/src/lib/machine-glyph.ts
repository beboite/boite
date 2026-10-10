import { Apple, Cloud, Cpu, Laptop, Monitor, Server, ServerCog } from '@lucide/svelte';
import type { MachineIconName } from './workspace.svelte';

const icons = { desktop: Monitor, laptop: Laptop, server: Server, rack: ServerCog, cloud: Cloud, cpu: Cpu };

/** The icon a machine wears: the one the user picked, else its operating system's. */
export function machineGlyph(icon?: MachineIconName, os?: string) {
  return icon ? icons[icon] : os === 'macos' ? Apple : os === 'linux' ? Server : Monitor;
}
