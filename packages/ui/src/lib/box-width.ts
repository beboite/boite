/**
 * A box's inner width, told by one ResizeObserver once the browser has laid the
 * page out. `bind:clientWidth` hears the same observer but also reads the width
 * at once, inside the render that mounts the box: that read lays out everything
 * the render has built so far, and the rest of the render undoes it. A diff in
 * a row the timeline's window mounts mid-scroll paid a whole layout for it.
 */
const reports = new WeakMap<Element, (width: number) => void>();
let observer: ResizeObserver | undefined;

export function boxWidth(node: HTMLElement, report: (width: number) => void): { destroy?(): void } {
  if (typeof ResizeObserver === 'undefined') {
    report(node.clientWidth);
    return {};
  }
  // The layout is clean when the observer runs: reading the width there costs nothing.
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) reports.get(entry.target)?.((entry.target as HTMLElement).clientWidth);
  });
  reports.set(node, report);
  observer.observe(node);
  return {
    destroy() {
      observer?.unobserve(node);
      reports.delete(node);
    }
  };
}
