// Experimental opt-in kit. Not injected into Boite pages and not a stable API.
(() => {
  const french = () => document.documentElement.lang.toLowerCase().startsWith('fr');
  const label = (en, fr) => french() ? fr : en;
  const ready = (run) => document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', run, { once: true }) : run();
  const button = (text, run) => {
    const node = document.createElement('button'); node.type = 'button';
    node.textContent = text; node.addEventListener('click', run); return node;
  };

  class Compare extends HTMLElement {
    connectedCallback() { ready(() => { if (this.isConnected && !this.initialized) this.init(); }); }
    init() {
      this.initialized = true;
      this.images = [...this.children].filter(node => node.tagName === 'IMG');
      if (this.images.length !== 2) throw Error('view-compare expects exactly two images');
      this.frame = document.createElement('div'); this.frame.className = 'view-compare-frame';
      this.images.forEach(node => this.frame.append(node)); this.append(this.frame);
      this.line = document.createElement('span'); this.line.className = 'view-compare-line';
      this.line.setAttribute('aria-hidden', 'true'); this.frame.append(this.line);
      this.range = document.createElement('input'); this.range.type = 'range';
      this.range.min = '0'; this.range.max = '100'; this.range.value = '50';
      this.range.setAttribute('aria-label', this.getAttribute('aria-label') || label('Share of the after image', 'Part de l’image après'));
      this.range.addEventListener('input', () => this.position = Number(this.range.value));
      this.controls = document.createElement('div'); this.controls.className = 'controls row';
      this.controls.append(button(label('Before', 'Avant'), () => this.position = 0), this.range, button(label('After', 'Après'), () => this.position = 100));
      this.append(this.controls); this.position = 50;
    }
    get position() { return Number(this.range.value); }
    set position(value) {
      value = Math.max(0, Math.min(100, Number(value) || 0)); this.range.value = String(value);
      this.style.setProperty('--compare-position', value + '%');
      this.images[1].style.clipPath = `inset(0 ${100 - value}% 0 0)`;
      this.range.setAttribute('aria-valuetext', value + label(' % after', ' % après'));
      this.dispatchEvent(new CustomEvent('view:change', { detail: { position: value }, bubbles: true }));
    }
  }

  class Media extends HTMLElement {
    connectedCallback() { ready(() => { if (this.isConnected && !this.initialized) this.init(); }); }
    init() {
      this.initialized = true;
      this.media = [...this.querySelectorAll('video,audio')];
      if (!this.media.length) throw Error('view-media expects at least one video or audio');
      this.abort = new AbortController(); const options = { signal: this.abort.signal };
      this.controls = document.createElement('div'); this.controls.className = 'controls row';
      this.playButton = button(label('Play together', 'Lire ensemble'), () => this.playing ? this.pause() : void this.play());
      this.resetButton = button(label('Restart', 'Recommencer'), () => { this.pause(); this.seek(0); });
      this.seekbar = document.createElement('input'); this.seekbar.type = 'range';
      this.seekbar.min = '0'; this.seekbar.max = '0'; this.seekbar.step = '0.05';
      this.seekbar.setAttribute('aria-label', label('Shared position in seconds', 'Position commune en secondes'));
      this.seekbar.addEventListener('input', () => this.seek(Number(this.seekbar.value)));
      this.clock = document.createElement('output');
      this.status = document.createElement('span'); this.status.className = 'muted'; this.status.setAttribute('role', 'status');
      this.rateButtons = [0.5, 1, 2].map(rate => {
        const node = button(rate + '×', () => this.rate(rate)); node.dataset.rate = String(rate); return node;
      });
      this.controls.append(this.playButton, this.resetButton, this.seekbar, this.clock, ...this.rateButtons, this.status);
      this.append(this.controls);
      this.media.forEach((node, index) => {
        node.muted = true; node.defaultMuted = true; node.playsInline = true; node.preload = 'metadata';
        node.addEventListener('loadedmetadata', () => this.measure(), options);
        node.addEventListener('ended', () => this.pause(), options);
        if (index === 0) node.addEventListener('timeupdate', () => this.tick(), options);
      });
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); }, options);
      this.observer = new IntersectionObserver(entries => { if (!entries[0].isIntersecting) this.pause(); });
      this.observer.observe(this); this.rate(1); this.measure();
    }
    measure() {
      const durations = this.media.map(node => node.duration);
      this.duration = durations.every(value => Number.isFinite(value) && value > 0) ? Math.min(...durations) : 0;
      this.seekbar.max = String(this.duration); this.seekbar.disabled = this.duration === 0; this.tick();
    }
    async play() {
      this.status.textContent = ''; const attempt = this.attempt = (this.attempt || 0) + 1;
      const outcomes = await Promise.allSettled(this.media.map(node => { node.muted = true; return node.play(); }));
      if (attempt !== this.attempt) return;
      if (outcomes.some(result => result.status === 'rejected')) {
        this.pause(); this.status.textContent = label('Playback unavailable', 'Lecture indisponible'); return;
      }
      this.playing = true; this.playButton.textContent = 'Pause';
    }
    pause() {
      this.attempt = (this.attempt || 0) + 1; this.media?.forEach(node => node.pause());
      this.playing = false; if (this.playButton) this.playButton.textContent = label('Play together', 'Lire ensemble');
    }
    seek(value) {
      if (!this.duration) return;
      value = Math.max(0, Math.min(this.duration, value));
      this.media.forEach(node => { if (node.readyState > 0) node.currentTime = value; }); this.paint(value);
    }
    rate(value) {
      this.media.forEach(node => { node.playbackRate = value; });
      this.rateButtons.forEach(node => node.setAttribute('aria-pressed', String(Number(node.dataset.rate) === value)));
    }
    paint(value) { this.seekbar.value = String(value); this.clock.textContent = value.toFixed(1) + ' s'; }
    tick() {
      const time = Math.min(this.duration || Infinity, this.media[0].currentTime);
      if (this.playing && this.duration && time >= this.duration - 0.04) this.pause();
      if (this.playing) this.media.slice(1).forEach(node => { if (Math.abs(node.currentTime - time) > 0.15 && node.readyState > 0) node.currentTime = time; });
      this.paint(time || 0);
    }
    disconnectedCallback() {
      this.pause(); this.abort?.abort(); this.observer?.disconnect();
      this.controls?.remove(); this.initialized = false;
    }
  }

  // One derivation function feeds text, SVG labels and CSS variables. No eval,
  // formula strings, expression parser, global store or framework dependency.
  const bind = (selector, derive = () => ({})) => {
    const root = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!root) throw Error('view.bind expects an existing root element');
    if (root.hasAttribute('data-view-bound')) throw Error('view.bind root is already bound');
    root.setAttribute('data-view-bound', '');
    const fields = () => [...root.querySelectorAll('input[name],textarea[name],select[name]')]
      .filter(node => node.closest('[data-view-bound]') === root);
    const names = () => new Set(fields().map(node => node.name));
    const previous = Object.create(null);
    const read = () => {
      const state = Object.create(null);
      fields().forEach(node => {
        if (node.type === 'radio' && !node.checked) return;
        state[node.name] = node.type === 'checkbox' ? node.checked
          : ['number', 'range'].includes(node.type) ? Number.isFinite(node.valueAsNumber)
            ? node.valueAsNumber : previous[node.name] ?? 0 : node.value;
        previous[node.name] = state[node.name];
      });
      return state;
    };
    const defaults = read(); const abort = new AbortController(); let values;
    const render = () => {
      const state = read(), derived = derive(Object.freeze({ ...state }));
      for (const name of Object.keys(derived)) if (names().has(name)) throw Error('derived value also names a control: ' + name);
      values = Object.freeze({ ...state, ...derived });
      for (const [name, value] of Object.entries(values)) {
        if (typeof value === 'number' && !Number.isFinite(value)) throw Error('view.bind expects a finite number for ' + name);
        if (typeof value === 'number' && /^[a-z][\w-]*$/i.test(name)) root.style.setProperty('--view-' + name, String(value));
      }
      root.querySelectorAll('[data-value]').forEach(node => {
        if (node.closest('[data-view-bound]') !== root) return;
        const value = values[node.dataset.value];
        node.textContent = value === undefined ? '?' : typeof value === 'number'
          ? value.toLocaleString(document.documentElement.lang || 'en') : String(value);
      });
      root.dispatchEvent(new CustomEvent('view:change', { detail: values, bubbles: true }));
    };
    const set = (patch) => {
      fields().forEach(node => {
        if (!Object.hasOwn(patch, node.name)) return;
        if (node.type === 'checkbox') node.checked = Boolean(patch[node.name]);
        else if (node.type === 'radio') node.checked = node.value === String(patch[node.name]);
        else node.value = String(patch[node.name]);
      }); render();
    };
    root.addEventListener('input', event => { if (event.target.closest('[data-view-bound]') === root && names().has(event.target.name)) render(); }, { signal: abort.signal });
    root.addEventListener('change', event => { if (event.target.closest('[data-view-bound]') === root && names().has(event.target.name)) render(); }, { signal: abort.signal });
    root.addEventListener('click', event => {
      const preset = event.target.closest('[data-set],[data-reset]');
      if (!preset || preset.closest('[data-view-bound]') !== root) return;
      if (preset.hasAttribute('data-reset')) set(defaults); else set(JSON.parse(preset.dataset.set));
    }, { signal: abort.signal });
    try { render(); } catch (error) { abort.abort(); root.removeAttribute('data-view-bound'); throw error; }
    return { set, reset: () => set(defaults), get values() { return values; }, dispose() { abort.abort(); root.removeAttribute('data-view-bound'); } };
  };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.hasAttribute('data-reduced-motion');
