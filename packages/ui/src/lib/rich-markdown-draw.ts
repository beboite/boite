/**
 * Draws one diagram, formula or view `lib/markdown.ts` marked, for the action
 * in `lib/rich-markdown.ts`, which imports this module the first time a node
 * holds one. A block a scroll mounts again is drawn from the cache, in the
 * same frame; a view loads its page again, at the height it last had.
 *
 * Pele and Temml are imported in turn, by the first diagram and the first
 * formula. Until a block is drawn app.css keeps a placeholder in its place, and
 * whenever drawing fails its source shows again (`md-source`): a diagram Pele
 * cannot read or a view whose page never came up shows its code and one quiet
 * line that says why, a formula Temml cannot read keeps its TeX with the reason
 * as its tooltip. A selection copied across a drawing copies its source.
 */
import { VIEW_BLEED } from '@boite/contracts';
import { fill, strings } from './strings';
import type { MediaItem } from './media-gallery';
import type { RichMarkdownOptions } from './rich-markdown';
import { knownViewHeight, mountViewFrame } from './view-block';
import './rich-markdown-draw.css';

type MathModule = typeof import('./math-render');
type DiagramModule = typeof import('./diagram-render');

let mathModule: MathModule | null = null;
let mathLoading: Promise<MathModule> | null = null;
let diagramModule: DiagramModule | null = null;
let diagramLoading: Promise<DiagramModule> | null = null;

/** A failed import is tried again by the next block that needs it: an offline phone may be back online. */
function loadMath(): Promise<MathModule> {
  mathLoading ??= import('./math-render').then(module => mathModule = module, (reason: unknown) => { mathLoading = null; throw reason; });
  return mathLoading;
}

function loadDiagrams(): Promise<DiagramModule> {
  diagramLoading ??= import('./diagram-render').then(module => diagramModule = module, (reason: unknown) => { diagramLoading = null; throw reason; });
  return diagramLoading;
}

/**
 * Drawn markup by source, so a message a scroll brings back is not drawn
 * again. Bounded by count, oldest first. Each use takes a deep clone: the
 * cached nodes never enter the page.
 */
class DrawnCache<T extends { fragment: DocumentFragment }> {
  #entries = new Map<string, T>();
  constructor(private readonly limit: number) {}
  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return { ...entry, fragment: entry.fragment.cloneNode(true) as DocumentFragment };
  }
  set(key: string, entry: T): T {
    this.#entries.set(key, entry);
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.limit) break;
      this.#entries.delete(oldest);
    }
    return { ...entry, fragment: entry.fragment.cloneNode(true) as DocumentFragment };
  }
}

const formulas = new DrawnCache<{ fragment: DocumentFragment }>(400);
const diagrams = new DrawnCache<{ fragment: DocumentFragment; width: number; height: number }>(60);

/** Draws a marked element; its options are read when they are needed, so they follow the action's. */
export function draw(element: HTMLElement, options: () => RichMarkdownOptions): void {
  if (element.classList.contains('md-math')) drawMath(element);
  else if (element.classList.contains('md-view')) drawView(element, options);
  else drawDiagram(element, options);
}

function drawMath(element: HTMLElement): void {
  const tex = element.dataset.tex ?? '';
  const display = element.hasAttribute('data-display');
  const put = (module: MathModule): void => {
    const key = `${display ? 'd' : 'i'}${tex}`;
    try {
      const { fragment } = formulas.get(key) ?? formulas.set(key, { fragment: module.renderMath(tex, display) });
      element.replaceChildren(fragment);
      element.classList.add('md-drawn');
    } catch (error) {
      element.classList.add('md-math-failed', 'md-source');
      element.title = fill(strings.chat.formulaFailed, { reason: reason(error) });
    }
  };
  if (mathModule) put(mathModule);
  else loadMath().then(put, () => { element.classList.add('md-source'); });
}

function drawDiagram(element: HTMLElement, options: () => RichMarkdownOptions): void {
  const source = element.dataset.source ?? '';
  const code = element.querySelector('pre');
  // Laid out for the column it sits in; a phone's narrow column turns a wide `LR` chart on its side.
  const width = Math.floor(element.clientWidth / 40) * 40;
  const font = getComputedStyle(element).fontFamily;
  const key = `${width}|${font}|${source}`;

  const put = (drawn: { fragment: DocumentFragment; width: number; height: number }): void => {
    const figure = document.createElement('div');
    figure.className = 'md-diagram-figure';
    figure.setAttribute('role', 'img');
    figure.setAttribute('aria-label', strings.chat.diagram.label);
    figure.dataset.testid = 'diagram';
    figure.append(drawn.fragment);
    const bar = drawnBar(element, source, strings.chat.diagram.showDiagram);
    if (options().onenlarge) {
      const open = button(strings.chat.diagram.enlarge, 'diagram-enlarge');
      open.addEventListener('click', () => options().onenlarge?.(viewerItem(figure)));
      bar.append(open);
    }
    element.prepend(bar);
    code?.before(figure);
    element.classList.add('md-drawn');
  };

  const known = diagrams.get(key);
  if (known) { put(known); return; }
  void loadDiagrams().then(
    module => module.renderDiagram(source, width, font).then(
      drawn => put(diagrams.set(key, { fragment: drawn.svg, width: drawn.width, height: drawn.height })),
      error => showSource(element, source, fill(strings.chat.diagram.failed, { reason: reason(error) }))
    ),
    () => showSource(element, source, strings.chat.diagram.unavailable)
  );
}

