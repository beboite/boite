/*
 * The scripts the agent browser evaluates in a page. The page is untrusted
 * content: they return bounded text and selectors, never anything of the host.
 */

export const SNAPSHOT_SCRIPT = `(() => {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const selector = el => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el !== document.documentElement) {
      const tag = el.localName; const siblings = Array.from(el.parentElement?.children ?? []).filter(s => s.localName === tag);
      parts.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')' : ''));
      el = el.parentElement;
    }
    return 'html > ' + parts.join(' > ');
  };
  return { url: location.href, title: document.title, ready: document.readyState,
    viewport: { width: innerWidth, height: innerHeight }, text: (document.body?.innerText ?? '').slice(0, 20000),
    elements: Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')).filter(visible).slice(0, 150).map(el => ({ selector: selector(el), tag: el.localName, role: el.getAttribute('role'), label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || '').slice(0, 200), disabled: !!el.disabled })) };
})()`;

/** Scrolls one element into view and returns its center, refusing a hidden, covered or (for typing) non-text element. */
export function targetScript(selector: string, typing: boolean): string {
  return `(async () => {
    const nodes = document.querySelectorAll(${JSON.stringify(selector)});
    if (nodes.length !== 1) throw new Error('selector must match exactly one element; matched ' + nodes.length);
    const el = nodes[0];
    if (el.disabled || el.readOnly) throw new Error('element is disabled or read-only');
    el.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
    // Native input uses the composited page, which can lag behind DOM scrolling, and a viewport
    // that was just resized is still laying out: aim only once the element has stopped moving.
    let seen = '';
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const box = el.getBoundingClientRect();
      const now = [innerWidth, innerHeight, box.left, box.top, box.width, box.height].join();
      if (now === seen) break;
      seen = now;
    }
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (!r.width || !r.height || s.visibility === 'hidden') throw new Error('element is hidden');
    const x = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
    if (!el.contains(document.elementFromPoint(x,y))) throw new Error('element is covered by another element');
    ${typing ? `if (!el.matches('input,textarea,[contenteditable="true"]')) throw new Error('element does not accept text');
    el.focus(); if (typeof el.select === 'function') el.select(); else { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }` : ''}
    return {x, y};
  })()`;
}

/** Whether the focused element, through open shadow roots, takes typed text. */
export const EDITABLE_SCRIPT = `(() => { let e=document.activeElement; while(e?.shadowRoot?.activeElement)e=e.shadowRoot.activeElement; return !!e && !e.disabled && !e.readOnly && (e.matches('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),textarea') || e.isContentEditable); })()`;

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
