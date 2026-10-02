import type { SurfaceRect } from './browser-bridge';

/** Fit presentation to the slot while retaining the page's requested CSS size. */
export function fitBrowserViewport(slot: SurfaceRect, size: { width: number; height: number } | null): { rect: SurfaceRect; scale: number } {
  if (!size) return { rect: slot, scale: 1 };
  const scale = Math.min(1, slot.width / size.width, slot.height / size.height);
  const width = size.width * scale, height = size.height * scale;
  return { scale, rect: { x: slot.x + (slot.width - width) / 2, y: slot.y + (slot.height - height) / 2, width, height } };
}