/**
 * A ```view block: its HTML as a page the owning machine serves
 * (`artifacts.viewBlock`), loaded under the placeholder and shown once it says
 * it is up (`lib/view-block.ts`). Without a machine to ask it stays code.
 */
function drawView(element: HTMLElement, options: () => RichMarkdownOptions): void {
  const source = element.dataset.source ?? '';
  const resolve = options().viewBlock;
  if (!resolve) { showSource(element, source, strings.chat.viewBlock.unavailable); return; }
  const known = knownViewHeight(source);
  // The placeholder stands at the height the page last had, so a scroll that mounts it again does not jump.
  if (known) element.style.setProperty('--drawing-height', `${known}px`);
  const stage = document.createElement('div');
  stage.className = 'md-view-stage';
  stage.style.setProperty('--bleed', `${VIEW_BLEED}px`);
  const failed = (why: string): void => {
    stage.remove();
    element.querySelector(':scope > .md-diagram-bar')?.remove();
    delete element.dataset.view;
    showSource(element, source, fill(strings.chat.viewBlock.failed, { reason: why }));
  };
  void resolve(source).then((answer) => {
    if (!answer.ok) { failed(answer.error); return; }
    // A render dropped the block while its address was on the way.
    if (!element.isConnected) return;
    element.prepend(stage);
    mountViewFrame(stage, answer.value, source, {
      ready: () => {
        element.style.removeProperty('--drawing-height');
        element.prepend(drawnBar(element, source, strings.chat.viewBlock.showView));
        element.classList.add('md-drawn');
      },
      failed
    });
  }, (error: unknown) => failed(reason(error)));
}

/** The bar of a drawn block: a toggle between the drawing and its code, then copy. The drawing shows first. */
function drawnBar(element: HTMLElement, source: string, showDrawing: string): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'md-diagram-bar';
  const toggle = button(strings.chat.diagram.showCode, 'diagram-toggle');
  toggle.setAttribute('aria-pressed', 'false');
  toggle.addEventListener('click', () => {
    const showing = element.dataset.view === 'code';
    element.dataset.view = showing ? 'diagram' : 'code';
    toggle.textContent = showing ? strings.chat.diagram.showCode : showDrawing;
    toggle.setAttribute('aria-pressed', String(!showing));
  });
  bar.append(toggle, copyButton(source));
  element.dataset.view = 'diagram';
  return bar;
}

/** A block that could not be drawn: its code under a copy button, and one quiet line that says why. */
function showSource(element: HTMLElement, source: string, message: string): void {
  const bar = document.createElement('div');
  bar.className = 'md-diagram-bar';
  bar.append(copyButton(source));
  const line = document.createElement('p');
  line.className = 'md-diagram-error';
  line.dataset.testid = 'diagram-error';
  line.textContent = message;
  element.prepend(bar);
  element.append(line);
  element.classList.add('md-diagram-failed', 'md-drawn', 'md-source');
}

function copyButton(source: string): HTMLButtonElement {
  const copy = button(strings.common.copy, 'diagram-copy');
  const reset = (): void => { copy.textContent = strings.common.copy; };
  copy.addEventListener('click', () => {
    const copied = (): void => { copy.textContent = strings.chat.copied; };
    // A page served over plain HTTP, a phone on the LAN, has no clipboard API.
    if (!navigator.clipboard) { if (copyByCommand(source)) copied(); return; }
    navigator.clipboard.writeText(source).then(copied, () => { if (copyByCommand(source)) copied(); else reset(); });
  });
  copy.addEventListener('pointerleave', reset);
  copy.addEventListener('blur', reset);
  return copy;
}

function button(label: string, testId: string): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = 'ghost small';
  control.textContent = label;
  control.dataset.testid = testId;
  return control;
}
function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Pele's messages start with the kind of error the line already says.
  return text.replace(/^Parse error:/i, '').split('\n')[0]!.trim();
}

