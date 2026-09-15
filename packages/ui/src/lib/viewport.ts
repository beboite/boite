/** Keep the app and its overlays inside the part of the screen above the keyboard. */
export function startViewport(): () => void {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const mobile = window.matchMedia('(max-width: 720px)');
  const update = () => {
    if (!mobile.matches) {
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-top');
      delete root.dataset.keyboard;
      return;
    }
    const height = viewport?.height ?? window.innerHeight;
    root.style.setProperty('--app-height', `${height}px`);
    root.style.setProperty('--app-top', `${viewport?.offsetTop ?? 0}px`);
    root.dataset.keyboard = window.innerHeight - height > 120 ? 'open' : 'closed';
  };
  update();
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  mobile.addEventListener('change', update);
  return () => {
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    mobile.removeEventListener('change', update);
    root.style.removeProperty('--app-height');
    root.style.removeProperty('--app-top');
    delete root.dataset.keyboard;
  };
}
