<script lang="ts">
  import type { SurfaceKind } from '../lib/right-panel.svelte';
  import { surfaceGlyph } from '../lib/surface-glyphs';

  /** The icon of a kind of surface, on its tab and on its launcher card. */
  let { kind, size }: { kind: SurfaceKind; size: number } = $props();
  const Glyph = $derived(surfaceGlyph(kind));
</script>

<Glyph {size} strokeWidth={1.75} />
