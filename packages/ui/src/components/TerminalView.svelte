<script lang="ts">
  import { onMount } from 'svelte';
  import type { TerminalState } from '@boite/contracts';
  import '@xterm/xterm/css/xterm.css';
  import { focusComposer } from '../lib/focus';
  import type { Store } from '../lib/store.svelte';
  import type { TerminalSession } from '../lib/terminal-session.svelte';
  import TerminalFind from './TerminalFind.svelte';
  import TerminalHistory from './TerminalHistory.svelte';

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
  let screen = $state<TerminalSession | null>(null);

  onMount(() => {
    const node = host;
    if (!node) return;
    const session = store.terminalSession(id, start);
    screen = session;
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

<div class="frame">
  <div class="terminal" class:integrated={screen?.integrated} bind:this={host} data-testid="terminal" data-terminal-id={id}
    data-gpu={screen?.gpu ? 'webgl' : 'dom'}></div>
  {#if screen?.searchOpen}<TerminalFind session={screen} />{/if}
  {#if screen?.historyOpen}<TerminalHistory {store} session={screen} />{/if}
</div>

<style>
  .frame {
    position: relative;
    height: 100%;
    min-height: 0;
  }

  .terminal {
    min-height: 0;
    height: 100%;
    /* Windows Terminal's narrow margin; the fit leaves the odd pixels at the right and bottom. */
    padding: 4px 0 0 8px;
    background: var(--color-terminal-background);
  }

  /* Room in the margin for each command's dot. */
  .terminal.integrated { padding-left: 14px; }

  .terminal :global(.xterm) { height: 100%; }

  /*
   * A command's dot, in the margin left of its prompt: green when it ended
   * well, red when it failed, the accent and breathing while it runs. xterm
   * places the element over the prompt's first cell; it is moved out into the
   * padding and drawn smaller than the cell.
   */
  .terminal :global(.xterm-decoration.command-mark) {
    width: 6px !important;
    margin-left: -10px;
    pointer-events: auto;
  }

  .terminal :global(.xterm-decoration.command-mark)::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    transform: translateY(-50%);
    background: var(--mark-colour);
  }

  .terminal :global(.xterm-decoration.command-mark[data-status='running'])::before {
    animation: command-running 1.2s var(--ease-out-quint) infinite;
  }

  @keyframes command-running {
    0%, 100% { opacity: 1; transform: translateY(-50%) scale(1); }
    50% { opacity: 0.35; transform: translateY(-50%) scale(0.7); }
  }

  @media (prefers-reduced-motion: reduce) {
    .terminal :global(.xterm-decoration.command-mark[data-status='running'])::before { animation: none; }
  }

  :global(html[data-motion='reduced']) .terminal :global(.xterm-decoration.command-mark[data-status='running'])::before { animation: none; }

  .terminal :global(.xterm-viewport) { background: transparent !important; }
</style>
