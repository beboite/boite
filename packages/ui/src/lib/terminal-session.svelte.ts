/*
 * One shell of the core and the xterm.js screen that draws it, kept for as long
 * as the shell runs. The screen outlives the component that shows it: hiding
 * the drawer or opening another thread takes its element out of the page and
 * puts the same one back later, with its scrollback, its selection and whatever
 * a full-screen program drew. Only a reload or a reconnect redraws from the
 * core's snapshot.
 */

import { untrack } from 'svelte';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { RpcEvents, TerminalState } from '@boite/contracts';
import { TERMINAL_COMMANDS, isMac } from './keybindings';
import { openExternal } from './links';
import { readTerminalCursor } from './terminal-cursor';
import type { Store } from './store.svelte';

export type TerminalStart = (cols: number, rows: number) => Promise<TerminalState | null>;

export interface TerminalMount {
  autofocus: boolean;
  onexit?: (exitCode: number | null) => void;
}

/** A drag of the drawer's edge fits the screen every frame; the shell is told once it settles. */
const RESIZE_SETTLE_MS = 80;
/** How long the screen waits for the code font before it measures a cell with what it has. */
const FONT_WAIT_MS = 400;
const FONT_SIZE = 13;

/**
 * True for a key the shell takes even when the app has a command on it: Ctrl
 * and a letter, or one of the few signs a terminal encodes as a control
 * character. Those are the readline and full-screen program chords (Ctrl+K
 * kills the line, Ctrl+N is the next history entry, Ctrl+S saves in nano). A
 * chord with Shift or Alt, or on any other key, means nothing to a shell and
 * stays the app's.
 */
export function shellOwnsKey(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && /^[a-z[\]\\^_@ ]$/i.test(event.key);
}

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
const capitalized = (name: string) => name[0]!.toUpperCase() + name.slice(1);

/** The chrome's own tokens, ANSI colours included, so the terminal changes with the theme. */
function theme() {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const colours: Record<string, string> = {};
  for (const name of ANSI) {
    colours[name] = token(`--ansi-${name}`);
    colours[`bright${capitalized(name)}`] = token(`--ansi-bright-${name}`);
  }
  return {
    ...colours,
    background: token('--color-terminal-background'),
    foreground: token('--color-foreground'),
    cursor: token('--color-foreground'),
    cursorAccent: token('--color-terminal-background'),
    selectionBackground: token('--color-selection'),
    scrollbarSliderBackground: token('--color-border'),
    scrollbarSliderHoverBackground: token('--color-edge'),
    scrollbarSliderActiveBackground: token('--color-edge')
  };
}

function fontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-terminal').trim();
}

/** A cell measured before the code font arrived stays that wide: wait for the font, but not for long. */
async function fontReady(family: string): Promise<void> {
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== 'function' || family.length === 0) return;
  await Promise.race([
    fonts.load(`${FONT_SIZE}px ${family}`).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS))
  ]);
}

export class TerminalSession {
  /** What the view puts in the page. xterm lives inside it and moves with it. */
  readonly element: HTMLDivElement;
  #term: Terminal | null = null;
  #fit: FitAddon | null = null;
  #host: HTMLElement | null = null;
  #onexit: TerminalMount['onexit'];
  #wantsFocus = false;
  #loading: Promise<void> | null = null;
  #opened = false;
  #disposed = false;
  /** Output is drawn only once the snapshot is: what came before it is in it. */
  #attached = false;
  #attaching = false;
  #run = 0;
  #pending: RpcEvents['terminal.output'][] = [];
  /** Keys typed while the shell is being attached, a few lines at most. */
  #typed = '';
  /** Above zero while a snapshot replays: xterm answers the queries in it again, and the shell must not get them. */
  #muted = 0;
  /** The socket dropped since the last snapshot, so events were lost and the core may have no shell any more. */
  #stale = false;
  /** The size the shell was last told. */
  #sent: { cols: number; rows: number } | null = null;
  #resizeTimer: ReturnType<typeof setTimeout> | null = null;
  #frame: number | null = null;
  #observer: ResizeObserver | null = null;
  #cleanups: (() => void)[] = [];

