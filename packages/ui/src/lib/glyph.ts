/**
 * The shapes of a Lucide icon, built once per icon and cloned into each svg
 * that draws it. Lucide's own component draws each shape as a
 * `svelte:element` with its attributes spread on, and every mount paid for
 * that again; markup through `{@html}` paid the HTML parser instead. A clone
 * of a finished node costs neither.
 */
export type GlyphNode = [tag: string, attributes: Record<string, string | number>, children?: GlyphNode[]];

const SVG = 'http://www.w3.org/2000/svg';
const built = new WeakMap<object, DocumentFragment>();
const builtNonScaling = new WeakMap<object, DocumentFragment>();

/** One element per shape, flat, as Lucide's component draws them: it never draws a shape's children. */
function build(nodes: GlyphNode[], nonScalingStroke: boolean, into: Node): void {
  for (const [tag, attributes] of nodes) {
    const element = document.createElementNS(SVG, tag);
    if (nonScalingStroke) element.setAttribute('vector-effect', 'non-scaling-stroke');
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    into.appendChild(element);
  }
}

/** A fresh copy of `icon`'s shapes: the same elements and attributes Lucide writes. */
export function glyphShapes(icon: { node: GlyphNode[] }, nonScalingStroke = false): DocumentFragment {
  const cache = nonScalingStroke ? builtNonScaling : built;
  let shapes = cache.get(icon);
  if (!shapes) {
    shapes = document.createDocumentFragment();
    build(icon.node, nonScalingStroke, shapes);
    cache.set(icon, shapes);
  }
  return shapes.cloneNode(true) as DocumentFragment;
}
