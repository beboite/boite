<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { xtermTheme } from "$lib/features/terminal/theme";

  /**
   * The answer of an agent Boite has no print recipe for.
   *
   * A terminal rather than parsed prose, because that is what the output
   * actually is: a full-screen TUI redrawing itself with cursor moves. Running
   * it through a text extractor would produce something that reads like an
   * answer and is not one. Read-only — the composer is where a reply is typed,
   * and this only shows what came back.
   */
  type Props = { raw: string };
  let { raw }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let written = 0;
  let observer: ResizeObserver | null = null;

  onMount(() => {
    if (!host) return;
    term = new Terminal({
      fontSize: 12,
      fontFamily:
        '"JetBrains Mono", "SF Mono", "Cascadia Code", Consolas, Menlo, monospace',
      lineHeight: 1.2,
      // No cursor and no input: nothing here is being typed into.
      cursorStyle: "bar",
      cursorBlink: false,
      disableStdin: true,
      scrollback: 2000,
      theme: xtermTheme(),
      allowProposedApi: true,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    observer = new ResizeObserver(() => {
      try {
        fit?.fit();
      } catch {
        // A bubble mid-layout has no size yet; the next tick has one.
      }
    });
    observer.observe(host);
  });

  // Append-only: the raw field grows by a chunk per PTY event, and rewriting
  // the whole buffer on each would replay the agent's entire redraw history
  // several times a second.
  $effect(() => {
    const next = raw;
    if (!term) return;
    if (next.length < written) {
      term.reset();
      written = 0;
    }
    if (next.length > written) {
      term.write(next.slice(written));
      written = next.length;
    }
  });

  onDestroy(() => {
    observer?.disconnect();
    observer = null;
    term?.dispose();
    term = null;
  });
</script>

<div bind:this={host} class="h-64 w-full overflow-hidden rounded-md bg-[var(--color-background)] p-1"></div>
