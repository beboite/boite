/**
 * Mermaid diagrams, drawn by Pele (https://pele.run): no dependency, one small
 * chunk per diagram type, and colors that are CSS variables, so a theme or an
 * accent change recolors a drawn diagram without drawing it again. Loaded only
 * for an answer that holds a diagram (`lib/rich-markdown-draw.ts`).
 */
import { renderAsync, PeleError } from 'pele/lazy';
import { sanitizeMarkup } from './sanitize-markup';

export interface DrawnDiagram {
  svg: DocumentFragment;
  width: number;
  height: number;
}

let drawn = 0;

/**
 * The diagram as checked SVG, laid out for `width` pixels in `font`. Throws
 * a `DiagramError` that names the line for a source Pele cannot read. Links
 * and pictures are off: a diagram contacts nobody and opens nothing.
 */
export async function renderDiagram(source: string, width: number, font: string): Promise<DrawnDiagram> {
  const idPrefix = `md-diagram-${++drawn}-`;
  try {
    const result = await renderAsync(source, {
      links: false,
      images: false,
      idPrefix,
      fontFamily: font,
      ...(width > 0 ? { maxWidth: width } : {})
    });
    return { svg: sanitizeMarkup(result.svg, idPrefix), width: result.width, height: result.height };
  } catch (error) {
    if (error instanceof PeleError) throw new DiagramError(summary(error), error.line);
    throw error;
  }
}

/** Pele's message without the copy of the source it points into: the code is on screen already. */
function summary(error: PeleError): string {
  const snippet = new Set((error.snippet ?? '').split('\n'));
  return error.message.split('\n').filter((line) => line.trim() && !snippet.has(line)).join(' ') || error.message;
}

export class DiagramError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
  }
}
