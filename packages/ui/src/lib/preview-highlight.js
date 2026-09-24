/* Runs in an accessible iframe or a native child view, without host privileges. */
export default function highlightPreviewElement(doc, reference, emit) {
  if (doc.URL !== reference.url) { emit('stale'); return; }
  try {
    let root = doc;
    for (const selector of reference.shadowPath || []) {
      root = root.querySelector(selector)?.shadowRoot;
      if (!root) { emit('missing'); return; }
    }
    const target = root.querySelector(reference.selector);
    if (!target) { emit('missing'); return; }
    doc.defaultView.__boiteClearPreviewHighlight?.();
    target.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const marker = doc.createElement('div');
    marker.setAttribute('data-boite-preview-highlight', reference.id);
    marker.setAttribute('aria-hidden', 'true');
    marker.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;outline:3px solid Highlight;background:transparent;';
    function update() {
      if (!target.isConnected) { cleanup(); return; }
      const rect = target.getBoundingClientRect();
      Object.assign(marker.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
    }
    function cleanup() {
      marker.remove();
      doc.removeEventListener('scroll', update, true);
      doc.defaultView.removeEventListener('resize', update);
      doc.defaultView.clearTimeout(timer);
      if (doc.defaultView.__boiteClearPreviewHighlight === cleanup) delete doc.defaultView.__boiteClearPreviewHighlight;
    }
    doc.documentElement.append(marker);
    const timer = doc.defaultView.setTimeout(cleanup, 3000);
    doc.defaultView.__boiteClearPreviewHighlight = cleanup;
    doc.addEventListener('scroll', update, true);
    doc.defaultView.addEventListener('resize', update);
    update();
    emit(null);
  } catch { emit('unavailable'); }
}
