/**
 * Draws the diagrams and formulas `lib/markdown.ts` marked (`.md-mermaid`,
 * `.md-math`) in a node that shows rendered Markdown, as they arrive in it:
 * the node is watched, so a block an answer completes is drawn on its own.
 *
 * This action is all the startup bundle carries. The drawing code, its styles
 * and the libraries behind it (`lib/rich-markdown-draw.ts`) are imported the
 * first time a node holds something to draw. Until then the source stays on
 * screen, and it stays when that import fails: a diagram then says it could
 * not be drawn here.
 */
import { strings } from './strings';
import type { MediaItem } from './media-gallery';

type Drawing = typeof import('./rich-markdown-draw');

export interface RichMarkdownOptions {
  /** Shows a drawn diagram over the app (`ImageViewer`). Without it a diagram has no enlarge button. */
  onenlarge?: (item: MediaItem) => void;
}

const PENDING = '.md-math:not([data-drawn]), .md-mermaid:not([data-drawn])';

let drawing: Drawing | null = null;
let loading: Promise<Drawing> | null = null;

/** A failed import is tried again by the next block that needs it: an offline phone may be back online. */
function load(): Promise<Drawing> {
  loading ??= import('./rich-markdown-draw').then(module => drawing = module, (reason: unknown) => { loading = null; throw reason; });
  return loading;
}

export function richMarkdown(node: HTMLElement, options: RichMarkdownOptions = {}) {
  let current = options;
  const enlarge = () => current.onenlarge;
  const draw = (): void => {
    if (!node.querySelector(PENDING)) return;
    if (!drawing) {
      void load().then(draw, unavailable);
      return;
    }
    for (const element of node.querySelectorAll<HTMLElement>(PENDING)) {
      element.dataset.drawn = '';
      drawing.draw(element, enlarge);
    }
  };
  // The blocks waiting now keep their source; a formula's TeX reads as it is.
  const unavailable = (): void => {
    for (const element of node.querySelectorAll<HTMLElement>(PENDING)) {
      element.dataset.drawn = '';
      if (!element.classList.contains('md-mermaid')) continue;
      const line = document.createElement('p');
      line.className = 'md-diagram-error';
      line.dataset.testid = 'diagram-error';
      line.textContent = strings.chat.diagram.unavailable;
      element.append(line);
    }
  };
  draw();
  const observer = new MutationObserver(draw);
  observer.observe(node, { childList: true, subtree: true });
  // Nothing drawn, nothing to rewrite: until the module is here a copy is the browser's own.
  const copy = (event: ClipboardEvent): void => drawing?.copySource(node, event);
  node.addEventListener('copy', copy);
  return {
    update(next: RichMarkdownOptions = {}) { current = next; },
    destroy() {
      observer.disconnect();
      node.removeEventListener('copy', copy);
    }
  };
}