/** The colors a drawn diagram takes from the page, written into the picture so it keeps them on its own. */
const DIAGRAM_COLORS = ['--pele-bg', '--pele-fg', '--pele-muted', '--pele-line', '--pele-surface', '--pele-surface-alt', '--pele-border', '--pele-accent', '--pele-critical', '--pele-error', '--pele-font', '--pele-font-mono', '--pele-radius', ...Array.from({ length: 8 }, (_, index) => `--pele-series-${index + 1}`)];

/** The diagram as an SVG file for the viewer, in the colors it has on screen now. */
export function viewerItem(figure: HTMLElement): MediaItem {
  const svg = figure.querySelector('svg')!.cloneNode(true) as SVGSVGElement;
  const style = getComputedStyle(figure);
  const colors = DIAGRAM_COLORS.map(name => [name, style.getPropertyValue(name).trim()] as const).filter(([, value]) => value).map(([name, value]) => `${name}:${value}`);
  const background = style.getPropertyValue('--pele-bg').trim();
  svg.setAttribute('style', [...colors, svg.getAttribute('style') ?? '', background ? `background:${background}` : ''].filter(Boolean).join(';'));
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
  return { src: URL.createObjectURL(blob), name: `${strings.chat.diagram.label}.svg`, mimeType: 'image/svg+xml', kind: 'image' };
}

/**
 * Copies `text` the older way, which needs no secure page: the copy command
 * takes the selection, so a field off screen holds the text, selected. Safari
 * copies only from a selection, not from a copy event's own data.
 */
function copyByCommand(text: string): boolean {
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement('textarea');
  field.className = 'md-copy-field';
  field.value = text;
  // Read-only, so focusing it on a phone opens no keyboard; it can still be selected and copied.
  field.readOnly = true;
  field.setAttribute('aria-hidden', 'true');
  document.body.append(field);
  field.focus({ preventScroll: true });
  field.setSelectionRange(0, text.length);
  try {
    return document.execCommand?.('copy') ?? false;
  } catch {
    return false;
  } finally {
    field.remove();
    before?.focus({ preventScroll: true });
  }
}

const BLOCKS = new Set(['p', 'div', 'li', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'ul', 'ol', 'hr']);
/** Blocks a blank line separates in Markdown. */
const SPACED = new Set(['p', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol']);

/** Puts the source of every drawing the selection touches on the clipboard, and leaves any other copy alone. */
export function copySource(node: HTMLElement, event: ClipboardEvent): void {
  const selection = node.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !event.clipboardData) return;
  const range = selection.getRangeAt(0);
  if (!node.contains(range.commonAncestorContainer)) return;
  const touched = [...node.querySelectorAll('.md-drawn')].some(element => range.intersectsNode(element));
  if (!touched) return;
  event.clipboardData.setData('text/plain', selectedSource(range));
  event.preventDefault();
}

/**
 * The text of a selection with each drawing it touches as its source: a
 * formula as written with its delimiters, a diagram or a view as its fenced block. A
 * selection that starts or ends inside a drawing takes the whole of it.
 */
export function selectedSource(range: Range): string {
  const whole = range.cloneRange();
  const start = drawingOf(range.startContainer);
  if (start) whole.setStartBefore(start);
  const end = drawingOf(range.endContainer);
  if (end) whole.setEndAfter(end);
  const fragment = whole.cloneContents();
  for (const element of fragment.querySelectorAll<HTMLElement>('.md-math, .md-mermaid, .md-view')) {
    const source = element.dataset.source ?? '';
    const fence = element.classList.contains('md-mermaid') ? 'mermaid' : element.classList.contains('md-view') ? 'view' : '';
    const text = fence ? `\`\`\`${fence}\n${source}\n\`\`\`` : source;
    element.replaceWith(element.localName === 'div' ? blockOf(text) : document.createTextNode(text));
  }
  return plainText(fragment).replace(/\n{3,}/g, '\n\n').trim();
}

/** A drawing that was a block stays one in the copied text. */
function blockOf(text: string): HTMLParagraphElement {
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  return paragraph;
}

function drawingOf(at: Node): Element | null {
  const element = at instanceof Element ? at : at.parentElement;
  return element?.closest('.md-math, .md-mermaid, .md-view') ?? null;
}

/** Text with the line breaks its blocks imply: `textContent` would run two paragraphs together. */
function plainText(root: Node): string {
  let out = '';
  const walk = (current: Node): void => {
    if (current.nodeType === Node.TEXT_NODE) { out += current.nodeValue ?? ''; return; }
    if (!(current instanceof Element) && current.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    const name = current instanceof Element ? current.localName : '';
    if (name === 'br') { out += '\n'; return; }
    const block = BLOCKS.has(name);
    if (block && out && !out.endsWith('\n')) out += '\n';
    for (const child of current.childNodes) walk(child);
    if (name === 'td' || name === 'th') out += '\t';
    if (block && !out.endsWith('\n')) out += '\n';
    if (SPACED.has(name)) out += '\n';
  };
  walk(root);
  return out;
}
