/* Shared by the iframe bridge and the shell's child webview injection.
 * This function returns a cleanup function and has no host privileges. */
export default function installPreviewPicker(doc, emit) {
  const win = doc.defaultView;
  const marker = doc.createElement('div');
  marker.setAttribute('aria-hidden', 'true');
  marker.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;outline:2px solid Highlight;background:transparent;display:none;';
  doc.documentElement.append(marker);
  function selector(element) {
    const parts = [];
    let current = element;
    while (current && parts.length < 8) {
      const tag = current.localName;
      if (current.id && win.CSS && win.CSS.escape) {
        parts.unshift('#' + win.CSS.escape(current.id));
        break;
      }
      const peers = current.parentElement ? Array.from(current.parentElement.children).filter(child => child.localName === tag) : [];
      parts.unshift(tag + (peers.length > 1 ? ':nth-of-type(' + (peers.indexOf(current) + 1) + ')' : ''));
      current = current.parentElement;
    }
    return parts.join(' > ').slice(0, 1000);
  }
  function move(event) {
    const target = event.composedPath()[0];
    if (!(target instanceof win.Element)) return;
    const rect = target.getBoundingClientRect();
    Object.assign(marker.style, { display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  }
  function cleanup() {
    marker.remove();
    doc.removeEventListener('pointermove', move, true);
    doc.removeEventListener('click', pick, true);
    doc.removeEventListener('keydown', key, true);
  }
  function pick(event) {
    const target = event.composedPath()[0];
    if (!(target instanceof win.Element)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = target.getBoundingClientRect();
    const selection = {
      url: doc.URL.slice(0, 4096),
      selector: selector(target),
      text: (target.innerText || target.textContent || '').trim().slice(0, 1000),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };
    cleanup();
    emit(selection);
  }
  function key(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cleanup();
    emit(null);
  }
  doc.addEventListener('pointermove', move, true);
  doc.addEventListener('click', pick, true);
  doc.addEventListener('keydown', key, true);
  return cleanup;
}
