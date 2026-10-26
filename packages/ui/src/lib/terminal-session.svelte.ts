/*
 * One shell of the core and the xterm.js screen that draws it, kept for as long
 * as the shell runs. The screen outlives the component that shows it: hiding
 * the drawer or opening another thread takes its element out of the page and
 * puts the same one back later, with its scrollback, its selection and whatever
 * a full-screen program drew. Only a reload, a reconnect or a long absence
 * redraws from the core's snapshot.
 *
 * A hidden screen gives back what it holds. Its WebGL context goes as it
 * leaves the page (Chromium keeps sixteen at most) and a new one draws it once
 * when it comes back. After `HIDDEN_RELEASE_MS` out of the page the whole
 * xterm goes, its scrollback included: shown again, the screen is drawn from
 * the core's snapshot, its last 256 Ki characters
 * of output. The shell runs on meanwhile. Its status and directory never
 * come from xterm: the session reads them from the raw output for its whole
 * life (`terminal-status.ts`), so the tab's dot stays true whether a screen
 * exists or not.
 *
 * The screen draws on the GPU (WebGL) and falls back to xterm's DOM renderer
 * when the browser refuses a context or loses it. A shell started with the
 * core's integration marks its prompts and commands (`terminal-marks.ts`):
 * each command gets a dot in the margin, green or red by its status, the
 * header follows the working directory, and Ctrl+Up and Ctrl+Down jump from
 * one command to the next.
 */

import { untrack } from 'svelte';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';
import type { RpcEvents, TerminalShell, TerminalState } from '@boite/contracts';
import { TERMINAL_COMMANDS, isMac } from './keybindings';
import { openExternal } from './links';
import { touchScreen } from './device';
import { readTerminalCursor, readTerminalGpu } from './terminal-cursor';
import { clearLineKeys, parseConEmuCwd, parsePromptMark } from './terminal-marks';
import { ShellStatusReader } from './terminal-status';
import type { Store } from './store.svelte';

/** Local attachment metadata; the core's snapshot stays unchanged on the wire. */
export interface TerminalAttachment extends TerminalState {
  /** Characters replayed from the snapshot; the rest arrived live while it was in flight. */
  replayChars?: number;
}

export type TerminalStart = (cols: number, rows: number) => Promise<TerminalAttachment | null>;

export interface TerminalMount {
  autofocus: boolean;
  onexit?: (exitCode: number | null) => void;
}

/** A drag of the drawer's edge fits the screen every frame; the shell is told once it settles. */
const RESIZE_SETTLE_MS = 80;
/** How long the screen waits for the code font before it measures a cell with what it has. */
const FONT_WAIT_MS = 400;
const FONT_SIZE = 13;
/** Lines kept above the screen. Ten thousand lines of 120 columns are a few megabytes. */
const SCROLLBACK = 10_000;
/** Commands whose dots are kept: older ones scrolled out of the buffer long ago. */
const MAX_MARKS = 1000;
/** How long a screen out of the page keeps its xterm before the core's snapshot is all it needs. */
export const HIDDEN_RELEASE_MS = 5 * 60_000;

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

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The chrome's own tokens, ANSI colours included, so the terminal changes with the theme. */
function theme() {
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
    scrollbarSliderActiveBackground: token('--color-edge'),
    overviewRulerBorder: 'transparent'
  };
}

let probe: CanvasRenderingContext2D | null | undefined;

/** A 2D canvas, which xterm's scrollbar ruler draws on. A test page (jsdom) has none. */
function canDraw(): boolean {
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  return probe !== null;
}

/**
 * Any CSS colour as `#rrggbb`, the only form xterm takes for a decoration.
 * A theme token can be `oklch(...)` or `color-mix(...)`: the canvas resolves it.
 */
export function hexColour(colour: string, fallback: string): string {
  if (/^#[0-9a-f]{6}$/i.test(colour)) return colour;
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!probe || colour.length === 0) return fallback;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = fallback;
  probe.fillStyle = colour;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  if (a === 0) return fallback;
  return `#${[r, g, b].map((n) => n!.toString(16).padStart(2, '0')).join('')}`;
}

