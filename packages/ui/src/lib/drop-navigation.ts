/** URL and text drops may edit a field, but must never replace the app's page. */
export function installDropNavigationGuard(root: HTMLElement): () => void {
  const guard = (event: DragEvent) => {
    const types = Array.from(event.dataTransfer?.types ?? []);
    if (!types.includes('text/plain') && !types.includes('text/uri-list')) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.isContentEditable) return;
    if ((target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(target.type))) &&
      !target.disabled && !target.readOnly) return;
    event.preventDefault();
  };
  root.addEventListener('dragover', guard);
  root.addEventListener('drop', guard);
  return () => {
    root.removeEventListener('dragover', guard);
    root.removeEventListener('drop', guard);
  };
}
