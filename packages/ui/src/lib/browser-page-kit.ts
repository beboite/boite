/**
 * The script an agent command runs inside a browser surface's page, through
 * `Runtime.evaluate`. It speaks agent-browser's vocabulary: a snapshot lists
 * the page as an accessibility-style tree whose elements carry `[ref=eN]`,
 * and every command takes `@eN`, a CSS selector or `text=...`.
 *
 * The page is untrusted. The kit keeps its state on a symbol of the page's
 * window, never in the DOM, so the page's own markup and observers are left
 * alone, and returns plain data only.
 *
 * A surface the desktop does not display has no rendered frame. Chromium then
 * never acknowledges native mouse or text input and drops key events, so the
 * kit reports `hidden` and the caller acts through DOM events instead.
 */
const KIT = String.raw`(() => {
  const KEY = Symbol.for('boite.agent.v1');
  if (window[KEY]) return window[KEY];
  const K = { refs: new Map(), token: Math.random().toString(36).slice(2), leaving: false, agentAt: Date.now(), policy: { accept: true, text: null }, dialogs: [] };
  Object.defineProperty(window, KEY, { value: K, configurable: true });
  addEventListener('beforeunload', () => { K.leaving = true; }, true);
  // Dialogs answer at once while an agent acts on the page, so none opens over the desktop.
  const native = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
  const recent = () => Date.now() - K.agentAt < 60000;
  const note = (type, message, accepted, value) => { K.dialogs.push({ type, message: String(message ?? '').slice(0, 500), accepted, ...(value === undefined ? {} : { value }) }); if (K.dialogs.length > 20) K.dialogs.shift(); };
  window.alert = function (message) { if (!recent()) return native.alert.apply(this, arguments); note('alert', message, true); };
  window.confirm = function (message) { if (!recent()) return native.confirm.apply(this, arguments); note('confirm', message, K.policy.accept); return K.policy.accept; };
  window.prompt = function (message, fallback) {
    if (!recent()) return native.prompt.apply(this, arguments);
    const value = K.policy.accept ? (K.policy.text ?? fallback ?? '') : null;
    note('prompt', message, K.policy.accept, value); return value;
  };

  const IMPLICIT = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', IMG: 'img', NAV: 'navigation', MAIN: 'main', FORM: 'form', UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', DIALOG: 'dialog', IFRAME: 'iframe', OPTION: 'option', ASIDE: 'complementary' };
  const INPUT = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', number: 'spinbutton', search: 'searchbox', file: 'button' };
  const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);
  const STRUCTURE = new Set(['navigation', 'main', 'form', 'list', 'listitem', 'table', 'row', 'cell', 'columnheader', 'dialog', 'complementary', 'region', 'banner', 'contentinfo', 'group', 'tablist', 'menu', 'menubar', 'tree', 'grid']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'svg', 'SVG']);
  const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
  const role = el => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    if (el.tagName === 'INPUT') return INPUT[(el.type || 'text').toLowerCase()] ?? (el.type === 'hidden' ? null : 'textbox');
    if (el.tagName === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (el.tagName === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (el.tagName === 'IMG') return el.getAttribute('alt') ? 'img' : null;
    if (el.tagName === 'HEADER' && !el.closest('article,aside,main,nav,section')) return 'banner';
    if (el.tagName === 'FOOTER' && !el.closest('article,aside,main,nav,section')) return 'contentinfo';
    if (el.tagName === 'SECTION' && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))) return 'region';
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox';
    return IMPLICIT[el.tagName] ?? null;
  };
  const visible = el => {
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
    if (!el.getClientRects().length) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  };
  const boxed = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // A control styled away to nothing is operated through a label the user sees.
  const operable = el => (visible(el) && boxed(el)) || !el.labels ? el : Array.from(el.labels).find(label => visible(label) && boxed(label)) ?? el;
  const labelled = el => {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) { const text = ids.split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.innerText ?? '').join(' ').trim(); if (text) return text; }
    return '';
  };
  const name = (el, r) => {
    const aria = el.getAttribute('aria-label') || labelled(el);
    if (aria) return clip(aria, 100);
    if (el.tagName === 'IMG' || (el.tagName === 'INPUT' && el.type === 'image')) return clip(el.getAttribute('alt'), 100);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const label = el.labels?.[0] && (el.labels[0].innerText ?? el.labels[0].textContent);
      if (label) return clip(label, 100);
      if (['button', 'submit', 'reset'].includes(el.type)) return clip(el.value || (el.type === 'submit' ? 'Submit' : ''), 100);
      return clip(el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name'), 100);
    }
    if (r === 'iframe') return clip(el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('src'), 100);
    // A container's text is listed under it; repeating it as a name doubles the snapshot.
    if (STRUCTURE.has(r) && r !== 'columnheader') return clip(el.getAttribute('title'), 100);
    const text = clip(el.innerText || el.textContent, 100);
    if (text) return text;
    // An icon link or button: the image's alt or the SVG's title says what it is.
    const inner = el.querySelector('img[alt],[aria-label],svg title');
    return clip(inner?.getAttribute('alt') || inner?.getAttribute('aria-label') || inner?.textContent || el.getAttribute('title'), 100);
  };
  const checked = el => el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true';
  const describe = (el, r, ref, opts) => {
    const n = name(el, r);
    let line = r + (n ? ' ' + JSON.stringify(n) : '');
    if (ref) line += ' [ref=' + ref + ']';
    if (r === 'heading') line += ' [level=' + (Number(el.getAttribute('aria-level')) || Number(el.tagName.slice(1)) || 2) + ']';
    if (r === 'checkbox' || r === 'radio' || r === 'switch' || r === 'menuitemcheckbox' || r === 'menuitemradio') line += checked(el) ? ' [checked]' : ' [unchecked]';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' [disabled]';
    const expanded = el.getAttribute('aria-expanded'); if (expanded) line += ' [expanded=' + expanded + ']';
    if (el.getAttribute('aria-selected') === 'true' || (r === 'tab' && el.getAttribute('aria-current'))) line += ' [selected]';
    if (opts.urls && r === 'link' && el.href) line += ' [url=' + el.href + ']';
    if (el.tagName === 'SELECT') {
      const options = Array.from(el.options);
      line += ': ' + JSON.stringify(clip(Array.from(el.selectedOptions).map(o => o.text).join(', '), 80));
      line += ' [options=' + JSON.stringify(options.slice(0, 25).map(o => clip(o.text, 40))) + (options.length > 25 ? ' +' + (options.length - 25) : '') + ']';
    } else if ((r === 'textbox' || r === 'searchbox' || r === 'spinbutton' || r === 'slider') && el.tagName !== 'DIV') {
      const value = el.type === 'password' ? (el.value ? '••••' : '') : el.isContentEditable ? el.innerText : el.value;
      if (value) line += ': ' + JSON.stringify(clip(value, 120));
      else if (el.getAttribute('placeholder') && n !== clip(el.getAttribute('placeholder'), 100)) line += ' [placeholder=' + JSON.stringify(clip(el.getAttribute('placeholder'), 60)) + ']';
    }
    return line;
  };

  K.snapshot = (opts = {}) => {
    K.agentAt = Date.now(); K.refs = new Map(); let n = 0;
    const out = []; let size = 0; const MAX = opts.maxChars || 40000; let truncated = false;
    const emit = (depth, text) => {
      if (truncated) return;
      const line = '  '.repeat(opts.interactive ? 0 : depth) + '- ' + text;
      if (size + line.length > MAX) { truncated = true; return; }
      out.push(line); size += line.length + 1;
    };
    let pending = [], pendingDepth = 0;
    const flush = () => { if (pending.length) { emit(pendingDepth, 'text: ' + clip(pending.join(' '), 400)); pending = []; } };
    const walk = (node, depth) => {
      if (truncated) return;
      if (node.nodeType === 3) {
        if (opts.interactive) return;
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (t && node.parentElement && visible(node.parentElement)) { if (!pending.length) pendingDepth = depth; pending.push(t); }
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 11) { for (const child of node.childNodes) walk(child, depth); return; }
      const el = node;
      if (SKIP.has(el.tagName) || el.getAttribute('aria-hidden') === 'true') return;
      const r = role(el);
      const isVisible = visible(el);
      // A checkbox or radio styled away behind its label stays reachable through it.
      const viaLabel = !isVisible && (r === 'checkbox' || r === 'radio') && Array.from(el.labels ?? []).some(visible);
      if (!isVisible && !viaLabel && (!el.children.length || getComputedStyle(el).display === 'none')) return;
      if (isVisible || viaLabel) {
        if (r && (INTERACTIVE.has(r) || r === 'heading' || (!opts.interactive && (r === 'img' || r === 'iframe')))) {
          flush();
          const ref = INTERACTIVE.has(r) || r === 'heading' || r === 'iframe' ? 'e' + (++n) : null;
          if (ref) K.refs.set(ref, new WeakRef(el));
          emit(depth, describe(el, r, ref, opts));
          if (r === 'iframe') {
            let doc = null; try { doc = el.contentDocument; } catch {}
            if (doc?.body && (!opts.depth || depth + 1 < opts.depth)) walk(doc.body, depth + 1);
          }
          // Links and buttons can wrap headings or fields; those stay reachable.
          if (r === 'link' || r === 'button' || r === 'listitem' || r === 'option' || r === 'tab' || r === 'menuitem' || r === 'treeitem') {
            for (const child of el.querySelectorAll('input,select,textarea,h1,h2,h3,h4,h5,h6,[role=checkbox],[role=textbox]')) walk(child, depth + 1);
          }
          return;
        }
        if (r && STRUCTURE.has(r) && !opts.interactive && !opts.compact && (!opts.depth || depth < opts.depth)) {
          flush();
          const at = out.length;
          emit(depth, describe(el, r, null, opts));
          const before = out.length;
          for (const child of el.childNodes) walk(child, depth + 1);
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
          flush();
          // An empty container says nothing.
          if (out.length === before && !truncated) { size -= out[at].length + 1; out.splice(at, 1); }
          return;
        }
      }
      for (const child of el.childNodes) walk(child, depth);
      if (el.shadowRoot) walk(el.shadowRoot, depth);
    };
    const roots = opts.selector ? Array.from(document.querySelectorAll(opts.selector)) : [document.body ?? document.documentElement];
    if (opts.selector && !roots.length) throw new Error('no element matches ' + opts.selector);
    for (const root of roots) walk(root, 0);
    flush();
    if (truncated) out.push('- note: snapshot truncated at ' + MAX + ' characters; use snapshot -i, -s <selector> or -d <depth>');
    if (!out.length) out.push(document.readyState === 'loading' ? '- note: the page is still loading' : '- note: no visible content');
    return { text: out.join('\n'), refs: n };
  };

  K.find = target => {
    K.agentAt = Date.now();
    const t = String(target).trim();
    const ref = /^@?(e\d+)$/.exec(t);
    if (ref) {
      const weak = K.refs.get(ref[1]);
      if (!weak) throw new Error(K.refs.size ? 'unknown ref @' + ref[1] + '; take a new snapshot' : 'ref @' + ref[1] + ' belongs to an earlier page: this one has no snapshot yet; take one');
      const el = weak.deref();
      if (!el || !el.isConnected) throw new Error('ref @' + ref[1] + ' is stale because the page changed; take a new snapshot');
      return el;
    }
    if (/^text=/.test(t)) {
      const wanted = t.slice(5).replace(/^"(.*)"$/, '$1').toLowerCase();
      const all = Array.from(document.querySelectorAll('a,button,input,select,textarea,summary,label,[role],h1,h2,h3,h4,h5,h6,li,td,span,div,p')).filter(el => visible(el) && clip((el.innerText ?? el.textContent) || el.value, 400).toLowerCase().includes(wanted));
      // The innermost match: the element whose own text matched, not every ancestor.
      const inner = all.filter(el => !all.some(other => other !== el && el.contains(other)));
      if (!inner.length) throw new Error('no visible element contains the text ' + JSON.stringify(wanted));
      return inner[0];
    }
    let nodes;
    try { nodes = document.querySelectorAll(t); } catch { throw new Error('invalid selector ' + JSON.stringify(t) + '; use @eN from snapshot, a CSS selector or text=...'); }
    if (nodes.length !== 1) throw new Error('selector must match exactly one element; matched ' + nodes.length + '. Use @eN from snapshot or a more specific selector');
    return nodes[0];
  };

  K.state = () => ({ url: location.href, title: document.title, ready: document.readyState, hidden: document.visibilityState === 'hidden', token: K.token, leaving: K.leaving, dialogs: K.dialogs.length });
  K.dialogsSince = count => K.dialogs.slice(count);

  // Where to send native input, or null when the page must be driven through the DOM.
  K.point = async (target, mode) => {
    let el = K.find(target);
    if (el.disabled && mode !== 'hover') throw new Error('element is disabled');
    const typing = mode === 'fill' || mode === 'type';
    if (typing && !(el.matches('input,textarea') || el.isContentEditable)) throw new Error('element does not accept text');
    if (typing && el.readOnly) throw new Error('element is read-only');
    el = operable(el);
    if (document.visibilityState === 'hidden') return null;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    // Native input lands on the composited page, which can lag behind DOM scrolling.
    await new Promise(resolve => { const done = setTimeout(resolve, 120); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(done); resolve(); })); });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || !visible(el)) throw new Error('element is not visible');
    const x = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    const reached = hit && (el.contains(hit) || (hit.tagName === 'LABEL' && hit.control === el) || (el.tagName === 'LABEL' && el.control === hit));
    if (typing) {
      el.focus();
      if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); if (mode === 'type') range.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
      else if (mode === 'type') { const end = el.value.length; try { el.setSelectionRange(end, end); } catch {} }
      else if (typeof el.select === 'function') el.select();
    }
    // A covered element is driven through the DOM rather than clicking what covers it.
    return reached || typing ? { x, y } : { x, y, covered: hit ? clip(hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + ' ' + (hit.innerText ?? ''), 60) : 'nothing at its center' };
  };

  const fire = (el, type, init = {}) => el.dispatchEvent(new (type.startsWith('pointer') ? (window.PointerEvent ?? MouseEvent) : type.startsWith('key') ? KeyboardEvent : type === 'input' ? (window.InputEvent ?? Event) : type === 'change' ? Event : MouseEvent)(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  const setValue = (el, value) => {
    if (el.isContentEditable) { el.textContent = value; }
    else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    }
    fire(el, 'input', { inputType: 'insertText', data: value }); fire(el, 'change');
  };
  const domClick = (el, count) => {
    el = operable(el);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    for (let i = 1; i <= count; i++) {
      fire(el, 'pointerover'); fire(el, 'mouseover'); fire(el, 'pointerdown', { detail: i, buttons: 1 }); fire(el, 'mousedown', { detail: i, buttons: 1 });
      if (typeof el.focus === 'function') el.focus();
      fire(el, 'pointerup', { detail: i }); fire(el, 'mouseup', { detail: i });
      el.click();
    }
    if (count === 2) fire(el, 'dblclick', { detail: 2 });
  };
  const KEYCODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 };
  const focusable = () => Array.from(document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[tabindex],[contenteditable=true]')).filter(el => !el.disabled && el.tabIndex >= 0 && visible(el));

  // DOM-level actions: the same effects, as events the page receives without a rendered frame.
  K.dom = (kind, target, arg) => {
    K.agentAt = Date.now();
    if (kind === 'press') {
      const parts = arg.split('+'); const last = parts.pop(); const key = last === 'Space' ? ' ' : last;
      const mods = { ctrlKey: parts.some(p => /^(control|ctrl)$/i.test(p)), altKey: parts.some(p => /^alt$/i.test(p)), shiftKey: parts.some(p => /^shift$/i.test(p)), metaKey: parts.some(p => /^(meta|cmd|command)$/i.test(p)) };
      const el = document.activeElement && document.activeElement !== document.documentElement ? document.activeElement : document.body;
      const keyCode = KEYCODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
      const init = { key, code: key.length === 1 ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /\d/.test(key) ? 'Digit' + key : key === ' ' ? 'Space' : '') : key, keyCode, which: keyCode, ...mods };
      const go = fire(el, 'keydown', init);
      if (go && key.length === 1 && !mods.ctrlKey && !mods.metaKey) fire(el, 'keypress', { ...init, charCode: key.charCodeAt(0) });
      if (go) {
        const field = el.matches?.('input,textarea') && !['checkbox', 'radio', 'button', 'submit'].includes(el.type);
        if (key === 'Enter') { if (el.tagName === 'INPUT' && el.form) el.form.requestSubmit(); else if (el.matches?.('a,button,summary,[role=button],[role=link]')) el.click(); else if (el.tagName === 'TEXTAREA') setValue(el, el.value + '\n'); }
        else if (key === 'Tab') { const list = focusable(); const at = list.indexOf(el); list[(at + (mods.shiftKey ? list.length - 1 : 1)) % list.length]?.focus(); }
        else if (key === 'Backspace' && field) setValue(el, el.value.slice(0, -1));
        else if (key === ' ' && el.matches?.('button,input[type=checkbox],input[type=radio],[role=button],[role=checkbox]')) el.click();
        else if ((key === 'ArrowDown' || key === 'ArrowUp') && el.tagName === 'SELECT') { el.selectedIndex = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + (key === 'ArrowDown' ? 1 : -1))); fire(el, 'input'); fire(el, 'change'); }
        else if (mods.ctrlKey && key.toLowerCase() === 'a' && field) el.select();
        else if (key.length === 1 && field && !mods.ctrlKey && !mods.metaKey) setValue(el, el.value + key);
      }
      fire(el, 'keyup', init);
      return true;
    }
    const el = K.find(target);
    switch (kind) {
      case 'click': domClick(el, arg || 1); return true;
      case 'hover': fire(el, 'pointerover'); fire(el, 'mouseover'); fire(el, 'mouseenter', { bubbles: false }); fire(el, 'mousemove'); return true;
      case 'fill': case 'type': {
        if (!(el.matches('input,textarea') || el.isContentEditable)) throw new Error('element does not accept text');
        if (el.readOnly || el.disabled) throw new Error('element is read-only or disabled');
        el.focus(); setValue(el, (kind === 'type' ? (el.isContentEditable ? el.innerText : el.value) : '') + arg); return true;
      }
      default: throw new Error('unknown DOM action ' + kind);
    }
  };

  K.value = target => { const el = K.find(target); return el.isContentEditable ? el.innerText : el.value; };
  K.checked = target => checked(K.find(target));
  K.select = (target, values) => {
    K.agentAt = Date.now();
    const el = K.find(target);
    if (el.tagName !== 'SELECT') throw new Error('select needs a <select> element; for a custom list, click it and then click the option');
    const wanted = values.map(v => String(v).trim());
    const options = Array.from(el.options);
    const picked = wanted.map(w => options.find(o => o.value === w) ?? options.find(o => o.text.trim() === w) ?? options.find(o => o.text.trim().toLowerCase() === w.toLowerCase()));
    const missing = wanted.filter((_, i) => !picked[i]);
    if (missing.length) throw new Error('no option ' + JSON.stringify(missing[0]) + '; options are ' + JSON.stringify(options.slice(0, 25).map(o => o.text.trim())));
    if (!el.multiple && picked.length > 1) throw new Error('this select takes one value');
    el.focus();
    for (const o of options) o.selected = picked.includes(o);
    fire(el, 'input'); fire(el, 'change');
    return Array.from(el.selectedOptions).map(o => o.text.trim());
  };
  K.get = (what, target, attr) => {
    K.agentAt = Date.now();
    switch (what) {
      case 'title': return document.title;
      case 'url': return location.href;
      case 'count': return document.querySelectorAll(target).length;
    }
    const el = target ? K.find(target) : document.body;
    switch (what) {
      case 'text': return (el.innerText ?? el.textContent ?? '').slice(0, 100000);
      case 'html': return el.innerHTML.slice(0, 200000);
      case 'value': return el.isContentEditable ? el.innerText : el.value ?? null;
      case 'attr': return el.getAttribute(attr);
      case 'box': { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }
      case 'visible': return visible(el);
      case 'enabled': return !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      case 'checked': return checked(el);
    }
    throw new Error('unknown property ' + what);
  };
  K.scroll = (x, y, target) => { K.agentAt = Date.now(); const el = target ? K.find(target) : null; if (el) el.scrollBy(x, y); else scrollBy(x, y); return { x: scrollX, y: scrollY }; };
  K.scrollIntoView = target => { K.find(target).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); return true; };
  K.focus = target => { K.find(target).focus(); return true; };
  const glob = pattern => new RegExp('^' + pattern.replace(/[.+^$(){}|[\]\\?]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
  K.met = spec => {
    if (spec.selector) { try { const el = K.find(spec.selector); return visible(el); } catch (error) { if (/stale|unknown ref/.test(String(error))) throw error; return false; } }
    if (spec.text) return (document.body?.innerText ?? '').includes(spec.text);
    if (spec.url) return glob(spec.url).test(location.href) || location.href.includes(spec.url);
    if (spec.load === 'domcontentloaded') return document.readyState !== 'loading';
    if (spec.load) return document.readyState === 'complete';
    return false;
  };
  K.resources = () => performance.getEntriesByType('resource').length;
  return K;
})()`;

/** An expression running `body` with the page's kit bound to `K`. */
export function kit(body: string): string {
  return `(async (K) => { ${body} })(${KIT})`;
}