/** `a` moved toward `b` by `amount`, both `#rrggbb`: a match tint that keeps the text under it legible. */
export function mixHex(a: string, b: string, amount: number): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  return `#${[1, 3, 5].map((at) => Math.round(channel(a, at) + (channel(b, at) - channel(a, at)) * amount).toString(16).padStart(2, '0')).join('')}`;
}

function fontFamily(): string {
  return token('--font-terminal');
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

type MarkStatus = 'running' | 'success' | 'failure';

/** One command the shell ran: where its prompt starts, and its dot once it runs. */
interface CommandMark {
  marker: IMarker;
  ran: boolean;
  status: MarkStatus | null;
  exit: number | null;
  decoration: IDecoration | null;
}

export class TerminalSession {
  /** What the view puts in the page. xterm lives inside it and moves with it. */
  readonly element: HTMLDivElement;
  /** The directory the shell reported last, else where it started. */
  cwd = $state<string | null>(null);
  /** A command is running: the shell marked it and has not marked its end. */
  running = $state(false);
  /** The status of the last command that ended, null before the first. */
  lastExit = $state<number | null>(null);
  /** Which shell runs, and whether it marks its commands. Null until attached, or on an older core. */
  shell = $state<TerminalShell | null>(null);
  /** The find bar over this screen. */
  searchOpen = $state(false);
  /** Where the find bar is in its matches: `3 of 12`. Null with no query. */
  searchResults = $state<{ index: number; count: number } | null>(null);
  /** The recent commands list over this screen. */
  historyOpen = $state(false);
  /** False once the screen fell back from WebGL to the DOM renderer, or never had it. */
  gpu = $state(false);

  #term: Terminal | null = null;
  #fit: FitAddon | null = null;
  #search: SearchAddon | null = null;
  #webgl: { dispose(): void } | null = null;
  #webglLost: { dispose(): void } | null = null;
  #WebglAddon: (new () => { dispose(): void; onContextLoss: (listener: () => void) => { dispose(): void } }) | null = null;
  /** WebGL failed or lost its context: the session asks for it no more, a screen drawn again after a release included. */
  #gpuRefused = false;
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
  /** What lives as long as the session: the connection watch and the shell's exit. */
  #cleanups: (() => void)[] = [];
  /** What lives as long as one xterm, released with it. */
  #screenCleanups: (() => void)[] = [];
  #releaseTimer: ReturnType<typeof setTimeout> | null = null;
  #listening = false;
  /** The only reader of `running`, `lastExit` and `cwd`, so a release never hands anything over. */
  readonly #status = new ShellStatusReader({
    running: (running) => { this.running = running; },
    exit: (code) => { this.lastExit = code; },
    cwd: (path) => { this.cwd = path; }
  });
  #marks: CommandMark[] = [];
  #query = '';
  #windows = false;

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

  /** True when the shell marks its commands: the dots, the jumps and the recent list work. */
  get integrated(): boolean {
    return this.shell?.integrated === true;
  }

  /** Puts the screen in `host`, starting or attaching to the shell the first time. */
  mount(host: HTMLElement, options: TerminalMount): void {
    if (this.#disposed) return;
    this.#host = host;
    this.#onexit = options.onexit;
    this.#wantsFocus = options.autofocus && !touchScreen();
    host.append(this.element);
    if (this.#releaseTimer !== null) clearTimeout(this.#releaseTimer);
    this.#releaseTimer = null;
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
    this.#dropGpu();
    if (this.#releaseTimer !== null) clearTimeout(this.#releaseTimer);
    this.#releaseTimer = setTimeout(() => this.#release(), HIDDEN_RELEASE_MS);
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
    if (this.#releaseTimer !== null) clearTimeout(this.#releaseTimer);
    this.#observer?.disconnect();
    for (const cleanup of this.#cleanups.reverse()) cleanup();
    this.#cleanups = [];
    this.#disposeScreen();
    this.element.remove();
    this.#host = null;
    this.ondispose();
  }

  /** The screen was out of the page long enough: its xterm goes, the shell and this session stay. */
  #release(): void {
    this.#releaseTimer = null;
    if (this.#disposed || this.#host !== null || this.#term === null) return;
    // An attach in flight lands on nothing.
    this.#run++;
    if (this.#resizeTimer !== null) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = null;
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    this.#disposeScreen();
    this.element.replaceChildren();
    this.#loading = null;
    this.#opened = false;
    this.#attached = false;
    this.#attaching = false;
    this.#pending = [];
    this.#typed = '';
    this.#muted = 0;
    this.#sent = null;
    this.#query = '';
    this.searchResults = null;
  }

  #disposeScreen(): void {
    for (const cleanup of this.#screenCleanups.reverse()) cleanup();
    this.#screenCleanups = [];
    for (const mark of this.#marks) mark.decoration?.dispose();
    this.#marks = [];
    this.#dropGpu();
    this.#term?.dispose();
    this.#term = null;
    this.#fit = null;
    this.#search = null;
  }

  // ---------------------------------------------------------------------------
  // Find, recent commands and jumps
  // ---------------------------------------------------------------------------

  openSearch(): void {
    this.historyOpen = false;
    this.searchOpen = true;
  }

  closeSearch(): void {
    this.searchOpen = false;
    this.searchResults = null;
    this.#query = '';
    this.#search?.clearDecorations();
    this.#term?.clearSelection();
    this.focus();
  }

  /** The match of `query` above the selected one with `backwards`, else below it. */
  find(query: string, backwards = false): void {
    const search = this.#search;
    if (search === null) return;
    if (query.length === 0) {
      this.#query = '';
      this.searchResults = null;
      search.clearDecorations();
      this.#term?.clearSelection();
      return;
    }
    // A changed query starts again from the bottom, the newest output, and goes up.
    if (query !== this.#query) this.#term?.clearSelection();
    this.#query = query;
    const options = { decorations: this.#searchColours() };
    if (backwards) search.findPrevious(query, options);
    else search.findNext(query, options);
  }

  openHistory(): void {
    this.searchOpen = false;
    this.historyOpen = true;
  }

  closeHistory(): void {
    this.historyOpen = false;
    this.focus();
  }

  /**
   * A command from the history in place of what is typed at the prompt, run
   * at once or left there to edit. A full-screen program keeps its keys.
   */
  useCommand(command: string, run: boolean): void {
    const term = this.#term;
    this.historyOpen = false;
    if (term === null || !this.#attached) return;
    if (term.buffer.active.type === 'alternate') {
      this.focus();
      return;
    }
    this.store.writeTerminal(this.id, clearLineKeys(this.shell, this.#windows));
    // xterm brackets a paste when the shell asked for it, so a multi-line command arrives whole.
    term.paste(command);
    if (run) this.store.writeTerminal(this.id, '\r');
    this.focus();
  }

  /**
   * Scrolls to the prompt of the command above the screen's top, or below it.
   * False when there is none, or the shell does not mark them: the key then
   * goes to the shell.
   */
  jump(direction: -1 | 1): boolean {
    const term = this.#term;
    if (term === null || !this.integrated || term.buffer.active.type === 'alternate') return false;
    const top = term.buffer.active.viewportY;
    const lines = this.#marks.map((mark) => mark.marker.line).filter((line) => line >= 0);
    const target = direction < 0
      ? lines.filter((line) => line < top).at(-1)
      : lines.find((line) => line > top);
    if (target === undefined) {
      if (direction > 0) term.scrollToBottom();
      return direction > 0 && top < term.buffer.active.baseY;
    }
    term.scrollToLine(target);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Screen
  // ---------------------------------------------------------------------------

  async #load(): Promise<void> {
    const family = fontFamily();
    // The extras are optional: a chunk that fails to load leaves the screen without
    // GPU drawing, find or wide characters, never without a screen.
    const [{ Terminal }, { FitAddon }, { WebLinksAddon }, searchModule, unicodeModule, webgl] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      import('@xterm/addon-search').catch(() => null),
      import('@xterm/addon-unicode11').catch(() => null),
      readTerminalGpu() && !this.#gpuRefused ? import('@xterm/addon-webgl').catch(() => null) : null,
      fontReady(family)
    ]);
    this.#WebglAddon = webgl?.WebglAddon ?? null;
    const client = this.store.client;
    if (this.#disposed || !client) return;
    const term = new Terminal({
      fontFamily: family,
      fontSize: FONT_SIZE,
      lineHeight: 1.15,
      // A blinking cursor of the shape Appearance names, the bar of a console window by default.
      cursorBlink: true,
      cursorStyle: readTerminalCursor(),
      cursorWidth: 2,
      // A screen without the keyboard shows where its cursor is, hollow, as Windows Terminal does.
      cursorInactiveStyle: 'outline',
      scrollback: SCROLLBACK,
      // Decorations and the parser hooks of the shell integration.
      allowProposedApi: true,
      // The command dots and find matches, down the scrollbar.
      ...(canDraw() ? { overviewRuler: { width: 8 } } : {}),
      // Some ANSI colours are picked for one ground and vanish on the other,
      // yellow on white say. xterm moves a colour until it reads on the
      // background, and asks half as much of dim text, so what PowerShell
      // suggests after a typed letter stays grey instead of reading as typed.
      minimumContrastRatio: 4.5,
      // Alt+click puts the prompt's cursor where the pointer is, as in Windows Terminal.
      altClickMovesCursor: true,
      // OSC 8 links, `ls --hyperlink` say. xterm's own handler asks with `window.confirm`.
      linkHandler: { activate: (_event, uri) => void openExternal(uri) },
      theme: theme()
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => void openExternal(uri)));
    if (unicodeModule !== null) {
      term.loadAddon(new unicodeModule.Unicode11Addon());
      // Emoji and East Asian text two cells wide, as the shell counts them.
      term.unicode.activeVersion = '11';
    }
    this.#term = term;
    this.#fit = fit;
    if (searchModule !== null) {
      const search = new searchModule.SearchAddon({ highlightLimit: 2000 });
      term.loadAddon(search);
      this.#search = search;
      const results = search.onDidChangeResults(({ resultIndex, resultCount }) => {
        this.searchResults = this.#query.length === 0 ? null : { index: resultIndex, count: resultCount };
      });
      this.#screenCleanups.push(() => results.dispose());
    }
    this.#listenToShell(term);
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
    this.#screenCleanups.push(() => { input.dispose(); resize.dispose(); });
    this.#screenCleanups.push(client.on('terminal.output', (event) => {
      if (event.id !== this.id) return;
      if (this.#attached) term.write(event.data);
      else if (this.#attaching) this.#pending.push(event);
    }));
    // A shell can end while its screen is released: the session hears it either way.
    if (!this.#listening) {
      this.#listening = true;
      // The status and the directory are read here, whether a screen draws the output or not.
      this.#cleanups.push(client.on('terminal.output', (event) => {
        if (event.id === this.id) this.#status.read(event.data, event.sequence);
      }));
      this.#cleanups.push(client.on('terminal.exited', (event) => {
        if (event.id !== this.id) return;
        const onexit = this.#onexit;
        this.dispose();
        onexit?.(event.exitCode);
      }));
    }
    // Windows Terminal's right click: copy the selection, or paste when there is none.
    const contextMenu = (event: MouseEvent) => {
      if (event.shiftKey) return;
      event.preventDefault();
      if (term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
        term.clearSelection();
      } else {
        void navigator.clipboard?.readText().then((text) => { if (text.length > 0) term.paste(text); }).catch(() => undefined);
      }
      term.focus();
    };
    this.element.addEventListener('contextmenu', contextMenu);
    this.#screenCleanups.push(() => this.element.removeEventListener('contextmenu', contextMenu));
    const looks = new MutationObserver(() => {
      term.options.theme = theme();
      const next = fontFamily();
      if (next !== term.options.fontFamily) term.options.fontFamily = next;
      const cursor = readTerminalCursor();
      if (cursor !== term.options.cursorStyle) term.options.cursorStyle = cursor;
      for (const mark of this.#marks) this.#decorate(mark);
      this.#scheduleFit();
    });
    looks.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class', 'data-terminal-cursor'] });
    this.#screenCleanups.push(() => looks.disconnect());
  }

  /** The integration's marks as xterm parses them, for the dots on its lines; the directory reports draw nothing. */
  #listenToShell(term: Terminal): void {
    const prompt = term.parser.registerOscHandler(133, (data) => {
      const mark = parsePromptMark(data);
      if (mark === null) return false;
      this.#onMark(term, mark);
      return true;
    });
    // The session's scanner reads the directory; these only keep the reports off the screen.
    const properties = term.parser.registerOscHandler(633, () => true);
    const fileUrl = term.parser.registerOscHandler(7, () => true);
    // Windows Terminal's own cwd report, `9;9;"C:\path"`; another OSC 9 is a notification.
    const conemu = term.parser.registerOscHandler(9, (data) => parseConEmuCwd(data) !== null);
    this.#screenCleanups.push(() => { prompt.dispose(); properties.dispose(); fileUrl.dispose(); conemu.dispose(); });
  }

  #onMark(term: Terminal, mark: ReturnType<typeof parsePromptMark> & object): void {
    const current = this.#marks.at(-1);
    switch (mark.kind) {
      case 'prompt': {
        // A prompt drawn again on the same line (a resize, Ctrl+L) is the same prompt.
        const line = term.buffer.active.baseY + term.buffer.active.cursorY;
        if (current !== undefined && !current.ran && current.marker.line === line) return;
        const marker = term.registerMarker(0);
        if (marker === undefined) return;
        this.#marks.push({ marker, ran: false, status: null, exit: null, decoration: null });
        marker.onDispose(() => {
          const index = this.#marks.findIndex((entry) => entry.marker === marker);
          if (index !== -1) this.#marks.splice(index, 1);
        });
        while (this.#marks.length > MAX_MARKS) {
          const old = this.#marks.shift()!;
          old.decoration?.dispose();
          old.marker.dispose();
        }
        return;
      }
      case 'input':
        return;
      case 'run':
        if (current === undefined || current.ran) return;
        current.ran = true;
        current.status = 'running';
        this.#decorate(current);
        return;
      case 'done':
        // An empty line ends no command: the prompt simply comes back.
        if (current === undefined || !current.ran || current.status !== 'running') return;
        current.exit = mark.exit;
        current.status = mark.exit === null || mark.exit === 0 ? 'success' : 'failure';
        this.#decorate(current);
    }
  }

  /** The dot of a command in the margin, and its tick on the scrollbar. */
  #decorate(mark: CommandMark): void {
    const term = this.#term;
    if (term === null || mark.status === null || mark.marker.isDisposed) return;
    mark.decoration?.dispose();
    const colour = mark.status === 'failure'
      ? hexColour(token('--ansi-red'), '#cd3131')
      : mark.status === 'success'
        ? hexColour(token('--ansi-green'), '#0dbc79')
        : hexColour(token('--color-accent'), '#8b7cf6');
    const decoration = term.registerDecoration({
      marker: mark.marker,
      x: 0,
      width: 1,
      layer: 'top',
      overviewRulerOptions: mark.status === 'running' ? undefined : { color: colour, position: 'left' }
    }) ?? null;
    mark.decoration = decoration;
    decoration?.onRender((element) => {
      element.classList.add('command-mark');
      element.dataset['status'] = mark.status ?? '';
      element.style.setProperty('--mark-colour', colour);
      element.title = mark.status === 'failure' && mark.exit !== null ? `exit ${mark.exit}` : '';
    });
  }

  #searchColours() {
    const accent = hexColour(token('--color-accent'), '#8b7cf6');
    const match = hexColour(token('--ansi-yellow'), '#e5e510');
    const ground = hexColour(token('--color-terminal-background'), '#000000');
    return {
      matchBackground: mixHex(ground, match, 0.35),
      matchOverviewRuler: match,
      activeMatchBackground: accent,
      activeMatchColorOverviewRuler: accent
    };
  }

  /**
   * The WebGL context goes with the screen out of the page; `gpu` still says how
   * it draws when shown. The addon only removes its canvas, which would hold the
   * context until a collection, so the context is lost here: Chromium keeps
   * sixteen at most.
   */
  #dropGpu(): void {
    const addon = this.#webgl;
    if (addon === null) return;
    const canvases = [...this.#term?.element?.querySelectorAll('canvas') ?? []];
    // Disposed first: this loss is not the browser's, and must not turn the GPU off.
    this.#webglLost?.dispose();
    this.#webglLost = null;
    addon.dispose();
    this.#webgl = null;
    for (const canvas of canvases) {
      if (canvas.isConnected) continue;
      const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }

  /** WebGL once the screen is in the page; the DOM renderer when it fails or its context is lost. */
  #useGpu(term: Terminal): void {
    const Addon = this.#WebglAddon;
    if (Addon === null || this.#webgl !== null) return;
    try {
      const addon = new Addon();
      term.loadAddon(addon as never);
      this.#webgl = addon;
      this.gpu = true;
      const lost = this.#webglLost = addon.onContextLoss(() => {
        lost.dispose();
        addon.dispose();
        if (this.#webglLost === lost) this.#webglLost = null;
        if (this.#webgl === addon) this.#webgl = null;
        this.gpu = false;
        // Do not ask again: a browser out of contexts would lose the next one too.
        this.#refuseGpu();
      });
    } catch {
      this.#refuseGpu();
    }
  }

  #refuseGpu(): void {
    this.#gpuRefused = true;
    this.#WebglAddon = null;
    this.gpu = false;
  }

  /** The element is in the page: open xterm in it the first time, fit, attach, focus. */
  #shown(): void {
    const term = this.#term;
    if (this.#disposed || term === null || this.#host === null || !this.element.isConnected) return;
    if (!this.#opened) {
      term.open(this.element);
      this.#opened = true;
    }
    // A new context draws the whole screen once; a screen back from the DOM renderer has none.
    this.#useGpu(term);
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
    // Output was lost with the socket: the scanner reads the shell again from the snapshot.
    if (this.#stale) this.#status.unseed();
    const state = await this.start(term.cols, term.rows);
    if (this.#disposed || run !== this.#run) return;
    this.#attaching = false;
    if (state === null) {
      const onexit = this.#onexit;
      this.dispose();
      onexit?.(null);
      return;
    }
    const replayChars = state.replayChars ?? state.output.length;
    let live = state.output.slice(replayChars);
    for (const event of this.#pending) {
      if (state.sequence === undefined || event.sequence === undefined || event.sequence > state.sequence) live += event.data;
    }
    this.#pending = [];
    this.#attached = true;
    this.#stale = this.store.connection !== 'ready';
    this.shell = state.shell ?? null;
    this.cwd ??= state.cwd;
    if (!this.#status.seeded) this.#status.seed(state.output, state.sequence);
    this.#windows = state.windowsPty !== undefined;
    // The store may have started the shell at a default size before this screen
    // was measured, and joins that request here: the shell is told the real one.
    this.#sent = null;
    if (state.windowsPty) term.options.windowsPty = { backend: 'conpty', buildNumber: state.windowsPty.buildNumber };
    this.#muted++;
    // The replay marks every command again, on the lines it draws them.
    // Drained first: disposing a marker takes it out of `#marks` from its own listener.
    const old = this.#marks;
    this.#marks = [];
    for (const mark of old) {
      mark.decoration?.dispose();
      mark.marker.dispose();
    }
    term.reset();
    const flushTyped = () => {
      if (this.#disposed || run !== this.#run) return;
      if (this.#muted > 0 || !this.#attached || this.#typed.length === 0) return;
      const typed = this.#typed;
      this.#typed = '';
      this.store.writeTerminal(this.id, typed);
    };
    term.write(state.output.slice(0, replayChars), () => {
      this.#muted--;
      if (live.length === 0) flushTyped();
    });
    // Only replayed queries were already answered. Live cursor queries must
    // reach the shell, even when they arrived before the snapshot response.
    if (live.length > 0) term.write(live, flushTyped);
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
    // The drawer's tabs, splits, find and recent commands, before the app's
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
