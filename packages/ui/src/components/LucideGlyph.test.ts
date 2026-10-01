import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { Icon as LucideIcon } from '@lucide/svelte';
import LucideGlyph from './LucideGlyph.svelte';

/**
 * `icon-plugin.ts` swaps Lucide's `Icon.svelte` for `LucideGlyph.svelte` in
 * every icon the app draws. The barrel still exports Lucide's own, so the two
 * can be drawn side by side: the svg they leave in the page must be the same.
 */
const mounted: Record<string, unknown>[] = [];
afterEach(() => { for (const instance of mounted.splice(0)) unmount(instance); document.body.innerHTML = ''; });

const shapes = {
  name: 'bench-glyph',
  aliases: ['glyph-alias', ' '],
  size: 24,
  node: [
    ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
    ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }],
    ['g', { opacity: '0.5' }, [['circle', { cx: '12', cy: '12', r: '3' }]]]
  ]
};

function draw(component: unknown, props: Record<string, unknown>): Element {
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(mount(component as Component<Record<string, unknown>>, { target, props: { icon: shapes, ...props } }));
  flushSync();
  const svg = target.querySelector('svg')!;
  // Svelte's anchors are comments and blank text: not part of the drawing.
  for (const node of [...svg.querySelectorAll('*'), svg].flatMap((element) => [...element.childNodes])) {
    if (node.nodeType === Node.COMMENT_NODE || (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())) node.remove();
  }
  return svg;
}

type Shape = { tag: string; attributes: Record<string, string>; children: Shape[] };
function shape(element: Element): Shape {
  return {
    tag: element.tagName,
    attributes: Object.fromEntries([...element.attributes].map((attribute) => [attribute.name, attribute.value])),
    children: [...element.children].map(shape)
  };
}

test.each([
  {},
  { size: 13 },
  { size: 14, strokeWidth: 1.5 },
  { size: 16, class: 'spin' },
  { color: 'red' },
  { size: 12, strokeWidth: 2, absoluteStrokeWidth: true },
  { nonScalingStroke: true },
  { width: 10, height: 20 },
  { 'aria-label': 'Copied' },
  { 'aria-hidden': 'false', fill: 'currentColor' },
  { style: 'color: red', role: 'img' }
])('draws the svg Lucide draws with %o', (props) => {
  const theirs = draw(LucideIcon, props);
  const ours = draw(LucideGlyph, props);
  // Attribute order aside, the element, its attributes and its shapes are equal.
  // (`isEqualNode` also weighs the namespace a parser gives `xmlns`, which draws nothing.)
  expect(shape(ours)).toEqual(shape(theirs));
});
