<script module lang="ts">
  import type { TechGlyph } from '../lib/tech-icons';

  // The marks are 28 KB of path data: they load the first time a tile needs
  // one, not with the first chunk. Until then, and if the load fails, the
  // initial stands.
  let techGlyphs = $state.raw<Partial<Record<string, TechGlyph>> | null>(null);
  let glyphsAsked = false;
  function loadGlyphs(): void {
    if (glyphsAsked) return;
    glyphsAsked = true;
    void import('../lib/tech-icons')
      .then((module) => { techGlyphs = module.techGlyphs; })
      .catch(() => { glyphsAsked = false; });
  }
</script>

<script lang="ts">
  import type { Project } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { projectName } from '../lib/format';

  /**
   * A project's mark: the logo the core found in its folder, else the mark of
   * the stack it reads as, else its initial on a tile. The logo's bytes come
   * from the Store that owns the project, fetched the first time a tile needs
   * them; until they land, and if they never do, the initial stands.
   */
  let { project, store, size = 20 }: { project: Project; store: Store; size?: number } = $props();

  let url = $derived(store.projectIconUrl(project));
  let glyph = $derived(project.icon?.kind === 'tech' ? (techGlyphs?.[project.icon.id] ?? null) : null);
  let initial = $derived(projectName(project).slice(0, 1).toUpperCase());
  /** An image that fails to decode falls back to the initial rather than a broken picture. */
  let broken = $state<string | null>(null);

  $effect(() => {
    if (project.icon?.kind === 'image' && url === null) void store.loadProjectIcon(project);
    if (project.icon?.kind === 'tech') loadGlyphs();
  });
</script>

{#if url !== null && broken !== url}
  <span class="tile image" style:--tile={`${size}px`} data-testid="project-tile" data-kind="image"
    ><img src={url} alt="" draggable="false" decoding="async" onerror={() => (broken = url)} /></span
  >
{:else if glyph}
  <span class="tile tech" class:mono={glyph.mono} style:--tile={`${size}px`} data-testid="project-tile" data-kind="tech" data-tech={project.icon?.kind === 'tech' ? project.icon.id : undefined} title={glyph.title}
    ><svg viewBox="-2 -2 28 28" width={size - 2} height={size - 2} role="img" aria-label={glyph.title}><path d={glyph.path} fill={glyph.mono ? 'currentColor' : glyph.hex} /></svg></span
  >
{:else}
  <span class="tile letter" style:--tile={`${size}px`} data-testid="project-tile" data-kind="letter">{initial}</span>
{/if}

<style>
  .tile {
    display: grid;
    place-items: center;
    width: var(--tile);
    height: var(--tile);
    flex: none;
    overflow: hidden;
    border-radius: var(--radius-sm);
  }
  .letter {
    background: var(--color-surface-3);
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
  }
  .tech {
    background: var(--color-surface-3);
  }
  .tech.mono {
    color: var(--color-foreground);
  }
  .image img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
</style>
