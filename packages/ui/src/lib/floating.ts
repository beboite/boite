import { mobileOverlay } from './mobile-history';
import { strings } from './strings';
import type { MenuFit } from './menu-fit';
/** Position desktop popovers at their anchor and phone menus above the keyboard. */
export function floating(node: HTMLElement, options: { anchor: () => HTMLElement | null; side?: 'right'; placement?: 'top' | 'bottom'; align?: 'start' | 'end'; sheet?: boolean; matchWidth?: boolean; cap?: number; fit?: (anchor: DOMRect, height: number, topInset: number, cap: number) => MenuFit; dismiss?: () => void }) {
  const mobile = window.matchMedia('(max-width: 720px)').matches;
  let backdrop: HTMLButtonElement | null = null;
  let backdropMotion: MutationObserver | null = null;
  let closeHistory = () => {};
  if (mobile && options.sheet !== false && options.dismiss) {
    backdrop = document.createElement('button');
    backdrop.className = 'mobile-sheet-backdrop';
    backdrop.setAttribute('popover', 'manual');
    backdrop.setAttribute('aria-label', strings.common.close);
    backdrop.onclick = options.dismiss;
    document.body.append(backdrop);
    backdrop.showPopover?.();
    backdropMotion = new MutationObserver(() => backdrop?.classList.toggle('closing', node.classList.contains('closing')));
    backdropMotion.observe(node, { attributes: true, attributeFilter: ['class'] });
    closeHistory = mobileOverlay(options.dismiss);
  }
  // The composer's glass blur establishes a containing block for fixed children.
  // The top layer keeps viewport coordinates valid without moving the DOM node,
  // so the picker's outside-click and keyboard handlers still own both menus.
  node.setAttribute('popover', 'manual');
  node.style.position = 'fixed';
  node.style.margin = '0';
  node.style.inset = 'auto';
  node.showPopover?.();
  const gap = 6;
  const margin = 12;
  function place() {
    const anchor = options.anchor();
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    const width = window.innerWidth;
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    const offset = viewport?.offsetTop ?? 0;
    if (mobile && options.sheet !== false) {
      node.dataset.mobileSheet = 'true';
      node.style.width = `${width - margin * 2}px`;
      node.style.maxHeight = `${Math.max(0, height - margin * 2) * .75}px`;
      node.style.top = `${Math.max(offset + margin, offset + height - node.offsetHeight - margin)}px`;
      node.style.left = `${margin}px`;
      node.style.transformOrigin = 'bottom center';
      return;
    }
    let top: number;
    let left: number;
    if (options.matchWidth) node.style.width = `${Math.min(options.cap ?? 420, box.width, width - margin * 2)}px`;
    if (options.side === 'right') {
      node.style.maxHeight = `${height - margin * 2}px`;
      left = box.right + gap;
      if (left + node.offsetWidth > width - margin) left = box.left - node.offsetWidth - gap;
      top = Math.min(box.top, height - node.offsetHeight - margin);
    } else {
      const below = height - box.bottom - gap - margin;
      const ceiling = Math.max(margin, document.querySelector('.titlebar')?.getBoundingClientRect().bottom ?? 0);
      const above = box.top - gap - ceiling;
      const cap = options.cap ?? Math.min(360, height * .45);
      const ideal = Math.min(node.scrollHeight, cap);
      const fit = options.fit?.(box, height, document.querySelector('.titlebar')?.getBoundingClientRect().bottom ?? 0, cap);
      const up = fit ? !fit.below : options.placement === 'top' ? above >= ideal || above > below : below < ideal && above > below;
      node.style.maxHeight = `${fit?.maxHeight ?? Math.max(0, Math.min(cap, up ? above : below))}px`;
      top = up ? box.top - gap - node.offsetHeight : box.bottom + gap;
      left = options.align === 'end' ? box.right - node.offsetWidth : box.left;
      node.dataset.direction = up ? 'up' : 'down';
      node.style.transformOrigin = up ? 'bottom left' : 'top left';
    }
    node.style.top = `${Math.max(margin, top)}px`;
    node.style.left = `${Math.max(margin, Math.min(left, width - node.offsetWidth - margin))}px`;
  }
  const observer = new ResizeObserver(place);
  observer.observe(node);
  const anchor = options.anchor();
  if (anchor) observer.observe(anchor);
  anchor?.addEventListener('animationend', place);
  place();
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  window.visualViewport?.addEventListener('resize', place);
  window.visualViewport?.addEventListener('scroll', place);
  return { destroy() { closeHistory(); backdropMotion?.disconnect(); backdrop?.remove(); observer.disconnect(); anchor?.removeEventListener('animationend', place); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place); } };
}
