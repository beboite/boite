/** Position an overlay without changing the page's layout. */
export function floating(node: HTMLElement, options: { anchor: () => HTMLElement | null; side?: 'right' }) {
  // The composer's glass blur establishes a containing block for fixed children.
  // The top layer keeps viewport coordinates valid without moving the DOM node,
  // so the picker's outside-click and keyboard handlers still own both menus.
  node.setAttribute('popover', 'manual');
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
    const height = window.innerHeight;
    let top: number;
    let left: number;
    if (options.side === 'right') {
      node.style.maxHeight = `${height - margin * 2}px`;
      left = box.right + gap;
      if (left + node.offsetWidth > width - margin) left = box.left - node.offsetWidth - gap;
      top = Math.min(box.top, height - node.offsetHeight - margin);
    } else {
      const below = height - box.bottom - gap - margin;
      const above = box.top - gap - margin;
      const ideal = Math.min(node.scrollHeight, 360, height * .45);
      const up = below < ideal && above > below;
      node.style.maxHeight = `${Math.max(0, Math.min(360, height * .45, up ? above : below))}px`;
      top = up ? box.top - gap - node.offsetHeight : box.bottom + gap;
      left = box.left;
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
  return { destroy() { observer.disconnect(); anchor?.removeEventListener('animationend', place); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); } };
}
