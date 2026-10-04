<script lang="ts">
  import { onMount } from 'svelte';
  import type { TerminalState } from '@boite/contracts';
  import '@xterm/xterm/css/xterm.css';
  import { focusComposer } from '../lib/focus';
  import type { Store } from '../lib/store.svelte';

  /**
   * Where one shell of the core shows. The screen itself is the store's
   * (`lib/terminal-session.svelte.ts`) and outlives this component: it is put
   * here on mount and taken out again, never redrawn, so hiding the drawer
   * keeps the scrollback and whatever a full-screen program drew. `start`
   * attaches to the shell or starts it at the screen's size.
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

  onMount(() => {
    const node = host;
    if (!node) return;
    const session = store.terminalSession(id, start);
    session.mount(node, { autofocus, onexit: (code) => onexit?.(code) });
    return () => {
      // The keyboard left with the screen: on `<body>` the next Escape would stop the turn.
      if (!session.unmount(node)) return;
      queueMicrotask(() => {
        if (document.activeElement === null || document.activeElement === document.body) focusComposer();
      });
    };
  });
</script>

<div class="terminal" bind:this={host} data-testid="terminal" data-terminal-id={id}></div>

<style>
  .terminal {
    min-height: 0;
    height: 100%;
    /* Windows Terminal's narrow margin; the fit leaves the odd pixels at the right and bottom. */
    padding: 4px 0 0 8px;
    background: var(--color-terminal-background);
  }

  .terminal :global(.xterm) { height: 100%; }
  .terminal :global(.xterm-viewport) { background: transparent !important; }
</style>