  constructor(
    private readonly store: Store,
    readonly id: string,
    private readonly start: TerminalStart,
    private readonly ondispose: () => void
  ) {
    this.element = document.createElement('div');
    this.element.className = 'terminal-screen';
    this.element.style.cssText = 'width: 100%; height: 100%;';
    // Output sent while the socket was down never arrived, and a restarted core
    // has no shell any more: back on line, the screen is redrawn from the core.
    this.#cleanups.push($effect.root(() => {
      $effect(() => {
        const ready = this.store.connection === 'ready';
        untrack(() => {
          if (!ready) this.#stale = true;
          else if (this.#stale && this.#host !== null && this.#opened) void this.#attach();
        });
      });
    }));
  }

  /** Puts the screen in `host`, starting or attaching to the shell the first time. */
  mount(host: HTMLElement, options: TerminalMount): void {
    if (this.#disposed) return;
    this.#host = host;
    this.#onexit = options.onexit;
    this.#wantsFocus = options.autofocus;
    host.append(this.element);
    this.#observer?.disconnect();
    this.#observer = new ResizeObserver(() => this.#scheduleFit());
    this.#observer.observe(host);
    this.#loading ??= this.#load();
    void this.#loading.then(() => this.#shown());
  }

  /** Takes the screen out of `host` and keeps it. True when the keyboard was in it. */
  unmount(host: HTMLElement): boolean {
    if (this.#host !== host) return false;
    const focused = this.element.contains(document.activeElement);
    this.#observer?.disconnect();
    this.#observer = null;
    this.#host = null;
    this.#onexit = undefined;
    this.element.remove();
    return focused;
  }

  focus(): void {
    this.#term?.focus();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#run++;
    if (this.#resizeTimer !== null) clearTimeout(this.#resizeTimer);
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#observer?.disconnect();
    for (const cleanup of this.#cleanups.reverse()) cleanup();
    this.#cleanups = [];
    this.#term?.dispose();
    this.#term = null;
    this.element.remove();
    this.#host = null;
    this.ondispose();
  }

  async #load(): Promise<void> {
    const family = fontFamily();
    const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      fontReady(family)
    ]);
    const client = this.store.client;
    if (this.#disposed || !client) return;
    const term = new Terminal({
      fontFamily: family,
      fontSize: FONT_SIZE,
      // A blinking cursor of the shape Appearance names, the bar of a console window by default.
      cursorBlink: true,
      cursorStyle: readTerminalCursor(),
      cursorWidth: 2,
      // A screen without the keyboard shows where its cursor is, hollow, as Windows Terminal does.
      cursorInactiveStyle: 'outline',
      scrollback: 5000,
      // Some ANSI colours are picked for one ground and vanish on the other,
      // yellow on white say. xterm moves a colour until it reads on the
      // background, and asks half as much of dim text, so what PowerShell
      // suggests after a typed letter stays grey instead of reading as typed.
      minimumContrastRatio: 4.5,
      // OSC 8 links, `ls --hyperlink` say. xterm's own handler asks with `window.confirm`.
      linkHandler: { activate: (_event, uri) => void openExternal(uri) },
      theme: theme()
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => void openExternal(uri)));
    this.#term = term;
    this.#fit = fit;
    term.attachCustomKeyEventHandler((event) => this.#key(event));
    const input = term.onData((data) => {
      // What is typed the moment a split shows goes to the shell once its screen
      // is drawn. xterm's answers to the queries of a replayed screen do not.
      if (this.#muted > 0 || !this.#attached) {
        const keys = this.#muted > 0 ? !data.startsWith('\x1b') : this.#attaching;
        if (keys && this.#typed.length < 4096) this.#typed += data;
        return;
      }
      this.store.writeTerminal(this.id, data);
    });
    const resize = term.onResize(() => this.#scheduleResize());
    this.#cleanups.push(() => { input.dispose(); resize.dispose(); });
    this.#cleanups.push(client.on('terminal.output', (event) => {
      if (event.id !== this.id) return;
      if (this.#attached) term.write(event.data);
      else if (this.#attaching) this.#pending.push(event);
    }));
    this.#cleanups.push(client.on('terminal.exited', (event) => {
      if (event.id !== this.id) return;
      const onexit = this.#onexit;
      this.dispose();
      onexit?.(event.exitCode);
    }));
    const looks = new MutationObserver(() => {
      term.options.theme = theme();
      const next = fontFamily();
      if (next !== term.options.fontFamily) term.options.fontFamily = next;
      const cursor = readTerminalCursor();
      if (cursor !== term.options.cursorStyle) term.options.cursorStyle = cursor;
      this.#scheduleFit();
    });
    looks.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class', 'data-terminal-cursor'] });
    this.#cleanups.push(() => looks.disconnect());
  }

  /** The element is in the page: open xterm in it the first time, fit, attach, focus. */
  #shown(): void {
    const term = this.#term;
    if (this.#disposed || term === null || this.#host === null || !this.element.isConnected) return;
    if (!this.#opened) {
      term.open(this.element);
      this.#opened = true;
    }
    this.#fitNow();
    if (!this.#attached && !this.#attaching) void this.#attach();
    else if (this.#stale && this.store.connection === 'ready') void this.#attach();
    else term.refresh(0, term.rows - 1);
    if (this.#wantsFocus) term.focus();
  }

  /** Asks the core for the shell at this size and redraws the screen from its snapshot. */
  async #attach(): Promise<void> {
    const term = this.#term;
    if (term === null) return;
    const run = ++this.#run;
    this.#attached = false;
    this.#attaching = true;
    this.#pending = [];
    const state = await this.start(term.cols, term.rows);
    if (this.#disposed || run !== this.#run) return;
    this.#attaching = false;
    if (state === null) {
      const onexit = this.#onexit;
      this.dispose();
      onexit?.(null);
      return;
    }
    let output = state.output;
    for (const event of this.#pending) {
      if (state.sequence === undefined || event.sequence === undefined || event.sequence > state.sequence) output += event.data;
    }
    this.#pending = [];
    this.#attached = true;
    this.#stale = this.store.connection !== 'ready';
    // The store may have started the shell at a default size before this screen
    // was measured, and joins that request here: the shell is told the real one.
    this.#sent = null;
    if (state.windowsPty) term.options.windowsPty = { backend: 'conpty', buildNumber: state.windowsPty.buildNumber };
    this.#muted++;
    term.reset();
    term.write(output, () => {
      this.#muted--;
      if (this.#muted > 0 || !this.#attached || this.#typed.length === 0) return;
      const typed = this.#typed;
      this.#typed = '';
      this.store.writeTerminal(this.id, typed);
    });
    this.#scheduleResize();
  }

  #scheduleFit(): void {
    if (this.#frame !== null) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#fitNow();
    });
  }

  #fitNow(): void {
    const host = this.#host;
    if (!this.#opened || host === null || host.clientWidth === 0 || host.clientHeight === 0) return;
    try { this.#fit?.fit(); } catch { /* hidden for a frame */ }
  }

  #scheduleResize(): void {
    if (this.#resizeTimer !== null) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = null;
      const term = this.#term;
      if (term === null || !this.#attached) return;
      if (this.#sent?.cols === term.cols && this.#sent.rows === term.rows) return;
      this.#sent = { cols: term.cols, rows: term.rows };
      this.store.resizeTerminal(this.id, term.cols, term.rows);
    }, RESIZE_SETTLE_MS);
  }

  /** False hands the key to the page (the app's chord, the browser's paste) instead of the shell. */
  #key(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true;
    const term = this.#term;
    // Ctrl+N, Ctrl+D, Ctrl+W: the drawer's tabs and splits, before the app's
    // chords and the shell. A full-screen program keeps its Ctrl+letter chords.
    const scoped = this.store.commandForKey(event, 'terminal');
    if (scoped !== null && TERMINAL_COMMANDS.includes(scoped)
      && !(term?.buffer.active.type === 'alternate' && shellOwnsKey(event))
      && this.store.terminalCommand(this.id, scoped)) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }
    const command = this.store.commandForKey(event);
    // The terminal's own key always answers, or there is no way back out of it.
    if (command === 'terminal') return false;
    // Ctrl+Backspace deletes a word everywhere on Windows and Linux; a terminal
    // sends a plain backspace for it, so the shell gets its own word delete.
    if (!isMac() && event.key === 'Backspace' && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      if (this.#attached) this.store.writeTerminal(this.id, '\x17');
      return false;
    }
    if (term !== null && !isMac() && shellOwnsKey(event)) {
      const key = event.key.toLowerCase();
      // Windows Terminal's way: Ctrl+C copies a selection and interrupts without one.
      if (key === 'c' && term.hasSelection()) {
        event.preventDefault();
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
        term.clearSelection();
        return false;
      }
      // The browser's own paste lands in xterm's text box, which sends it bracketed.
      if (key === 'v') return false;
    }
    if (command === null || shellOwnsKey(event)) return true;
    // Chords the app leaves alone while a text field has the focus stay with the shell.
    return command === 'close-surface' || command === 'stash' || command === 'send-and-draft';
  }
}
