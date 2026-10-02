import { minifySync, type Plugin } from 'vite';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { tooNewForFloor } from './src/lib/browser-floor.ts';

/** Compress the two prepaint blocks Vite leaves outside its JS pipeline. */
export function prepaintMinify(): Plugin {
  const comments = [' Painted before the stylesheet arrives,', ' The same rule as lib/theme.ts,', ' A browser under the floor (Safari 15.4, Chrome 111: docs/phone.md)'];
  return {
    name: 'boite-prepaint-minify',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const nodes: DefaultTreeAdapterTypes.Node[] = [parse(html, { sourceCodeLocationInfo: true })];
        const edits: { start: number; end: number; text: string }[] = [];
        for (const node of nodes) {
          if ('childNodes' in node) nodes.push(...node.childNodes);
          const location = node.sourceCodeLocation;
          if (!location) continue;
          if (node.nodeName === '#comment' && 'data' in node && comments.some(comment => node.data.startsWith(comment))) {
            edits.push({ start: location.startOffset, end: location.endOffset, text: '' });
          }
          if (!('tagName' in node) || node.tagName !== 'script' || node.attrs.length) continue;
          const { startTag, endTag } = node.sourceCodeLocation ?? {};
          if (!startTag || !endTag) continue;
          const code = html.slice(startTag.endOffset, endTag.startOffset);
          const font = code.includes("localStorage.getItem('boite.font')") && code.includes("localStorage.getItem('boite.theme')");
          const colors = code.includes('var colorTools =') && code.includes('boite.theme-colors.v1');
          // Notice and locale scripts stay ES5, including their original bytes.
          if (!font && !colors) continue;
          const result = minifySync('prepaint.js', code, { module: false, compress: { target: 'es2015' }, mangle: { toplevel: true }, codegen: { legalComments: 'inline' } });
          if (result.errors.length) throw new Error(`prepaint minification: ${result.errors.map((error) => error.message).join('\n')}`);
          const hits = tooNewForFloor(result.code);
          if (hits.length) throw new Error(`prepaint uses what Safari 15.4 cannot run: ${hits.join(', ')}`);
          if (result.code.toLowerCase().includes('</script')) throw new Error('prepaint minification emitted an HTML script end tag');
          edits.push({ start: startTag.endOffset, end: endTag.startOffset, text: result.code });
        }
        // Source offsets keep all untouched tags, attributes and ES5 scripts byte-identical.
        for (const edit of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, edit.start) + edit.text + html.slice(edit.end);
        return html;
      },
    },
  };
}
