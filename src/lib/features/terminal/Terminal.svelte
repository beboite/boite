<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { Unicode11Addon } from "@xterm/addon-unicode11";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { ptySpawn, ptyWrite, ptyResize } from "$lib/storage/pty";
  import type { PtyEvent } from "$lib/storage/pty";
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { reloadThread, restoreLastClosedThread } from "$lib/features/thread/api";
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
  import ContextMenu from "$lib/shared/components/ContextMenu.svelte";
  import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";
  import type { Thread } from "$lib/types";

  type Props = { thread: Thread; visible: boolean; focused: boolean };
  let { thread, visible, focused }: Props = $props();

  let container: HTMLDivElement;
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let ptyId: string | null = null;
  let spawned = $state(false);
  let ctxMenu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(
    null,
  );
  let lastOutputAt = 0;
  let sessionTimer: ReturnType<typeof setInterval> | null = null;
  let sessionTimeouts: ReturnType<typeof setTimeout>[] = [];
  let sessionScanInFlight = false;
  let fitRafId: number | null = null;
  let lastInputAt = 0;
  let lastDetectAt = 0;
  let lastDetectOutputAt = 0;
  let detectBuffer = "";
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();
  const LF = new Uint8Array([0x0a]);
  const DETECT_BUFFER_MAX = 4000;
  const SESSION_SCAN_INTERVAL_MS = 12_000;

  function scheduleFit() {
    if (fitRafId !== null) return;
    fitRafId = requestAnimationFrame(() => {
      fitRafId = null;
      if (visible) fit?.fit();
    });
  }

  function cleanTitle(raw: string): string {
    const m = raw.match(/[\p{L}\p{N}]/u);
    if (!m || m.index === undefined) return raw.trim();
    return raw.slice(m.index).trim();
  }

  function markRunning(ttlMs?: number) {
    statusEngine.markWorking(thread.id, ttlMs);
    app.setThreadStatus(thread.id, "running");
  }

  function appendDetectBuffer(text: string) {
    detectBuffer += text;
    if (detectBuffer.length > DETECT_BUFFER_MAX) {
      detectBuffer = detectBuffer.slice(-DETECT_BUFFER_MAX);
    }
  }

  function detectWorkingFromOutput(text: string) {
    const now = Date.now();
    if (lastDetectOutputAt && now - lastDetectOutputAt > 1500) {
      detectBuffer = "";
    }
    lastDetectOutputAt = now;
    appendDetectBuffer(text);
    if (now - lastDetectAt < 120) return;
    lastDetectAt = now;
    if (detectWorking(detectBuffer, thread.iconKey)) {
      markRunning();
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
        markRunning();
      }
    } else if (event.type === "exit") {
      const exitedPtyId = ptyId;
      ptyId = null;
      stopSessionMonitor();
      const current = app.threads.find((x) => x.id === thread.id);
      if (current?.ptyId !== exitedPtyId) return;
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

  function openTerminalContextMenu(e: MouseEvent) {
    e.preventDefault();
    if (!term) return;
    const sel = term.getSelection();
    const items: ContextMenuItem[] = [
      {
        label: "Copy",
        disabled: !sel,
        action: () => {
          void copySelection().then(() => term?.clearSelection());
        },
      },
      {
        label: "Paste",
        action: () => {
          void pasteFromClipboard();
        },
      },
      { separator: true },
      {
        label: "Reload thread",
        action: () => {
          void reloadThread(thread.id);
        },
      },
    ];
    ctxMenu = { x: e.clientX, y: e.clientY, items };
  }

  function closeContextMenu() {
    ctxMenu = null;
  }

  function stopSessionMonitor() {
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = null;
    for (const timeout of sessionTimeouts) clearTimeout(timeout);
    sessionTimeouts = [];
  }

  async function persistSessionId(t: Thread, id: string, cwd: string) {
    if (t.sessionId === id) return;
    const previous = t.sessionId;
    t.sessionId = id;
    await saveThread($state.snapshot(t) as Thread);
    logger.info(
      "session",
      `${previous ? "updated" : "captured"} ${t.iconKey ?? "?"} session for ${t.label}`,
      { id, previous, cwd },
    );
    notifications.success(
      previous ? `Session updated (${t.label})` : `Session captured (${t.label})`,
    );
  }

  function sessionProbeSince(t: Thread, initialSince: number): number | null {
    if (!t.sessionId) return initialSince;
    const localActivityAt = Math.max(lastInputAt, lastOutputAt);
    if (!localActivityAt) return null;
    if (Date.now() - localActivityAt > SESSION_SCAN_INTERVAL_MS * 2) return null;
    return Math.max(initialSince, localActivityAt - 2000);
  }

  function startSessionMonitor(
    cwd: string,
    detector: NonNullable<ReturnType<typeof getDetector>>,
    since: number,
    targetPtyId: string,
  ) {
    stopSessionMonitor();

    const scanOnce = async (): Promise<boolean> => {
      if (sessionScanInFlight) return false;
      const t = app.threads.find((x) => x.id === thread.id);
      if (!t || t.ptyId !== targetPtyId || ptyId !== targetPtyId) return true;
      const probeSince = sessionProbeSince(t, since);
      if (probeSince == null) return false;

      const excludeIds = app.threads
        .filter((x) => x.id !== thread.id && x.sessionId)
        .map((x) => x.sessionId as string);

      sessionScanInFlight = true;
      try {
        const id = await detector(cwd, probeSince, excludeIds);
        if (!id) return false;
        if (
          app.threads.some((x) => x.id !== thread.id && x.sessionId === id)
        ) {
          return false;
        }
        await persistSessionId(t, id, cwd);
        return false;
      } catch (err) {
        logger.error("session", `detect failed for ${t.label}`, String(err));
        return false;
      } finally {
        sessionScanInFlight = false;
      }
    };

    const runScan = () => {
      void scanOnce().then((done) => {
        if (done) stopSessionMonitor();
      });
    };

    sessionTimeouts = [setTimeout(runScan, 3000), setTimeout(runScan, 8000)];
    sessionTimer = setInterval(runScan, SESSION_SCAN_INTERVAL_MS);
  }

  async function openTerminalLink(event: MouseEvent, uri: string) {
    if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      await openUrl(uri);
    } catch (err) {
      logger.error("terminal", `open link failed: ${uri}`, String(err));
      notifications.error("Failed to open link");
    }
  }

  function shouldSendLineFeed(e: KeyboardEvent, code: string): boolean {
    const isEnter = code === "Enter" || code === "NumpadEnter";
    const isCodex = thread.iconKey === "codex";
    if (
      isEnter &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      (settings.state.powershellNewline || isCodex)
    ) {
      return true;
    }
    return isCodex && e.ctrlKey && !e.shiftKey && !e.altKey && code === "KeyJ";
  }

  function sendLineFeed(e: KeyboardEvent): boolean {
    e.preventDefault();
    e.stopPropagation();
    if (ptyId) void ptyWrite(ptyId, LF);
    queueMicrotask(() => term?.focus());
    return false;
  }

  function wheelLines(e: WheelEvent): number {
    const raw =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? e.deltaY
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? e.deltaY * (term?.rows ?? 24)
          : e.deltaY / 20;
    if (raw === 0) return 0;
    return Math.sign(raw) * Math.max(1, Math.min(12, Math.round(Math.abs(raw))));
  }

  function handleCodexWheel(e: WheelEvent): boolean {
    if (thread.iconKey !== "codex" || e.ctrlKey || e.metaKey || !term) return true;
    if (e.deltaY === 0) return true;

    const lines = wheelLines(e);
    if (lines === 0) return true;

    e.preventDefault();
    e.stopPropagation();

    const buffer = term.buffer.active;
    if (buffer.baseY > 0) {
      term.scrollLines(lines);
      return false;
    }

    if (!ptyId) return false;
    const seq = lines < 0 ? "\x1b[A" : "\x1b[B";
    void ptyWrite(ptyId, encoder.encode(seq.repeat(Math.abs(lines))));
    return false;
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

    const detector = getDetector(thread);
    if (detector && ptyId) {
      const since = Math.max(0, spawnedAt - (thread.sessionId ? 1000 : 5000));
      startSessionMonitor(project.cwd, detector, since, ptyId);
    }

    term.onData((data) => {
      if (!ptyId) return;
      lastInputAt = Date.now();
      const bytes = new TextEncoder().encode(data);
      void ptyWrite(ptyId, bytes);
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
    term.loadAddon(new WebLinksAddon((event, uri) => {
      void openTerminalLink(event, uri);
    }));
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
      if (e.ctrlKey && e.shiftKey && !e.altKey && code === "KeyT") {
        e.preventDefault();
        e.stopPropagation();
        void restoreLastClosedThread();
        return false;
      }

      if (shouldSendLineFeed(e, code)) {
        return sendLineFeed(e);
      }

      return true;
    });

    term.attachCustomWheelEventHandler(handleCodexWheel);

    term.open(container);

    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL unavailable. Fall back to default DOM renderer.
    }

    const initialFit = () => {
      try {
        fit?.fit();
      } catch {
        // ignore
      }
    };
    initialFit();
    if (focused) term.focus();

    requestAnimationFrame(() => {
      initialFit();
      requestAnimationFrame(() => {
        initialFit();
        void spawn();
      });
    });
    setTimeout(initialFit, 100);
    setTimeout(initialFit, 350);

    resizeObserver = new ResizeObserver(() => {
      scheduleFit();
    });
    resizeObserver.observe(container);

    statusEngine.acquire();
  });

  $effect(() => {
    if (visible && term) {
      queueMicrotask(() => fit?.fit());
    }
  });

  $effect(() => {
    if (focused && term) {
      queueMicrotask(() => term?.focus());
    }
  });

  onDestroy(() => {
    statusEngine.release(thread.id);
    stopSessionMonitor();
    if (fitRafId !== null) cancelAnimationFrame(fitRafId);
    fitRafId = null;
    resizeObserver?.disconnect();
    term?.dispose();
    term = null;
    fit = null;
  });
</script>

<div
  class="relative h-full w-full overflow-hidden bg-[var(--color-background)] px-3 py-2"
  oncontextmenu={openTerminalContextMenu}
  role="presentation"
>
  <div bind:this={container} class="h-full w-full min-h-0 overflow-hidden"></div>
  {#if thread.status === "stopped"}
    <div
      class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black text-xs text-muted-foreground/60"
    >
      ( -_-) zzZ
    </div>
  {/if}
</div>

{#if ctxMenu}
  <ContextMenu
    items={ctxMenu.items}
    x={ctxMenu.x}
    y={ctxMenu.y}
    onClose={closeContextMenu}
  />
{/if}
