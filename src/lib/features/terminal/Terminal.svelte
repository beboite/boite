<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { Unicode11Addon } from "@xterm/addon-unicode11";
  import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { ptySpawn, ptyWrite, ptyResize } from "$lib/storage/pty";
  import type { PtyEvent } from "$lib/storage/pty";
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { buildResumeArgs, getDetector } from "$lib/features/thread/session";
  import {
    planDirectSpawn,
    planSpawnInShell,
  } from "$lib/features/thread/shell-wrap";
  import { platform } from "$lib/storage/platform.svelte";
  import { saveThread } from "$lib/storage/db";
  import type { Thread } from "$lib/types";

  type Props = { thread: Thread; active: boolean };
  let { thread, active }: Props = $props();

  let container: HTMLDivElement;
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let ptyId: string | null = null;
  let spawned = $state(false);

  // Dingbats + Misc Symbols cover all spinner/asterisk glyphs Claude rotates through.
  const TITLE_GLYPH_RE = /^[✀-➿☀-⛿✨✳✴]+\s*/u;

  function applyTitle(raw: string) {
    const hasGlyph = TITLE_GLYPH_RE.test(raw);
    app.setThreadStatus(thread.id, hasGlyph ? "ready" : "running");
    const cleaned = raw.replace(TITLE_GLYPH_RE, "").trim();
    app.setThreadTitle(thread.id, cleaned || raw);
  }

  function handleEvent(event: PtyEvent) {
    if (!term) return;
    if (event.type === "output") {
      term.write(new Uint8Array(event.data));
    } else if (event.type === "title") {
      applyTitle(event.value);
    } else if (event.type === "exit") {
      const code = event.code ?? null;
      app.setThreadStatus(thread.id, code === 0 ? "done" : "exited", code);
      app.setThreadPtyId(thread.id, null);
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

  async function spawn() {
    if (spawned || !term || !fit) return;
    spawned = true;

    const project = app.projects.find((p) => p.id === thread.projectId);
    if (!project) {
      term.write("\r\n[boite] no project found\r\n");
      return;
    }

    const cols = term.cols;
    const rows = term.rows;

    const userArgs = buildResumeArgs(thread);
    const wrapShell = settings.state.defaultShellId
      ? platform.shells.find((s) => s.id === settings.state.defaultShellId) ?? null
      : null;
    const isBlankTerminal = thread.iconKey === "terminal";
    const plan =
      wrapShell && !isBlankTerminal
        ? planSpawnInShell(wrapShell, thread.cmd, userArgs)
        : planDirectSpawn(thread.cmd, userArgs);

    const spawnedAt = Date.now();

    try {
      ptyId = await ptySpawn(
        {
          cwd: project.cwd,
          cmd: plan.cmd,
          args: plan.args,
          cols,
          rows,
        },
        handleEvent,
      );
      app.setThreadPtyId(thread.id, ptyId);
      app.setThreadStatus(thread.id, "running");
    } catch (err) {
      term.write(`\r\n[boite] spawn failed: ${err}\r\n`);
      app.setThreadStatus(thread.id, "error");
      return;
    }

    if (plan.pendingInput && ptyId) {
      const targetPtyId = ptyId;
      const text = plan.pendingInput;
      setTimeout(() => {
        void ptyWrite(targetPtyId, new TextEncoder().encode(text));
      }, 600);
    }

    if (!thread.sessionId) {
      const detector = getDetector(thread.iconKey);
      if (detector) {
        setTimeout(() => {
          void detector(project.cwd, spawnedAt - 2000).then((id) => {
            if (!id) return;
            const t = app.threads.find((x) => x.id === thread.id);
            if (!t) return;
            t.sessionId = id;
            void saveThread($state.snapshot(t) as Thread);
          });
        }, 5000);
      }
    }

    term.onData((data) => {
      if (!ptyId) return;
      const bytes = new TextEncoder().encode(data);
      void ptyWrite(ptyId, bytes);
      if (thread.status === "ready") {
        app.setThreadStatus(thread.id, "running");
      }
    });

    term.onResize(({ cols, rows }) => {
      if (!ptyId) return;
      void ptyResize(ptyId, cols, rows);
    });
  }

  onMount(() => {
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
        background: "#0a0a0a",
        foreground: "#e4e4e7",
        cursor: "#d4d4d8",
        cursorAccent: "#0a0a0a",
        selectionBackground: "rgba(228, 228, 231, 0.18)",
        black: "#18181b",
        red: "#f07178",
        green: "#c3e88d",
        yellow: "#ffcb6b",
        blue: "#82aaff",
        magenta: "#c792ea",
        cyan: "#89ddff",
        white: "#e4e4e7",
        brightBlack: "#52525b",
        brightRed: "#ff8b92",
        brightGreen: "#ddffa7",
        brightYellow: "#ffe585",
        brightBlue: "#9cc4ff",
        brightMagenta: "#e1acff",
        brightCyan: "#a3f7ff",
        brightWhite: "#fafafa",
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

    void spawn();

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
