/*
 * The scripts the agent browser evaluates in a page. The page is untrusted
 * content: they return bounded text and selectors, never anything of the host.
 */

/** Whether the focused element, through open shadow roots, takes typed text. */
export const EDITABLE_SCRIPT = `(() => { let e=document.activeElement; while(e?.shadowRoot?.activeElement)e=e.shadowRoot.activeElement; return !!e && !e.disabled && !e.readOnly && (e.matches('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),textarea') || e.isContentEditable); })()`;

/**
 * The text a person at the page would copy, at most `max` characters and one
 * more when it was longer: the selection of the focused field, else the
 * document's, through open shadow roots and same-origin frames. A password
 * field answers nothing, as its own copy does.
 */
export const selectionScript = (max: number) => `(() => {
  let doc = document, e = doc.activeElement;
  for (let i = 0; i < 20 && e; i++) {
    if (e.shadowRoot?.activeElement) e = e.shadowRoot.activeElement;
    else if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') { let inner = null; try { inner = e.contentDocument; } catch {} if (!inner) break; doc = inner; e = doc.activeElement; }
    else break;
  }
  let text = '';
  if (e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA')) {
    if (e.type === 'password') return '';
    try { if (typeof e.selectionStart === 'number' && typeof e.selectionEnd === 'number') text = e.value.slice(e.selectionStart, e.selectionEnd); } catch {}
  }
  if (!text) text = String(doc.getSelection?.() ?? '');
  return text.slice(0, ${max + 1});
})()`;

/** The page a viewer's coordinates refer to: a tap on a frame of another page or size is refused. */
export const PAGE_INFO_SCRIPT = '({width:innerWidth,height:innerHeight,title:document.title,href:location.href,origin:performance.timeOrigin,dpr:devicePixelRatio||1})';

export const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38 } as const;

/** Resolves once the page's viewport has held one size for two frames, and returns it: a resize is not instant. */
export const SETTLED_VIEWPORT_SCRIPT = `(async () => {
  let seen = '';
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const now = innerWidth + 'x' + innerHeight;
    if (now === seen) break;
    seen = now;
  }
  return { width: innerWidth, height: innerHeight };
})()`;
