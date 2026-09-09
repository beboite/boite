/** Focus and select an input the moment it appears, for inline rename fields. */
export function focusOnMount(node: HTMLInputElement | HTMLTextAreaElement): void {
  requestAnimationFrame(() => {
    node.focus();
    if ('select' in node) node.select();
  });
}

/**
 * An entrance that plays once per key and never again, the way `MessageList`
 * gates its messages: a second element minted for the same key, because a
 * status ticked or a list was rebuilt, opens with the animation off.
 *
 * One set per call, so two lists never share a key space:
 *
 *     const rise = riseOnce();
 *     <li use:rise={thread.id}>
 */
export function riseOnce(): (node: HTMLElement, key: string) => void {
  const seen = new Set<string>();
  return (node, key) => {
    if (seen.has(key)) node.style.animation = 'none';
    else seen.add(key);
  };
}
