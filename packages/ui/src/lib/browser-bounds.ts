import type { SurfaceRect } from './browser-bridge';
import { currentZoom, subscribeZoom } from './zoom';

/** Measure when the layout changes. Keep following finite layout animations until they settle. */
export function watchBrowserBounds(node: HTMLElement, send: (rect: SurfaceRect | null, covered: boolean) => void): () => void {
  const doc = node.ownerDocument;
  const win = doc.defaultView!;
  let frame = 0;
  let last = '';
  let closed = false;
  const geometry = /^(?:transform|translate|scale|width|height|maxWidth|maxHeight|minWidth|minHeight|left|right|top|bottom|margin.*|padding.*|gridTemplate.*|flex.*|zoom)$/;
  function moving(): boolean {
    return doc.getAnimations?.().some(animation => animation.playState === 'running'
      && animation.effect?.getTiming().iterations !== Infinity
      && animation.effect instanceof KeyframeEffect
      && animation.effect.getKeyframes().some(keyframe => Object.keys(keyframe).some(key => geometry.test(key)))) ?? false;
  }
  function report(): void {
    frame = 0;
    if (closed || doc.hidden) return;
    const rect = node.getBoundingClientRect();
    // Native child webviews paint above the document's top layer. Park them
    // while a menu/dialog overlaps, including its closing animation.
    const covered = [...doc.querySelectorAll<HTMLElement>(':popover-open,dialog[open],[role="dialog"],[role="menu"],[role="listbox"]')].some(overlay => {
      const box = overlay.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && win.getComputedStyle(overlay).visibility !== 'hidden'
        && box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top;
    });
    const key = `${rect.x},${rect.y},${rect.width},${rect.height},${currentZoom()},${covered}`;
    if (key !== last) {
      last = key;
      send({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }, covered);
    }
    if (typeof win.requestAnimationFrame === 'function' && moving()) schedule();
  }
  function schedule(): void {
    if (closed || doc.hidden || frame) return;
    if (typeof win.requestAnimationFrame === 'function') frame = win.requestAnimationFrame(report);
    else report();
  }
  function visibility(): void {
    if (doc.hidden) {
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
      send(null, false);
      last = '';
    } else schedule();
  }
  const resize = new ResizeObserver(schedule);
  for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) resize.observe(parent);
  // Class and style changes cover sidebar folding, panel dragging and overlay placement.
  // Ignore bridge-owned frames, whose bounds are updated by send itself.
  const mutations = new MutationObserver(records => {
    if (records.some(record => !(record.target instanceof HTMLIFrameElement))) schedule();
  });
  mutations.observe(doc.documentElement, { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'style', 'open'] });
  win.addEventListener('resize', schedule);
  doc.addEventListener('scroll', schedule, true);
  doc.addEventListener('transitionrun', schedule, true);
  doc.addEventListener('animationstart', schedule, true);
  doc.addEventListener('visibilitychange', visibility);
  doc.addEventListener('toggle', schedule, true);
  const offZoom = subscribeZoom(schedule);
  report();
  return () => {
    closed = true;
    if (frame) win.cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    offZoom();
    win.removeEventListener('resize', schedule);
    doc.removeEventListener('scroll', schedule, true);
    doc.removeEventListener('transitionrun', schedule, true);
    doc.removeEventListener('animationstart', schedule, true);
    doc.removeEventListener('visibilitychange', visibility);
    doc.removeEventListener('toggle', schedule, true);
    send(null, false);
  };
}
