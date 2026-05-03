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
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { logger } from "$lib/shared/services/logger.svelte";
  import {
    detectWorking,
    titleSignalsWorking,
  } from "$lib/features/thread/working-detect";
  import { statusEngine } from "$lib/features/thread/statusEngine";
  import type { Thread } from "$lib/types";

  type Props = { thread: Thread; active: boolean };
  let { thread, active }: Props = $props();

  let container: HTMLDivElement;
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let ptyId: string | null = null;
  let spawned = $state(false);
  let lastOutputAt = 0;
  let sessionTimer: ReturnType<typeof setInterval> | null = null;
  let fitRafId: number | null = null;
  let lastDetectAt = 0;
  const decoder = new TextDecoder("utf-8", { fatal: false });

  function scheduleFit() {
    if (fitRafId !== null) return;
    fitRafId = requestAnimationFrame(() => {
      fitRafId = null;
      if (active) fit?.fit();
    });
  }

  function cleanTitle(raw: string): string {
    const m = raw.match(/[\p{L}\p{N}]/u);
    if (!m || m.index === undefined) return raw.trim();
    return raw.slice(m.index).trim();
  }

  function detectWorkingFromOutput(text: string) {
    const now = Date.now();
    if (now - lastDetectAt < 120) return;
    lastDetectAt = now;
    if (detectWorking(text, thread.iconKey)) {
      statusEngine.markWorking(thread.id);
      app.setThreadStatus(thread.id, "running");
    }
  }

  function handleEvent(event: PtyEvent) {
    if (!term) return;
    if (event.type === "output") {
      const bytes = new Uint8Array(event.data);
      lastOutputAt = Date.now();
      term.write(bytes);
      const text = decoder.decode(bytes, { stream: true });
      detectWorkingFromOutput(text);
    } else if (event.type === "title") {
      const cleaned = cleanTitle(event.value);
      if (cleaned) app.setThreadTitle(thread.id, cleaned);
      if (titleSignalsWorking(event.value)) {
        statusEngine.markWorking(thread.id);
        app.setThreadStatus(thread.id, "running");
      }
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

    if (!thread.sessionId) {
      const detector = getDetector(thread);
      if (detector) {
        try {
          const id = await detector(project.cwd, thread.createdAt - 1000);
          if (id) {
            const t = app.threads.find((x) => x.id === thread.id);
            if (t) {
              t.sessionId = id;
              thread.sessionId = id;
              void saveThread($state.snapshot(t) as Thread);
              logger.info(
                "session",
                `pre-spawn capture for ${t.label}`,
                { id, iconKey: t.iconKey },
              );
            }
          }
        } catch (err) {
          logger.error("session", `pre-spawn detect failed`, String(err));
        }
      }
    }

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
      app.setThreadStatus(thread.id, "ready");
      logger.info(
        "spawn",
        `${thread.label} (${thread.iconKey ?? "?"}): spawned`,
        { cmd: plan.cmd, args: plan.args, cwd: project.cwd },
      );
    } catch (err) {
      term.write(`\r\n[boite] spawn failed: ${err}\r\n`);
      app.setThreadStatus(thread.id, "error");
      logger.error("spawn", `${thread.label}: spawn failed`, String(err));
      return;
    }

    if (plan.pendingInput && ptyId) {
      const targetPtyId = ptyId;
      const text = plan.pendingInput;
      const encoded = new TextEncoder().encode(text);
      lastOutputAt = Date.now();
      let injected = false;

      const tryInject = () => {
        if (injected) return;
        if (Date.now() - lastOutputAt > 350) {
          injected = true;
          void ptyWrite(targetPtyId, encoded);
          return;
        }
        setTimeout(tryInject, 120);
      };
      setTimeout(tryInject, 250);

      setTimeout(() => {
        if (!injected) {
          injected = true;
          void ptyWrite(targetPtyId, encoded);
        }
      }, 5000);
    }

    if (!thread.sessionId) {
      const detector = getDetector(thread);
      if (detector) {
        const cwd = project.cwd;
        const since = spawnedAt - 5000;
        const scanOnce = async (): Promise<boolean> => {
          const t = app.threads.find((x) => x.id === thread.id);
          if (!t) return true;
          if (t.sessionId) return true;
          try {
            const id = await detector(cwd, since);
            if (!id) return false;
            t.sessionId = id;
            void saveThread($state.snapshot(t) as Thread);
            logger.info(
              "session",
              `captured ${t.iconKey ?? "?"} session for ${t.label}`,
              { id, cwd },
            );
            notifications.success(`Session captured (${t.label})`);
            return true;
          } catch (err) {
            logger.error("session", `detect failed for ${t.label}`, String(err));
            return false;
          }
        };
        // Try a few times early, then settle on a slow poll while the thread
        // stays alive without a captured session id.
        setTimeout(() => void scanOnce(), 3000);
        setTimeout(() => void scanOnce(), 8000);
        sessionTimer = setInterval(() => {
          void scanOnce().then((done) => {
            if (done && sessionTimer) {
              clearInterval(sessionTimer);
              sessionTimer = null;
            }
          });
        }, 12000);
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
      scheduleFit();
    });
    resizeObserver.observe(container);

    statusEngine.acquire();
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
    statusEngine.release(thread.id);
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = null;
    if (fitRafId !== null) cancelAnimationFrame(fitRafId);
    fitRafId = null;
    resizeObserver?.disconnect();
    term?.dispose();
    term = null;
    fit = null;
  });
</script>

<div
  bind:this={container}
  class="h-full w-full bg-[var(--color-background)] px-3 py-2"
  oncontextmenu={handleContextMenu}
  role="presentation"
></div>
