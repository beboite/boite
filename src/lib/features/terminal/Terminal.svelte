<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { Unicode11Addon } from "@xterm/addon-unicode11";
  import { xtermTheme } from "./theme";
  import { openUrl } from "$lib/platform/opener";
  import { readText, writeText } from "$lib/platform/clipboard";
  import {
    ptyOpen,
    ptyWrite,
    ptyResize,
    ptyKill,
    ptyRelease,
  } from "$lib/storage/pty";
  import type { PtyEvent } from "$lib/storage/pty";
  import { backendFor, workspace } from "$lib/backend";
  import { parkedLocal } from "$lib/backend/tauri/parked";
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { reloadThread, restoreLastClosedThread } from "$lib/features/thread/api";
  import { buildResumeArgsAsync, getDetector } from "$lib/features/thread/session";
  import { planDirectSpawn, withPowershellFastFlags } from "$lib/features/thread/shell-wrap";
  import { platform } from "$lib/storage/platform.svelte";
  import {
    startSessionMonitor,
    type SessionMonitor,
  } from "$lib/features/thread/session-monitor.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { logger } from "$lib/shared/services/logger.svelte";
  import {
    detectWorking,
    titleSignalsWorking,
  } from "$lib/features/thread/working-detect";
  import { isGenericTitle } from "$lib/features/thread/title-filter";
  import { statusEngine } from "$lib/features/thread/statusEngine";
  import ContextMenu from "$lib/shared/components/ContextMenu.svelte";
  import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";
  import type { Thread } from "$lib/types";
  import Keyboard from "@lucide/svelte/icons/keyboard";

  type Props = { thread: Thread; visible: boolean; focused: boolean };
  let { thread, visible, focused }: Props = $props();

  const mobile = $derived(settings.state.mobileLayout);
  // Whether THIS thread's status is derived client-side. Per-thread, not
  // per-workspace: in dynamic mode local threads sniff while the boite's
  // threads take server-pushed status.
  const clientStatus = () => backendFor(thread.origin).caps.clientStatus;

  let container: HTMLDivElement;
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let ptyId: string | null = null;
  let spawned = $state(false);
  let spawning = false;
  let destroyed = false;
  // Detached for visibility (remote + mobile): the PTY lives on, but its output
  // stream is dropped while hidden to save 4G; set so the pane reattaches when
  // shown again.
  let released = false;
  // Balances statusEngine.acquire(): only local-sniffing terminals acquire, so
  // only those may release (a remote pane releasing would kill the shared
  // ticker while local panes still run).
  let statusEngineAcquired = false;
  let spawnRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let spawnRetryCount = 0;
  const SPAWN_RETRY_MAX = 30;
  let ctxMenu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(
    null,
  );
  let lastOutputAt = 0;
  let sessionMonitor: SessionMonitor | null = null;
  let fitRafId: number | null = null;
  let lastInputAt = 0;
  let lastDetectAt = 0;
  let lastDetectOutputAt = 0;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();
  const LF = new Uint8Array([0x0a]);
  const DETECT_BUFFER_MAX = 4000;
  // Detection only ever looks at the DETECT_BUFFER_MAX tail, so decoding more
  // than this per chunk is wasted main-thread work during big output bursts.
  const DETECT_DECODE_MAX = 8192;
  // ~3 bytes per char covers the box-drawing and ANSI-heavy output agents
  // emit, so this retains at least DETECT_BUFFER_MAX characters.
  const DETECT_BYTES_MAX = DETECT_BUFFER_MAX * 3;

  // The detection tail used to be decoded and re-sliced on every single output
  // chunk, even though it is only ever read on the 120ms detection tick and on
  // the prompt probe. Keep the raw bytes and materialize the string lazily:
  // a burst of 100 chunks now costs 100 array pushes instead of 100 decodes
  // plus 100 4000-char string copies.
  let detectChunks: Uint8Array[] = [];
  let detectBytes = 0;
  let detectText = "";
  let detectTextStale = false;

  function pushDetectBytes(bytes: Uint8Array) {
    if (bytes.length === 0) return;
    const chunk =
      bytes.length > DETECT_DECODE_MAX
        ? bytes.subarray(bytes.length - DETECT_DECODE_MAX)
        : bytes;
    detectChunks.push(chunk);
    detectBytes += chunk.length;
    while (detectBytes > DETECT_BYTES_MAX && detectChunks.length > 1) {
      detectBytes -= detectChunks[0].length;
      detectChunks.shift();
    }
    detectTextStale = true;
  }

  function detectBufferText(): string {
    if (!detectTextStale) return detectText;
    detectTextStale = false;
    if (detectChunks.length === 0) {
      detectText = "";
      return detectText;
    }
    let joined: Uint8Array;
    if (detectChunks.length === 1) {
      joined = detectChunks[0];
    } else {
      joined = new Uint8Array(detectBytes);
      let at = 0;
      for (const c of detectChunks) {
        joined.set(c, at);
        at += c.length;
      }
    }
    // Non-streaming: the retained window is decoded whole every time, so there
    // is no decoder state to carry. A multi-byte char clipped at the head costs
    // one replacement char, which the detection regexes never look at.
    detectText = decoder.decode(joined);
    if (detectText.length > DETECT_BUFFER_MAX) {
      detectText = detectText.slice(-DETECT_BUFFER_MAX);
    }
    return detectText;
  }

  function clearDetectBuffer() {
    detectChunks = [];
    detectBytes = 0;
    detectText = "";
    detectTextStale = false;
  }

  // Soft keyboard is opt-in on phones: tapping a terminal should focus it for
  // scroll/select without summoning the Android keyboard. `inputmode=none`
  // keeps the textarea focusable (key routing, hardware keyboards) but stops
  // the virtual keyboard; the floating button flips it on demand.
  let keyboardOpen = $state(false);
  const FONT_MIN = 8;
  const FONT_MAX = 32;
  let touchMode: "none" | "pinch" | "scroll" = "none";
  let pinchStartDist = 0;
  let pinchStartFont = 13;
  let scrollLastY = 0;
  let scrollAccum = 0;

  // CLI key bar (mobile): the soft keyboard has no Esc/Ctrl/Tab/arrows, which a
  // TUI like claude/codex leans on. A scrollable strip injects those sequences;
  // Ctrl/Alt are sticky one-shot modifiers applied to the next bar key or to the
  // next character typed on the soft keyboard (see term.onData).
  let ctrlArmed = $state(false);
  let altArmed = $state(false);
  // The CLI strip is opt-in: long-press the keyboard button toggles it, a normal
  // tap toggles the soft keyboard (so the terminal stays uncluttered by default).
  let keyBarOpen = $state(false);
  let lpTimer: ReturnType<typeof setTimeout> | null = null;
  let lpFired = false;
  const finished = $derived(
    thread.status === "done" ||
      thread.status === "exited" ||
      thread.status === "error" ||
      thread.status === "stopped",
  );
  const showKeyBar = $derived(mobile && focused && !finished && keyBarOpen);
  const BAR_KEYS: { id: string; label: string }[] = [
    { id: "esc", label: "Esc" },
    { id: "ctrl", label: "Ctrl" },
    { id: "alt", label: "Alt" },
    { id: "tab", label: "Tab" },
    { id: "intr", label: "^C" },
    { id: "left", label: "←" },
    { id: "up", label: "↑" },
    { id: "down", label: "↓" },
    { id: "right", label: "→" },
    { id: "home", label: "Home" },
    { id: "end", label: "End" },
    { id: "pgup", label: "PgUp" },
    { id: "pgdn", label: "PgDn" },
    { id: "|", label: "|" },
    { id: "/", label: "/" },
    { id: "~", label: "~" },
    { id: "-", label: "-" },
  ];
  const ARROW: Record<string, "A" | "B" | "C" | "D"> = {
    up: "A",
    down: "B",
    right: "C",
    left: "D",
  };

  function rawWrite(s: string) {
    if (!shouldUsePty(ptyId)) return;
    lastInputAt = Date.now();
    void ptyWrite(ptyId, encoder.encode(s));
  }

  function applyCtrl(ch: string): string {
    const c = ch.charCodeAt(0);
    if (c >= 97 && c <= 122) return String.fromCharCode(c - 96); // a-z
    if (c >= 64 && c <= 95) return String.fromCharCode(c - 64); // @A-Z[\]^_
    return ch;
  }

  // Apply the armed Ctrl/Alt modifiers to a single typed/tapped character.
  function emitChar(ch: string) {
    let out = ch;
    if (ctrlArmed) {
      out = applyCtrl(out);
      ctrlArmed = false;
    }
    if (altArmed) {
      out = "\x1b" + out;
      altArmed = false;
    }
    rawWrite(out);
  }

  // Text from the mobile input takeover. A single char honours armed Ctrl/Alt
  // (so the CLI key-bar modifiers work with the soft keyboard); longer strings
  // (a committed word, a paste) go straight through.
  function sendInputText(data: string) {
    if (!data) return;
    if ((ctrlArmed || altArmed) && data.length === 1) {
      emitChar(data);
      return;
    }
    rawWrite(data);
  }

  function pressBarKey(id: string) {
    if (id === "ctrl") {
      ctrlArmed = !ctrlArmed;
      return;
    }
    if (id === "alt") {
      altArmed = !altArmed;
      return;
    }
    switch (id) {
      case "esc":
        rawWrite("\x1b");
        break;
      case "tab":
        rawWrite(altArmed ? "\x1b\t" : "\t");
        break;
      case "intr":
        rawWrite("\x03");
        break;
      case "up":
      case "down":
      case "left":
      case "right": {
        const mod = 1 + (altArmed ? 2 : 0) + (ctrlArmed ? 4 : 0);
        const l = ARROW[id];
        rawWrite(mod === 1 ? `\x1b[${l}` : `\x1b[1;${mod}${l}`);
        break;
      }
      case "home":
        rawWrite("\x1b[H");
        break;
      case "end":
        rawWrite("\x1b[F");
        break;
      case "pgup":
        rawWrite("\x1b[5~");
        break;
      case "pgdn":
        rawWrite("\x1b[6~");
        break;
      default:
        emitChar(id); // literal char: honours armed modifiers
        ctrlArmed = altArmed = false;
        term?.focus();
        return;
    }
    ctrlArmed = altArmed = false;
    term?.focus();
  }

  // preventDefault keeps terminal focus (and the soft keyboard) on tap.
  function keepFocus(e: PointerEvent) {
    e.preventDefault();
  }

  function clearLongPress() {
    if (lpTimer !== null) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
  }

  // Keyboard button: tap = soft keyboard, long-press = CLI key strip.
  function fabDown(e: PointerEvent) {
    e.preventDefault(); // keep terminal focus
    lpFired = false;
    clearLongPress();
    lpTimer = setTimeout(() => {
      lpFired = true;
      lpTimer = null;
      keyBarOpen = !keyBarOpen;
      navigator.vibrate?.(10);
    }, 420);
  }

  function fabUp() {
    const wasLong = lpFired;
    clearLongPress();
    lpFired = false;
    if (!wasLong) toggleKeyboard();
  }

  function fabCancel() {
    clearLongPress();
    lpFired = false;
  }

  function focusTerminalSoon() {
    queueMicrotask(() => term?.focus());
    requestAnimationFrame(() => term?.focus());
  }

  function consumeTerminalShortcut(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function clearSpawnRetry() {
    if (spawnRetryTimer === null) return;
    clearTimeout(spawnRetryTimer);
    spawnRetryTimer = null;
  }

  function currentThread(): Thread | null {
    return app.threadById(thread.id);
  }

  function shouldUsePty(targetPtyId: string | null): targetPtyId is string {
    if (!targetPtyId || destroyed || ptyId !== targetPtyId) return false;
    const current = currentThread();
    return !!current && current.status !== "stopped" && current.ptyId === targetPtyId;
  }

  function teardownPty(action: (key: string) => void) {
    clearSpawnRetry();
    const targetPtyId = ptyId;
    ptyId = null;
    spawned = false;
    if (targetPtyId) action(targetPtyId);
  }

  // Explicit terminate: stop the process, keep the thread row (stopped status).
  function stopLocalPty(wait = false) {
    teardownPty((key) => void ptyKill(key, wait).catch(() => {}));
  }

  // Unmount cleanup: both transports DETACH (keep the PTY alive). Remote keeps
  // it server-side; local now keeps the process + a scrollback ring via
  // pty_detach. Remember local detaches so the return to this workspace
  // reattaches instead of spawning fresh. Explicit close uses stopLocalPty/kill.
  function releasePty() {
    if (ptyId && clientStatus()) {
      // Park only a PTY the store still owns. reloadThread/stopThread/close
      // null the thread's ptyId before killing it; when the exit event lost the
      // race against the unmount, the dead id got parked anyway and the next
      // spawn believed it was reattaching — so the wrap shell never received
      // its launch input and the pane sat at a bare prompt.
      const current = currentThread();
      if (current?.ptyId === ptyId) {
        // Remember the dot colour so the return to this workspace shows the
        // thread connected (ready/running) instead of a reset idle grey.
        parkedLocal.set(thread.id, current.status ?? "ready");
      } else {
        parkedLocal.delete(thread.id);
      }
    }
    teardownPty((key) => void ptyRelease(key).catch(() => {}));
  }

  function scheduleSpawnRetry(delay = 120) {
    if (spawned || spawning || destroyed || spawnRetryTimer !== null) return;
    if (spawnRetryCount >= SPAWN_RETRY_MAX) {
      logger.warn(
        "spawn",
        `${thread.label}: gave up after ${SPAWN_RETRY_MAX} retries — pane likely hidden`,
      );
      return;
    }
    spawnRetryCount++;
    spawnRetryTimer = setTimeout(() => {
      spawnRetryTimer = null;
      void spawn();
    }, delay);
  }

  function hasUsableTerminalSize(): boolean {
    if (!container?.isConnected) return false;
    const rect = container.getBoundingClientRect();
    return rect.width >= 16 && rect.height >= 16;
  }

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

  function syncAliveThread(nextStatus: "ready" | "running" = "ready", known?: Thread | null) {
    if (!ptyId) return;
    const current = known ?? app.threadById(thread.id);
    if (!current) return;
    if (current.status === "stopped") return;
    if (current.ptyId !== ptyId) {
      app.setThreadPtyId(thread.id, ptyId);
      logger.warn("terminal", `${thread.label}: repaired missing pty id`, {
        ptyId,
        status: current.status,
      });
    }
    if (current.status === "idle") {
      app.setThreadStatus(thread.id, nextStatus, null);
    }
  }

  function markRunning(ttlMs?: number) {
    // Remote derives status server-side and pushes it; client-side sniffing
    // would fight those events.
    if (!clientStatus()) return;
    syncAliveThread("running");
    statusEngine.markWorking(thread.id, ttlMs);
    app.setThreadStatus(thread.id, "running");
  }

  function detectWorkingFromOutput(bytes: Uint8Array) {
    const now = Date.now();
    if (lastDetectOutputAt && now - lastDetectOutputAt > 1500) {
      clearDetectBuffer();
    }
    lastDetectOutputAt = now;
    pushDetectBytes(bytes);
    if (now - lastDetectAt < 120) return;
    lastDetectAt = now;
    if (detectWorking(detectBufferText(), thread.iconKey)) {
      markRunning();
    }
  }

  // eventPtyId is captured per spawn so a stale channel still flushing after
  // a reload can never write into — or mark exited — the replacement PTY.
  function handleEvent(event: PtyEvent, eventPtyId: string) {
    if (!term || destroyed) return;
    if (eventPtyId !== ptyId) return;

    if (event.type === "reset") {
      // Full replay incoming (the delta we asked for rolled out of the server
      // ring): clear so it repaints cleanly instead of stacking onto stale
      // scrollback.
      term.reset();
      clearDetectBuffer();
      return;
    }

    if (event.type === "output") {
      const current = currentThread();
      if (!current || current.status === "stopped") return;
      syncAliveThread("ready", current);
      const bytes = event.bytes;
      lastOutputAt = Date.now();
      term.write(bytes);
      // Status sniffing is local-only (remote pushes status server-side), so
      // the bytes are not even retained there.
      if (clientStatus()) {
        statusEngine.markOutput(thread.id);
        detectWorkingFromOutput(bytes);
      }
    } else if (event.type === "title") {
      const current = currentThread();
      if (!current || current.status === "stopped") return;
      syncAliveThread("ready", current);
      const cleaned = cleanTitle(event.value);
      const cwd = app.projects.find((p) => p.id === thread.projectId)?.cwd;
      if (cleaned && !isGenericTitle(cleaned, cwd)) {
        app.setThreadTitle(thread.id, cleaned);
      }
      if (titleSignalsWorking(event.value)) {
        markRunning();
      }
    } else if (event.type === "exit") {
      ptyId = null;
      spawned = false;
      stopSessionMonitor();
      const current = currentThread();
      if (current?.ptyId !== eventPtyId) return;
      if (current.status === "stopped") {
        app.setThreadPtyId(thread.id, null);
        return;
      }
      const code = event.code ?? null;
      app.setThreadStatus(thread.id, code === 0 ? "done" : "exited", code);
      app.setThreadPtyId(thread.id, null);
    } else if (event.type === "error") {
      term.write(`\r\n[boite] ${event.message}\r\n`);
      const current = currentThread();
      if (current && current.status !== "stopped") {
        app.setThreadStatus(thread.id, "error");
      }
    }
  }

  async function pasteFromClipboard() {
    const target = term;
    if (!target) return;
    try {
      const text = await readText();
      if (text) target.paste(text);
    } catch (err) {
      console.error("clipboard read failed:", err);
    } finally {
      focusTerminalSoon();
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
          void copySelection()
            .then(() => term?.clearSelection())
            .finally(focusTerminalSoon);
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
          focusTerminalSoon();
        },
      },
    ];
    ctxMenu = { x: e.clientX, y: e.clientY, items };
  }

  function closeContextMenu() {
    ctxMenu = null;
  }

  function stopSessionMonitor() {
    sessionMonitor?.stop();
    sessionMonitor = null;
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
    const isCtrlJ =
      e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      (code === "KeyJ" ||
        e.key === "j" ||
        e.key === "J" ||
        e.key === "\n" ||
        e.key === "LineFeed");
    if (
      isEnter &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      (settings.state.powershellNewline || isCodex)
    ) {
      return true;
    }
    return isCodex && isCtrlJ;
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

    const buffer = term.buffer.active;
    if (buffer.baseY > 0) {
      e.preventDefault();
      e.stopPropagation();
      term.scrollLines(lines);
      return false;
    }

    return true;
  }

  function helperTextarea(): HTMLTextAreaElement | null {
    return container?.querySelector(".xterm-helper-textarea") ?? null;
  }

  function syncMobileInput() {
    const ta = helperTextarea();
    if (!ta) return;
    if (mobile && !keyboardOpen) ta.setAttribute("inputmode", "none");
    else ta.removeAttribute("inputmode");
  }

  // Mobile input takeover. Android/Gboard drives xterm's helper textarea through
  // predictive composition + keyCode-229 events whose value-diffing duplicates
  // text: a tapped word-completion re-sends the whole line, deleted text comes
  // back on the next key. We block those events from ever reaching xterm
  // (capture-phase stopPropagation on the container, an ancestor of the
  // textarea, so xterm's own textarea listeners never fire) and translate the
  // intent-based `beforeinput`/composition events to PTY bytes ourselves:
  // nothing is sent mid-composition, so a completed word is sent exactly once.
  // The scratch textarea is kept empty between words so Backspace at line start
  // still emits a real key event we can forward. Desktop/hardware keyboards are
  // untouched — every handler early-returns when not in the mobile layout.
  let imeComposing = false;
  let disposeMobileInput: (() => void) | null = null;

  function clearHelperTextarea() {
    const ta = helperTextarea();
    if (ta && ta.value !== "") ta.value = "";
  }

  function onImeCompositionStart(e: Event) {
    if (!mobile) return;
    e.stopPropagation();
    imeComposing = true;
  }

  function onImeCompositionEnd(e: CompositionEvent) {
    if (!mobile) return;
    e.stopPropagation();
    imeComposing = false;
    sendInputText(e.data ?? "");
    clearHelperTextarea();
  }

  function onImeBeforeInput(e: InputEvent) {
    if (!mobile) return;
    e.stopPropagation();
    // Mid-composition keystrokes are committed together at compositionend.
    if (imeComposing || e.inputType === "insertCompositionText") return;
    switch (e.inputType) {
      case "insertText":
      case "insertReplacementText":
      case "insertFromPaste":
        if (e.cancelable) e.preventDefault();
        sendInputText(e.data ?? "");
        break;
      case "insertLineBreak":
      case "insertParagraph":
        if (e.cancelable) e.preventDefault();
        rawWrite("\r");
        break;
      case "deleteContentBackward":
        if (e.cancelable) e.preventDefault();
        rawWrite("\x7f");
        break;
      case "deleteWordBackward":
        if (e.cancelable) e.preventDefault();
        rawWrite("\x17"); // Ctrl+W
        break;
      case "deleteContentForward":
        if (e.cancelable) e.preventDefault();
        rawWrite("\x1b[3~");
        break;
    }
  }

  function onImeInput(e: Event) {
    if (!mobile) return;
    e.stopPropagation();
    // beforeinput already produced the bytes; keep the scratch buffer empty so
    // it can never accumulate a stale baseline (only when not mid-composition).
    if (!imeComposing) clearHelperTextarea();
  }

  // Keys the soft keyboard emits as real key events (empty field, or a hardware
  // key) rather than beforeinput. Handle them here and preventDefault so the
  // matching beforeinput never fires — no double send.
  function onImeKeyDown(e: KeyboardEvent) {
    if (!mobile) return;
    e.stopPropagation();
    if (imeComposing || e.keyCode === 229) return;
    const seq: string | null =
      e.key === "Backspace"
        ? "\x7f"
        : e.key === "Enter"
          ? "\r"
          : e.key === "Tab"
            ? "\t"
            : e.key === "Escape"
              ? "\x1b"
              : e.key === "ArrowUp"
                ? "\x1b[A"
                : e.key === "ArrowDown"
                  ? "\x1b[B"
                  : e.key === "ArrowRight"
                    ? "\x1b[C"
                    : e.key === "ArrowLeft"
                      ? "\x1b[D"
                      : null;
    if (seq === null) return; // printable: let beforeinput/composition handle it
    e.preventDefault();
    rawWrite(seq);
  }

  function onImeKeyOther(e: Event) {
    if (!mobile) return;
    e.stopPropagation();
  }

  function installMobileInput() {
    const el = container;
    if (!el) return;
    const cap = { capture: true } as const;
    el.addEventListener("compositionstart", onImeCompositionStart, cap);
    el.addEventListener("compositionend", onImeCompositionEnd as EventListener, cap);
    el.addEventListener("beforeinput", onImeBeforeInput as EventListener, cap);
    el.addEventListener("input", onImeInput, cap);
    el.addEventListener("keydown", onImeKeyDown as EventListener, cap);
    el.addEventListener("keypress", onImeKeyOther, cap);
    el.addEventListener("keyup", onImeKeyOther, cap);
    disposeMobileInput = () => {
      el.removeEventListener("compositionstart", onImeCompositionStart, cap);
      el.removeEventListener("compositionend", onImeCompositionEnd as EventListener, cap);
      el.removeEventListener("beforeinput", onImeBeforeInput as EventListener, cap);
      el.removeEventListener("input", onImeInput, cap);
      el.removeEventListener("keydown", onImeKeyDown as EventListener, cap);
      el.removeEventListener("keypress", onImeKeyOther, cap);
      el.removeEventListener("keyup", onImeKeyOther, cap);
    };
  }

  function toggleKeyboard() {
    keyboardOpen = !keyboardOpen;
    const ta = helperTextarea();
    if (!ta) return;
    if (keyboardOpen) {
      // Mutate then focus inside the click gesture so Android raises the
      // keyboard; doing it from an effect would not count as a user gesture.
      ta.removeAttribute("inputmode");
      ta.focus();
      // The keyboard is about to cover the bottom rows; bring the prompt back
      // above it. The visualViewport resize handles it too, but tapping the FAB
      // does not always emit one, so nudge once the viewport settles.
      setTimeout(() => term?.scrollToBottom(), 60);
    } else {
      ta.setAttribute("inputmode", "none");
      ta.blur();
    }
  }

  // The soft keyboard shrinks the layout (interactive-widget=resizes-content),
  // so the container's ResizeObserver already refits. Keep the prompt visible:
  // scroll the freshly resized terminal to the bottom once the reflow lands.
  function onViewportResize() {
    if (!mobile || !term || !visible) return;
    scheduleFit();
    requestAnimationFrame(() => term?.scrollToBottom());
  }

  function touchDist(t: TouchList): number {
    return Math.hypot(
      t[0].clientX - t[1].clientX,
      t[0].clientY - t[1].clientY,
    );
  }

  function onTouchStart(e: TouchEvent) {
    if (!mobile || !term) return;
    if (e.touches.length >= 2) {
      touchMode = "pinch";
      pinchStartDist = touchDist(e.touches);
      pinchStartFont = term.options.fontSize ?? 13;
      e.preventDefault();
    } else {
      touchMode = "scroll";
      scrollLastY = e.touches[0].clientY;
      scrollAccum = 0;
    }
  }

  function onTouchMove(e: TouchEvent) {
    if (!mobile || !term) return;
    if (touchMode === "pinch" && e.touches.length >= 2) {
      e.preventDefault();
      if (pinchStartDist <= 0) return;
      const ratio = touchDist(e.touches) / pinchStartDist;
      const next = Math.max(
        FONT_MIN,
        Math.min(FONT_MAX, Math.round(pinchStartFont * ratio)),
      );
      if (next !== term.options.fontSize) {
        term.options.fontSize = next;
        scheduleFit();
      }
      return;
    }
    if (touchMode === "scroll" && e.touches.length === 1) {
      const y = e.touches[0].clientY;
      scrollAccum += y - scrollLastY;
      scrollLastY = y;
      const rowPx = (term.options.fontSize ?? 13) * 1.25;
      const lines = Math.trunc(scrollAccum / rowPx);
      if (lines !== 0) {
        scrollAccum -= lines * rowPx;
        // Content follows the finger: drag up (lines<0) reveals newer output.
        term.scrollLines(-lines);
        e.preventDefault();
      }
    }
  }

  function onTouchEnd(e: TouchEvent) {
    if (e.touches.length === 0) {
      touchMode = "none";
    } else if (e.touches.length === 1) {
      // Pinch released one finger: hand back to scroll cleanly.
      touchMode = "scroll";
      scrollLastY = e.touches[0].clientY;
      scrollAccum = 0;
    }
  }

  async function spawn(reattach = false) {
    if (spawned || spawning || destroyed) {
      logger.debug(
        "spawn",
        `${thread.label}: skip — spawned=${spawned} spawning=${spawning} destroyed=${destroyed}`,
      );
      return;
    }
    const current = currentThread();
    // Idle threads spawn fresh. A reattach (a remote thread we detached for
    // visibility) re-opens even though the server still reports it running/ready
    // — ptyOpen attaches to the live PTY. Finished threads (done/exited/error)
    // never auto-respawn; relaunch is explicit via reloadThread + remount.
    const finished =
      current?.status === "done" ||
      current?.status === "exited" ||
      current?.status === "error" ||
      current?.status === "stopped";
    // A local PTY parked by a workspace switch is still alive: reattach (replay
    // its ring) instead of spawning fresh, same as an explicit reattach.
    // A remote thread the server already reports live (non-idle) is owned by the
    // server too — attach to replay its ring rather than skip it (the old guard
    // left it a black screen on first click) and never re-inject launch input.
    // Remote idle still spawns fresh so wrap-shell launch input is typed.
    const remote = !clientStatus();
    const liveRemote = remote && !finished && current?.status !== "idle";
    const reattaching =
      reattach ||
      liveRemote ||
      (clientStatus() && parkedLocal.has(thread.id));
    const attachable = reattaching && current?.status !== "idle";
    if (!current || finished || (current.status !== "idle" && !attachable)) {
      logger.debug(
        "spawn",
        `${thread.label}: skip — missing=${!current} status=${current?.status} reattach=${reattach}`,
      );
      return;
    }
    if (!term || !fit) {
      logger.warn(
        "spawn",
        `${thread.label}: skip — term=${!!term} fit=${!!fit}`,
      );
      scheduleSpawnRetry();
      return;
    }

    if (!hasUsableTerminalSize()) {
      logger.debug("spawn", `${thread.label}: retry — terminal not sized yet`);
      scheduleSpawnRetry();
      return;
    }

    try {
      fit.fit();
    } catch (err) {
      logger.warn("spawn", `${thread.label}: fit threw, retrying`, String(err));
      scheduleSpawnRetry();
      return;
    }

    const project = app.projects.find((p) => p.id === thread.projectId);
    if (!project) {
      term.write("\r\n[boite] no project found\r\n");
      return;
    }

    spawning = true;
    const cols = Math.max(2, term.cols || 80);
    const rows = Math.max(1, term.rows || 24);

    const userArgs = await buildResumeArgsAsync(thread, project.cwd);
    const plan = planDirectSpawn(thread.cmd, userArgs);
    plan.args = withPowershellFastFlags(
      plan.cmd,
      plan.args,
      settings.state.powershellNoProfile,
    );

    const spawnedAt = Date.now();

    // The reader thread can emit before invoke resolves with the pty id;
    // queue those events and flush them once the id is known.
    let channelPtyId: string | null = null;
    const earlyEvents: PtyEvent[] = [];
    const onEvent = (event: PtyEvent) => {
      if (channelPtyId === null) {
        earlyEvents.push(event);
        return;
      }
      handleEvent(event, channelPtyId);
    };

    try {
      const nextPtyId = await ptyOpen(
        {
          threadId: thread.id,
          spec: {
            cwd: project.cwd,
            cmd: plan.cmd,
            args: plan.args,
            cols,
            rows,
          },
          meta: {
            projectId: thread.projectId,
            label: thread.label,
            iconKey: thread.iconKey,
          },
        },
        onEvent,
        thread.origin,
      );
      const current = currentThread();
      if (destroyed || !term || !current || current.status === "stopped") {
        void ptyKill(nextPtyId, true).catch(() => {});
        return;
      }
      ptyId = nextPtyId;
      spawned = true;
      channelPtyId = nextPtyId;
      parkedLocal.delete(thread.id);
      for (const event of earlyEvents.splice(0)) {
        handleEvent(event, nextPtyId);
      }
      spawnRetryCount = 0;
      app.setThreadPtyId(thread.id, ptyId);
      app.setThreadStatus(thread.id, "ready");
      logger.info(
        "spawn",
        `${thread.label} (${thread.iconKey ?? "?"}): ${reattaching ? "reattached" : "spawned"}`,
        {
          cmd: plan.cmd,
          args: plan.args,
          cwd: project.cwd,
          reattaching,
        },
      );
    } catch (err) {
      term?.write(`\r\n[boite] spawn failed: ${err}\r\n`);
      if (!destroyed && currentThread()?.status !== "stopped") {
        app.setThreadStatus(thread.id, "error");
      }
      logger.error("spawn", `${thread.label}: spawn failed`, String(err));
      return;
    } finally {
      spawning = false;
    }

    const detector = getDetector(thread);
    if (!reattaching && detector && ptyId) {
      const since = Math.max(0, spawnedAt - (thread.sessionId ? 1000 : 5000));
      stopSessionMonitor();
      sessionMonitor = startSessionMonitor({
        threadId: thread.id,
        cwd: project.cwd,
        detector,
        since,
        targetPtyId: ptyId,
        isPtyCurrent: (id) => ptyId === id,
        lastActivityAt: () => Math.max(lastInputAt, lastOutputAt),
      });
    }
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
      theme: xtermTheme(),
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
        consumeTerminalShortcut(e);
        void copySelection();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && code === "KeyV") {
        consumeTerminalShortcut(e);
        void pasteFromClipboard();
        return false;
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && code === "KeyC") {
        const sel = term?.getSelection();
        if (sel) {
          consumeTerminalShortcut(e);
          void copySelection().then(() => term?.clearSelection());
          return false;
        }
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && code === "KeyV") {
        consumeTerminalShortcut(e);
        void pasteFromClipboard();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && !e.altKey && code === "KeyT") {
        e.preventDefault();
        e.stopPropagation();
        void restoreLastClosedThread();
        return false;
      }
      // Command palette combos never reach the shell; the layout handler
      // (window keydown, still bubbling) opens it. On macOS the palette is
      // Cmd+K, so Ctrl+K stays with the shell (readline kill-line).
      if (e.ctrlKey && !e.shiftKey && !e.altKey && code === "KeyK" && !platform.isMacOS) {
        e.preventDefault();
        return false;
      }
      if (e.metaKey && !e.shiftKey && !e.altKey && code === "KeyK" && platform.isMacOS) {
        e.preventDefault();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && !e.altKey && code === "KeyP") {
        e.preventDefault();
        return false;
      }

      if (shouldSendLineFeed(e, code)) {
        return sendLineFeed(e);
      }

      return true;
    });

    term.attachCustomWheelEventHandler(handleCodexWheel);

    // Registered once for the component's lifetime. These used to be
    // re-registered at the end of every spawn(), stacking one handler per
    // respawn and duplicating every keystroke N times into the live PTY.
    term.onData((data) => {
      if (!shouldUsePty(ptyId)) return;
      syncAliveThread();
      lastInputAt = Date.now();
      if ((ctrlArmed || altArmed) && data.length === 1) {
        emitChar(data);
        return;
      }
      const bytes = encoder.encode(data);
      void ptyWrite(ptyId, bytes);
    });

    term.onResize(({ cols, rows }) => {
      if (!shouldUsePty(ptyId)) return;
      void ptyResize(ptyId, cols, rows);
    });

    term.open(container);
    // Set inputmode before the focus below so the phone keyboard never flashes.
    syncMobileInput();
    installMobileInput();

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL unavailable (e.g. webkit2gtk without GPU). Fall back to DOM renderer.
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
      void spawn();
    });

    resizeObserver = new ResizeObserver(() => {
      scheduleFit();
    });
    resizeObserver.observe(container);

    container.addEventListener("touchstart", onTouchStart, { passive: false });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd);
    container.addEventListener("touchcancel", onTouchEnd);

    window.visualViewport?.addEventListener("resize", onViewportResize);

    // The status engine (TTL demotion, idle auto-close) is local only: remote
    // status comes from the server, and a local idle timer must not kill PTYs
    // shared with other attached devices.
    if (clientStatus()) {
      statusEngine.acquire();
      statusEngineAcquired = true;
    }
  });

  $effect(() => {
    if (visible && term) {
      queueMicrotask(() => {
        fit?.fit();
        void spawn();
      });
    }
  });

  // Drop the output stream of a hidden remote thread on phones: the server keeps
  // the PTY (and its scrollback ring) alive, status/title still arrive as
  // control events, and the pane reattaches with just the delta when shown.
  // Desktop and local keep every pane streaming for instant switching.
  $effect(() => {
    const shown = visible;
    if (!term) return;
    const remote = !clientStatus();
    if (!remote || !mobile) return;
    const cur = currentThread();
    const finished =
      cur?.status === "done" ||
      cur?.status === "exited" ||
      cur?.status === "error" ||
      cur?.status === "stopped";
    if (finished) return;
    if (shown) {
      if (released && !spawned && !spawning) {
        released = false;
        void spawn(true);
      }
    } else if (spawned && ptyId) {
      released = true;
      releasePty();
    }
  });

  $effect(() => {
    if (thread.status === "stopped") {
      stopLocalPty(false);
    }
  });

  // Nothing is listening: a finished thread has no PTY left and an idle one has
  // not opened its yet (status flips to ready in the same breath as ptyOpen), so
  // keystrokes would land nowhere while the caret kept implying otherwise.
  $effect(() => {
    if (term) term.options.disableStdin = finished || thread.status === "idle";
  });

  $effect(() => {
    if (focused && term) {
      queueMicrotask(() => term?.focus());
    }
  });

  $effect(() => {
    // Track both so the textarea flips when the layout toggles or the
    // keyboard button is pressed.
    void mobile;
    void keyboardOpen;
    if (term) syncMobileInput();
  });

  // Opening/closing the CLI key bar resizes the terminal; keep the prompt in
  // view (the ResizeObserver refits but does not scroll).
  $effect(() => {
    void showKeyBar;
    if (mobile && term && visible) {
      requestAnimationFrame(() => term?.scrollToBottom());
    }
  });

  onDestroy(() => {
    destroyed = true;
    if (statusEngineAcquired) statusEngine.release(thread.id);
    stopSessionMonitor();
    disposeMobileInput?.();
    disposeMobileInput = null;
    releasePty();
    if (fitRafId !== null) cancelAnimationFrame(fitRafId);
    fitRafId = null;
    resizeObserver?.disconnect();
    container?.removeEventListener("touchstart", onTouchStart);
    container?.removeEventListener("touchmove", onTouchMove);
    container?.removeEventListener("touchend", onTouchEnd);
    container?.removeEventListener("touchcancel", onTouchEnd);
    window.visualViewport?.removeEventListener("resize", onViewportResize);
    term?.dispose();
    term = null;
    fit = null;
  });