class Choices extends HTMLElement {
  connectedCallback() {
    if (this.ready) return;
    this.ready = true;
    this.panels = [...this.children];
    if (!this.panels.length) throw Error('view-choices/view-steps expects at least one child');
    this.at = Math.max(0, Math.min(this.panels.length - 1, Number(this.getAttribute('selected')) || 0));
    this.bar = document.createElement('div');
    this.bar.className = 'segmented view-choice-bar';
    this.bar.setAttribute('role', 'group');
    this.bar.setAttribute('aria-label', this.getAttribute('aria-label') || label('Choices', 'Choix'));
    this.buttons = this.panels.map((panel, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = panel.dataset.label || String(i + 1);
      button.addEventListener('click', () => { this.stop?.(); this.select(i); });
      button.addEventListener('keydown', event => {
        const target = event.key === 'ArrowRight' ? (i + 1) % this.panels.length
          : event.key === 'ArrowLeft' ? (i - 1 + this.panels.length) % this.panels.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? this.panels.length - 1 : null;
        if (target === null) return;
        event.preventDefault(); this.stop?.(); this.select(target); this.buttons[target].focus();
      });
      this.bar.append(button);
      return button;
    });
    this.prepend(this.bar);
    this.select(this.at);
  }
  select(index) {
    this.at = index;
    this.panels.forEach((panel, i) => { panel.hidden = i !== index; });
    this.buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
    this.count && (this.count.textContent = `${index + 1} / ${this.panels.length}`);
    this.prev && (this.prev.disabled = index === 0);
    this.next && (this.next.disabled = index === this.panels.length - 1);
  }
}
class Steps extends Choices {
  connectedCallback() {
    if (this.ready) return;
    super.connectedCallback();
    const controls = document.createElement('div');
    controls.className = 'controls row';
    const action = (label, run) => {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = label; button.addEventListener('click', run); controls.append(button); return button;
    };
    this.prev = action(label('Previous', 'Précédent'), () => { this.stop(); this.select(Math.max(0, this.at - 1)); });
    this.play = action(label('Play', 'Lecture'), () => this.timer ? this.stop() : this.start());
    this.next = action(label('Next', 'Suivant'), () => { this.stop(); this.select(Math.min(this.panels.length - 1, this.at + 1)); });
    this.count = document.createElement('output'); controls.append(this.count); this.append(controls);
    this.select(this.at);
    if (this.hasAttribute('autoplay') && !reduced()) this.start();
  }
  start() {
    if (this.at === this.panels.length - 1) this.select(0);
    this.play.textContent = 'Pause';
    this.timer = setInterval(() => {
      if (this.at === this.panels.length - 1) this.stop(); else this.select(this.at + 1);
    }, Math.max(1, Number(this.getAttribute('interval')) || 4200));
  }
  stop() { clearInterval(this.timer); this.timer = null; if (this.play) this.play.textContent = label('Play', 'Lecture'); }
  disconnectedCallback() { this.stop(); }
}

  window.View = { bind };
  ready(() => { customElements.define('view-compare', Compare); customElements.define('view-media', Media); customElements.define('view-choices', Choices); customElements.define('view-steps', Steps); });
})();
