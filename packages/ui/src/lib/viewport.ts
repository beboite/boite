/** Keep the app and its overlays inside the part of the screen above the keyboard. */
export function startViewport(): () => void {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const mobile = window.matchMedia('(max-width: 720px)');
  let stopped = false;
  let frame = 0, settled = 0;
  const clearSize = () => {
    root.style.removeProperty('--app-height');
    root.style.removeProperty('--app-top');
  };
  const restoreSize = () => {
    clearSize();
    // WebKit 254868 also affects dvh in installed apps. vh includes the
    // notch area when the page owns it. A zero top inset can mean iOS has
    // reserved the status bar outside the page, so keep dvh in that case.
    if ((navigator as Navigator & { standalone?: boolean }).standalone === true
      && parseFloat(getComputedStyle(root).getPropertyValue('--safe-area-top')) > 0) {
      root.style.setProperty('--app-height', '100vh');
    }
  };
  const editing = () => {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement) return !active.readOnly && !active.disabled && active.inputMode !== 'none';
    if (active instanceof HTMLInputElement) {
      return !active.readOnly && !active.disabled && active.inputMode !== 'none'
        && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(active.type);
    }
    return active instanceof HTMLElement && active.isContentEditable;
  };
  const update = () => {
    if (stopped) return;
    if (!mobile.matches) {
      clearSize();
      delete root.dataset.keyboard;
      return;
    }
    // Only a focused editor and a keyboard-sized reduction use the visual
    // viewport. Otherwise restore the height appropriate to the display mode.
    const keyboard = viewport && editing() && Math.abs((viewport.scale ?? 1) - 1) < 0.01
      && window.innerHeight - viewport.height > 120;
    if (keyboard) {
      // Use the visible area reported by the browser. An additional form-bar
      // allowance leaves a second gap above the iPhone keyboard.
      root.style.setProperty('--app-height', `${Math.max(0, viewport.height)}px`);
      root.style.setProperty('--app-top', `${Math.max(0, viewport.offsetTop)}px`);
    } else restoreSize();
    root.dataset.keyboard = keyboard ? 'open' : 'closed';
  };
  const refresh = () => {
    update();
    cancelAnimationFrame(frame);
    clearTimeout(settled);
    // WebKit 237851 can publish offsetTop after the resize event, without
    // another event. Re-read after layout and after the keyboard animation.
    frame = requestAnimationFrame(() => { update(); frame = requestAnimationFrame(update); });
    settled = window.setTimeout(update, 300);
  };
  // focusout still reports the old activeElement; read it after focus moves.
  const afterFocus = () => queueMicrotask(() => { if (!stopped) refresh(); });
  refresh();
  viewport?.addEventListener('resize', refresh);
  viewport?.addEventListener('scroll', refresh);
  window.addEventListener('resize', refresh);
  window.addEventListener('scroll', refresh);
  window.addEventListener('pageshow', refresh);
  document.addEventListener('focusin', refresh);
  document.addEventListener('focusout', afterFocus);
  document.addEventListener('visibilitychange', refresh);
  mobile.addEventListener('change', refresh);
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    clearTimeout(settled);
    viewport?.removeEventListener('resize', refresh);
    viewport?.removeEventListener('scroll', refresh);
    window.removeEventListener('resize', refresh);
    window.removeEventListener('scroll', refresh);
    window.removeEventListener('pageshow', refresh);
    document.removeEventListener('focusin', refresh);
    document.removeEventListener('focusout', afterFocus);
    document.removeEventListener('visibilitychange', refresh);
    mobile.removeEventListener('change', refresh);
    clearSize();
    delete root.dataset.keyboard;
  };
}
