<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { Unicode11Addon } from "@xterm/addon-unicode11";
  import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { ptySpawn, ptyWrite, ptyResize, type PtyEvent } from "$lib/pty";
  import { app, type Thread } from "$lib/store.svelte";
  import { settings } from "$lib/settings.svelte";

  type Props = { thread: Thread; active: boolean };
  let { thread, active }: Props = $props();

  let container: HTMLDivElement;
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let ptyId: string | null = null;
  const decoder = new TextDecoder("utf-8", { fatal: false });

  // ✱ U+2731 = Claude idle/ready glyph
  const READY_RE = /✱/;
  // Thinking/processing glyphs Claude rotates through
  const THINKING_RE = /[✦✧✺✻✨✳❖✷]/;

  function detectStatus(text: string) {
    if (READY_RE.test(text)) {
      app.setThreadStatus(thread.id, "ready");
    } else if (THINKING_RE.test(text)) {
      app.setThreadStatus(thread.id, "running");
    }
  }

  function handleEvent(event: PtyEvent) {
    if (!term) return;
    if (event.type === "output") {
      const bytes = new Uint8Array(event.data);
      term.write(bytes);
      const text = decoder.decode(bytes, { stream: true });
      detectStatus(text);
    } else if (event.type === "title") {
      app.setThreadTitle(thread.id, event.value);
    } else if (event.type === "exit") {
      const code = event.code ?? null;
      app.setThreadStatus(thread.id, code === 0 ? "done" : "exited", code);
    } else if (event.type === "error") {
      term.write(`\r\n[boite] ${event.message}\r\n`);
      app.setThreadStatus(thread.id, "error");
    }
  }

  async function pasteFromClipboard() {
    if (!term) return;
    try {
      const text = await readText();
      if (text) term.paste(text);
    } catch (err) {
      console.error("clipboard read failed:", err);
    }
  }

  async function copySelection() {
    if (!term) return false;
    const sel = term.getSelection();
    if (!sel) return false;
    try {
      await writeText(sel);
    } catch (err) {
      console.error("clipboard write failed:", err);
    }
    return true;
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    if (!term) return;
    const sel = term.getSelection();
    if (sel) {
      void copySelection().then(() => term?.clearSelection());
    } else {
      void pasteFromClipboard();
    }
  }

  onMount(async () => {
    term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 13,
      fontFamily:
        '"JetBrains Mono", "SF Mono", "Cascadia Code", Consolas, "Liberation Mono", Menlo, monospace',
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 10_000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      theme: {
        background: "#13151a",
        foreground: "#e4e6eb",
        cursor: "#d8dadf",
        cursorAccent: "#13151a",
        selectionBackground: "rgba(220, 220, 220, 0.22)",
        black: "#1c1f26",
        red: "#f07178",
        green: "#c3e88d",
        yellow: "#ffcb6b",
        blue: "#82aaff",
        magenta: "#c792ea",
        cyan: "#89ddff",
        white: "#e4e6eb",
        brightBlack: "#545863",
        brightRed: "#ff8b92",
        brightGreen: "#ddffa7",
        brightYellow: "#ffe585",
        brightBlue: "#9cc4ff",
        brightMagenta: "#e1acff",
        brightCyan: "#a3f7ff",
        brightWhite: "#ffffff",
      },
    });

    fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const code = e.code;

      if (e.ctrlKey && e.shiftKey && code === "KeyC") {
        void copySelection();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && code === "KeyV") {
        void pasteFromClipboard();
        return false;
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && code === "KeyC") {
        const sel = term?.getSelection();
        if (sel) {
          void copySelection().then(() => term?.clearSelection());
          return false;
        }
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && code === "KeyV") {
        void pasteFromClipboard();
        return false;
      }

      // Shift+Enter: send LF (Ctrl+J equivalent) for PowerShell multi-line input.
      if (
        settings.state.powershellNewline &&
        e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        code === "Enter"
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (ptyId) void ptyWrite(ptyId, new Uint8Array([0x0a]));
        queueMicrotask(() => term?.focus());
        return false;
      }

      return true;
    });

    term.open(container);

    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL unavailable — fall back to default DOM renderer.
    }

    fit.fit();
    if (active) term.focus();

    const project = app.projects.find((p) => p.id === thread.projectId);
    if (!project) {
      term.write("\r\n[boite] no project found\r\n");
      return;
    }

    const cols = term.cols;
    const rows = term.rows;

    try {
      ptyId = await ptySpawn(
        {
          cwd: project.cwd,
          cmd: thread.cmd,
          args: thread.args,
          cols,
          rows,
        },
        handleEvent,
      );
      const t = app.threads.find((x) => x.id === thread.id);
      if (t) {
        t.ptyId = ptyId;
        t.status = "running";
      }
    } catch (err) {
      term.write(`\r\n[boite] spawn failed: ${err}\r\n`);
      app.setThreadStatus(thread.id, "error");
      return;
    }

    term.onData((data) => {
      if (!ptyId) return;
      const bytes = new TextEncoder().encode(data);
      void ptyWrite(ptyId, bytes);
      // User typed something — likely sending a prompt to Claude → running.
      if (thread.status === "ready") {
        app.setThreadStatus(thread.id, "running");
      }
    });

    term.onResize(({ cols, rows }) => {
      if (!ptyId) return;
      void ptyResize(ptyId, cols, rows);
    });

    resizeObserver = new ResizeObserver(() => {
      if (active) fit?.fit();
    });
    resizeObserver.observe(container);
  });

  $effect(() => {
    if (active && term) {
      queueMicrotask(() => {
        fit?.fit();
        term?.focus();
      });
    }
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    term?.dispose();
    term = null;
    fit = null;
  });
</script>

<div
  bind:this={container}
  class="h-full w-full px-3 py-2"
  oncontextmenu={handleContextMenu}
  role="presentation"
></div>
