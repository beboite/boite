<script lang="ts">
  import type { Snippet } from 'svelte';
  import { glyphShapes, type GlyphNode } from '../lib/glyph';

  /**
   * What every `@lucide/svelte` icon draws through instead of Lucide's own
   * `Icon.svelte` (`icon-plugin.ts` swaps it in): the same svg, attributes and
   * classes, with the shapes built once per icon and cloned in. An icon with
   * no extra attribute takes a template with nothing spread on it.
   */
  type IconData = { name?: string; node: GlyphNode[]; aliases?: string[]; size?: number; width?: number; height?: number };
  let {
    color = 'currentColor',
    size = 24,
    width = size,
    height = size,
    strokeWidth = 2,
    absoluteStrokeWidth = false,
    nonScalingStroke = false,
    iconNode = [],
    icon = { node: iconNode, aliases: [], size: 24 },
    class: extra,
    children,
    ...rest
  }: {
    color?: string;
    size?: number | string;
    width?: number | string;
    height?: number | string;
    strokeWidth?: number | string;
    absoluteStrokeWidth?: boolean;
    nonScalingStroke?: boolean;
    iconNode?: GlyphNode[];
    icon?: IconData;
    class?: string | null;
    children?: Snippet;
    [attribute: string]: unknown;
  } = $props();

  const viewSize = $derived(icon.size ?? icon.width ?? 24);
  const viewBox = $derived(`0 0 ${viewSize} ${icon.size ?? icon.height ?? 24}`);
  const stroke = $derived(absoluteStrokeWidth ? (Number(strokeWidth) * Number(viewSize)) / Number(width) : strokeWidth);
  const classes = $derived(['lucide', ...(icon.name ? [`lucide-${icon.name}`] : []),
    ...(icon.aliases ?? []).filter((alias) => typeof alias === 'string' && alias.trim() !== '').map((alias) => `lucide-${alias}`),
    'lucide-icon', extra].filter(Boolean).join(' '));
  /** The shapes go in first, before any children, as Lucide orders them. */
  function shapes(svg: SVGSVGElement, glyph: [IconData, boolean]) {
    let [current, scaling] = glyph;
    svg.prepend(glyphShapes(current, scaling));
    return {
      update([next, nextScaling]: [IconData, boolean]) {
        if (next === current && nextScaling === scaling) return;
        for (let index = 0; index < current.node.length; index++) svg.firstChild?.remove();
        current = next;
        scaling = nextScaling;
        svg.prepend(glyphShapes(current, scaling));
      }
    };
  }
  /** Lucide hides an icon from assistive technology unless it was given a name or a role. */
  const labelled = $derived(Boolean(children) || Object.keys(rest).some((name) => name.startsWith('aria-') || name === 'role' || name === 'title'));
  const plain = $derived(!children && Object.keys(rest).length === 0);
</script>

{#if plain}
  <svg xmlns="http://www.w3.org/2000/svg" {width} {height} {viewBox} fill="none" stroke={color || 'currentColor'} stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" class={classes} aria-hidden="true" use:shapes={[icon, nonScalingStroke]}></svg>
{:else}
  <svg xmlns="http://www.w3.org/2000/svg" {width} {height} {viewBox} fill="none" stroke={color || 'currentColor'} stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" class={classes} aria-hidden={labelled ? undefined : 'true'} {...rest} use:shapes={[icon, nonScalingStroke]}>{@render children?.()}</svg>
{/if}
