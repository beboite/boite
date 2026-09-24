<script lang="ts">
  import { onMount } from 'svelte';
  import type { TerminalState } from '@boite/contracts';
  import '@xterm/xterm/css/xterm.css';
  import { openExternal } from '../lib/links';
  import type { Store } from '../lib/store.svelte';

  /**
   * One shell of the core, drawn by xterm.js. `start` attaches to it or starts
   * it at this size; what it prints arrives as `terminal.output`, what is typed
   * goes back as `terminals.write`. An app chord (Ctrl+J, Ctrl+K) stays the
   * app's: the terminal lets it through instead of sending it to the shell.
   */
  let {
    store,
    id,
    start,
    onexit,
    autofocus = false
  }: {
    store: Store;
    id: string;
    start: (cols: number, rows: number) => Promise<TerminalState | null>;
    onexit?: (exitCode: number | null) => void;
    autofocus?: boolean;
  } = $props();

  let host = $state<HTMLDivElement | undefined>(undefined);
  /** Set once attached: asks the core for the shell again after a reconnect. */
  let reattach: (() => void) | null = null;
  let connection: string | null = null;

  // Output sent while the socket was down never arrived, and a restarted core
  // has no shell any more: back on line, the screen is redrawn from the core.
  $effect(() => {
    const now = store.connection;
    const was = connection;
    connection = now;
    if (now === 'ready' && was !== null && was !== 'ready') reattach?.();
  });

  /**
   * Chords the app leaves alone while a text field has the focus. The shell
   * takes them: Ctrl+W deletes a word there, Ctrl+S and Ctrl+Enter are its own.
   */
  const SHELL_CHORDS = new Set(['close-surface', 'stash', 'send-and-draft']);

  /** The chrome's own tokens, so the terminal changes with the theme. ANSI colours stay xterm's. */
  function theme() {
    const css = getComputedStyle(document.documentElement);
    const token = (name: string) => css.getPropertyValue(name).trim();
    return {
      background: token('--color-surface-2'),
      foreground: token('--color-foreground'),
      cursor: token('--color-foreground'),
      cursorAccent: token('--color-surface-2'),
      selectionBackground: token('--color-selection')
    };
  }

  onMount(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links')
      ]);
      const client = store.client;
      if (disposed || !host || !client) return;
      const css = getComputedStyle(document.documentElement);
      const term = new Terminal({
        fontFamily: css.getPropertyValue('--font-mono').trim(),
        fontSize: 13,
        cursorBlink: true,
        scrollback: 5000,
        theme: theme()
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon((_event, uri) => void openExternal(uri)));
      term.open(host);
      cleanups.push(() => term.dispose());
      try { fit.fit(); } catch { /* a host with no size yet keeps xterm's default */ }
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const command = store.commandForKey(event);
        return command === null || SHELL_CHORDS.has(command);
      });

      // Everything printed before the snapshot is in it, so only what follows is drawn.
      let attached = false;
      cleanups.push(client.on('terminal.output', (event) => {
        if (attached && event.id === id) term.write(event.data);
      }));
      cleanups.push(client.on('terminal.exited', (event) => {
        if (event.id === id) onexit?.(event.exitCode);
      }));

      const state = await start(term.cols, term.rows);
      if (disposed) return;
      if (state === null) {
        onexit?.(null);
        return;
      }
      term.write(state.output);
      attached = true;
      const input = term.onData((data) => store.writeTerminal(id, data));
      const resize = term.onResize(({ cols, rows }) => store.resizeTerminal(id, cols, rows));
      cleanups.push(() => { input.dispose(); resize.dispose(); });

      const observer = new ResizeObserver(() => {
        try { fit.fit(); } catch { /* hidden for a frame */ }
      });
      observer.observe(host);
      cleanups.push(() => observer.disconnect());
      const themes = new MutationObserver(() => { term.options.theme = theme(); });
      themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
      cleanups.push(() => themes.disconnect());
      if (autofocus) term.focus();

      reattach = () => {
        attached = false;
        void start(term.cols, term.rows).then((again) => {
          if (disposed) return;
          if (again === null) {
            onexit?.(null);
            return;
          }
          term.reset();
          term.write(again.output);
          attached = true;
        });
      };
    })();
    return () => {
      disposed = true;
      reattach = null;
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  });
</script>

<div class="terminal" bind:this={host} data-testid="terminal" data-terminal-id={id}></div>

<style>
  .terminal {
    min-height: 0;
    height: 100%;
    padding: 6px 0 0 10px;
    background: var(--color-surface-2);
  }

  .terminal :global(.xterm) { height: 100%; }
  .terminal :global(.xterm-viewport) { background: transparent !important; }
</style>
