/** Focus and select an input the moment it appears, for inline rename fields. */
export function focusOnMount(node: HTMLInputElement | HTMLTextAreaElement): void {
  requestAnimationFrame(() => {
    node.focus();
    if ('select' in node) node.select();
  });
}
