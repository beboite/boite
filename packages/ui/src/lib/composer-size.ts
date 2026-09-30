/**
 * Whether the engine sizes the composer to its text itself
 * (`field-sizing: content`), in the frame's own layout. Elsewhere `fitHeight`
 * measures it, which lays the page out twice more inside every input event.
 * Asked once per composer, so a test can stand in an engine without it.
 */
export function selfSizing(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');
}

/** The box as tall as its text, up to `maxLines`. Reading the style before the auto write forces one layout, not two. */
export function fitHeight(box: HTMLTextAreaElement, maxLines: number): void {
  const line = parseFloat(getComputedStyle(box).lineHeight) || 20;
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, line * maxLines + 16)}px`;
}
