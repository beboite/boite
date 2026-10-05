/*
 * The scripts the agent browser evaluates in a page. The page is untrusted
 * content: they return bounded text and selectors, never anything of the host.
 */

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
