/**
 * Temml, loaded only for an answer that holds a formula (`lib/rich-markdown-draw.ts`
 * imports this module on demand). It writes MathML, which the browser lays out
 * with the system's math font. Its stylesheet and its one small font, for the
 * glyphs a system font may lack, are files of the build, so a formula draws
 * under the shell's content policy, on a phone and offline once fetched.
 */
import temml from 'temml';
import 'temml/dist/Temml-Local.css';
import { sanitizeMarkup } from './sanitize-markup';

/**
 * A formula as checked MathML nodes. Throws Temml's ParseError for TeX it
 * cannot read. `trust` stays off, so `\href`, `\url` and `\includegraphics`
 * draw nothing that leaves the page.
 */
export function renderMath(tex: string, display: boolean): DocumentFragment {
  const markup = temml.renderToString(tex, {
    displayMode: display,
    throwOnError: true,
    trust: false,
    strict: false,
    // A formula cannot ask for a box wider than the page, or loop on its own macros.
    maxSize: [50, 50],
    maxExpand: 500
  });
  return sanitizeMarkup(markup);
}