</script>

<div
  class="relative flex h-full w-full flex-col overflow-hidden bg-[var(--color-background)]"
  oncontextmenu={openTerminalContextMenu}
  role="presentation"
>
  <div class="relative min-h-0 flex-1 px-3 py-2">
    <div
      bind:this={container}
      class="h-full w-full min-h-0 overflow-hidden"
      class:touch-none={mobile}
    ></div>
    {#if thread.status === "stopped"}
      <div
        class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black text-xs text-muted-foreground/60"
      >
        ( -_-) zzZ
      </div>
    {:else if thread.status === "done" || thread.status === "exited" || thread.status === "error"}
      <div class="absolute inset-x-0 bottom-3 z-10 flex justify-center">
        <button
          type="button"
          class="rounded-md border border-border bg-[var(--color-surface)] px-3 py-1 text-xs text-muted-foreground shadow-lg transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
          onclick={() => void reloadThread(thread.id)}
        >
          {thread.status === "done"
            ? "Process finished"
            : thread.status === "error"
              ? "Spawn failed"
              : `Process exited (code ${thread.exitCode ?? "?"})`}
          — click to relaunch
        </button>
      </div>
    {/if}
    {#if mobile && focused && !finished}
      <button
        type="button"
        class="absolute bottom-3 right-3 z-20 flex size-11 items-center justify-center rounded-full border shadow-lg transition active:scale-95"
        style:background-color={keyboardOpen || keyBarOpen
          ? "var(--color-foreground)"
          : "var(--color-surface-2)"}
        style:color={keyboardOpen || keyBarOpen
          ? "var(--color-background)"
          : "var(--color-foreground)"}
        style:border-color={keyBarOpen
          ? "var(--color-foreground)"
          : "var(--color-border)"}
        onpointerdown={fabDown}
        onpointerup={fabUp}
        onpointercancel={fabCancel}
        onpointerleave={fabCancel}
        aria-label="Keyboard (long-press for key bar)"
        title="Tap: keyboard · Long-press: key bar"
      >
        <Keyboard class="size-5" />
      </button>
    {/if}
  </div>

  {#if showKeyBar}
    <div
      class="flex shrink-0 items-stretch gap-1 border-t border-border bg-[var(--color-surface)] px-1 py-1"
    >
      <div class="keybar-scroll flex flex-1 items-stretch gap-1 overflow-x-auto">
        {#each BAR_KEYS as k (k.id)}
          {@const armed =
            k.id === "ctrl" ? ctrlArmed : k.id === "alt" ? altArmed : false}
          <button
            type="button"
            class="flex h-9 min-w-9 shrink-0 items-center justify-center rounded-md border border-border px-2 text-[13px] font-medium transition active:scale-95"
            style:background-color={armed
              ? "var(--color-foreground)"
              : "var(--color-surface-2)"}
            style:color={armed
              ? "var(--color-background)"
              : "var(--color-foreground)"}
            onpointerdown={(e) => {
              keepFocus(e);
              pressBarKey(k.id);
            }}
          >
            {k.label}
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  /* A scrollbar inside the 36px key strip would eat a third of it. */
  .keybar-scroll {
    scrollbar-width: none;
  }
  .keybar-scroll::-webkit-scrollbar {
    display: none;
  }
</style>

{#if ctxMenu}
  <ContextMenu
    items={ctxMenu.items}
    x={ctxMenu.x}
    y={ctxMenu.y}
    onClose={closeContextMenu}
  />
{/if}
