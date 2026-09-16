/** A browser Back dismisses the top mobile panel before leaving the conversation. */
export function mobileOverlay(close: () => void): () => void {
  if (!window.matchMedia('(max-width: 720px)').matches) return () => {};
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  history.pushState({ ...history.state, boiteOverlay: id }, '');
  const back = () => {
    if (history.state?.boiteOverlay !== id) close();
  };
  window.addEventListener('popstate', back);
  return () => {
    window.removeEventListener('popstate', back);
    if (history.state?.boiteOverlay === id) history.back();
  };
}
