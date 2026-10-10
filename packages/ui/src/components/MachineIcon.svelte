<script lang="ts">
  import type { MachineIconName } from '../lib/workspace.svelte';
  import { machineGlyph } from '../lib/machine-glyph';
  let { os, icon, size = 13 }: { os?: string; icon?: MachineIconName; size?: number } = $props();
  let Icon = $derived(machineGlyph(icon, os));
</script>

<Icon {size} strokeWidth={1.6} />
