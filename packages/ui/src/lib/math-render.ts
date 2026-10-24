/**
 * KaTeX, loaded only for an answer that holds a formula (`lib/rich-markdown-draw.ts`
 * imports this module on demand). Its stylesheet and fonts are files of the
 * build, so a formula draws under the shell's content policy, on a phone and
 * offline once fetched. The fonts are the woff2 ones alone (`vite.config.ts`).
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { sanitizeMarkup } from './sanitize-markup';

/**
 * A formula as checked nodes, HTML for the eye and MathML for a screen reader.
 * Throws KaTeX's ParseError for TeX it cannot read. `trust` stays off, so
 * `\href`, `\url` and `\includegraphics` draw nothing that leaves the page.
 */
export function renderMath(tex: string, display: boolean): DocumentFragment {
  const html = katex.renderToString(tex, {
    displayMode: display,
    throwOnError: true,
    output: 'htmlAndMathml',
    trust: false,
    strict: 'ignore',
    // A formula cannot ask for a box wider than the page, or loop on its own macros.
    maxSize: 50,
    maxExpand: 500
  });
  return sanitizeMarkup(html);
}
