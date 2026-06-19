// Move a node to document.body so `position: fixed` resolves against the
// viewport, not a transformed/clipping ancestor (e.g. the titlebar center
// wrapper uses a CSS transform, which would otherwise become the containing
// block for fixed descendants). The node returns nowhere on destroy: Svelte
// removes it.
export function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return {
    destroy() {
      if (node.parentElement === document.body) node.remove();
    },
  };
}
