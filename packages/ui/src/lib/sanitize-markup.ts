/**
 * Markup a library drew from an agent's text (a diagram's SVG, a formula's
 * MathML), cut down to what drawing needs before it enters the page.
 * The string is parsed in an inert template, so nothing in it runs or loads
 * while it is checked, and the checked nodes are the ones inserted: nothing is
 * serialized and parsed a second time, where a sanitized tree could change.
 *
 * An element off the list goes with everything inside it; an `<a>` gives way
 * to its text. An attribute off the list goes, as does any `on…` handler, a
 * reference that is not to an element of the same drawing, and a style that
 * names an address.
 */

const ELEMENTS = new Set([
  // SVG.
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'defs', 'marker', 'title', 'desc', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'stop',
  'pattern', 'symbol', 'use',
  // MathML, as Temml writes a formula.
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext', 'mspace', 'msup', 'msub',
  'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'mlabeledtr',
  'mstyle', 'mpadded', 'mphantom', 'menclose', 'merror', 'mmultiscripts', 'mprescripts', 'none'
]);

/** Elements whose text is kept when they are not: a link becomes its label. */
const UNWRAP = new Set(['a']);

const ATTRIBUTES = new Set([
  'class', 'style', 'role', 'xmlns', 'xml:space', 'xml:lang', 'lang', 'dir',
  'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'dx', 'dy',
  'd', 'points', 'transform', 'preserveaspectratio', 'pathlength',
  'fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'stroke-opacity', 'opacity', 'vector-effect', 'paint-order',
  'font-size', 'font-weight', 'font-family', 'font-style', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'baseline-shift', 'letter-spacing', 'textlength', 'lengthadjust', 'rotate', 'visibility', 'display',
  'marker-start', 'marker-mid', 'marker-end', 'markerwidth', 'markerheight', 'markerunits', 'refx', 'refy', 'orient',
  'clip-path', 'mask', 'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'patternunits',
  'href', 'xlink:href', 'id',
  // MathML.
  'mathvariant', 'encoding', 'stretchy', 'fence', 'separator', 'lspace', 'rspace', 'minsize', 'maxsize', 'accent',
  'accentunder', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'columnlines', 'rowlines', 'scriptlevel',
  'displaystyle', 'depth', 'linethickness', 'notation', 'voffset', 'movablelimits', 'symmetric', 'largeop', 'form',
  'mathcolor', 'mathbackground', 'mathsize', 'linebreak'
]);

/** A value that loads or runs something: an address other than `#id`, a script scheme, an old IE expression. */
const UNSAFE_VALUE = /url\s*\(\s*['"]?\s*(?!#)|javascript:|vbscript:|data:|expression\s*\(|@import/i;

/** The page's own elements share the id space: a drawing's ids carry its prefix or go. */
export function sanitizeMarkup(markup: string, idPrefix = ''): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = markup;
  clean(template.content, idPrefix);
  return template.content;
}

function clean(parent: ParentNode, idPrefix: string): void {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.COMMENT_NODE || node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) { node.remove(); continue; }
    if (!(node instanceof Element)) continue;
    const name = node.localName.toLowerCase();
    if (UNWRAP.has(name)) {
      clean(node, idPrefix);
      node.replaceWith(...node.childNodes);
      continue;
    }
    if (!ELEMENTS.has(name)) { node.remove(); continue; }
    for (const attribute of [...node.attributes]) {
      if (!allowed(attribute, idPrefix)) node.removeAttributeNode(attribute);
    }
    clean(node, idPrefix);
  }
}

function allowed(attribute: Attr, idPrefix: string): boolean {
  const name = attribute.name.toLowerCase();
  const value = attribute.value;
  if (name.startsWith('on')) return false;
  if (!ATTRIBUTES.has(name) && !name.startsWith('aria-') && !name.startsWith('data-')) return false;
  if (name === 'id') return idPrefix !== '' && value.startsWith(idPrefix);
  if (name === 'href' || name === 'xlink:href') return idPrefix !== '' && value.startsWith(`#${idPrefix}`);
  if (UNSAFE_VALUE.test(value)) return false;
  // A `url(#id)` reaches only this drawing's own elements.
  for (const match of value.matchAll(/url\s*\(\s*['"]?\s*#([^'")\s]*)/gi)) {
    if (idPrefix === '' || !match[1]!.startsWith(idPrefix)) return false;
  }
  return true;
}
