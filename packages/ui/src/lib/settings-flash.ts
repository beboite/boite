/**
 * Scrolls a Settings card into view, `settings-<id>` in the DOM, and when a
 * settings card in a conversation pointed at it, rings it once in the accent
 * colour so the eye lands on it (`.settings-flash` in app.css). False when the
 * page has no such card.
 */
export function revealSettingsCard(id: string, flash: boolean, behavior: ScrollBehavior): boolean {
  const target = document.getElementById(`settings-${id}`);
  if (!target) return false;
  target.scrollIntoView({ behavior, block: 'start' });
  if (flash) {
    target.classList.remove('settings-flash');
    // Restart the animation when the same card is pointed at twice in a row.
    void target.offsetWidth;
    target.classList.add('settings-flash');
    target.addEventListener('animationend', () => target.classList.remove('settings-flash'), { once: true });
  }
  return true;
}
