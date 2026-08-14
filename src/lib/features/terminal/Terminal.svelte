<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { Unicode11Addon } from "@xterm/addon-unicode11";
  import { xtermFontFamily, xtermTheme } from "./theme";
  import { encodeBarKey, encodeText, isLineFeed, wheelLines, type Press } from "./keys";
  import { installMobileInput } from "./mobile-input";
  import { Touches } from "./touch";
  import { registerTerminal, unregisterTerminal } from "$lib/shared/terminals";
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
  import { backendFor } from "$lib/backend";
  import { parkedLocal } from "$lib/backend/tauri/parked";
  import { app } from "$lib/app/store.svelte";
  import { isFinished } from "$lib/domain/thread-status";
  import { settings } from "$lib/features/settings/store.svelte";
  import { threadCwd } from "$lib/features/thread/cwd";
  import {
    promoteThread,
    reloadThread,
    restoreLastClosedThread,
    threadDirectoryReady,
    worktreeWaitTimedOut,
  } from "$lib/features/thread/api";
  import {
    buildResumeArgsAsync,
    getDetector,
    resolveKey,
  } from "$lib/features/thread/session";
  import { decideSpawn, launchPlan } from "./launch";
  import { keyIntent } from "./key-intent";
  import { claimTypedPrompt } from "$lib/features/thread/typedPrompt";
  import { noteUserInput } from "$lib/features/thread/user-activity.svelte";
  import { parsePromotion, PROMOTE_OSC } from "$lib/features/thread/promote";
  import { isDeviceMacOS } from "$lib/storage/platform.svelte";
  import {
    startSessionMonitor,
    type SessionMonitor,
  } from "$lib/features/thread/session-monitor.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { logger } from "$lib/shared/services/logger.svelte";
  import { isGenericTitle } from "$lib/features/thread/title-filter";
  import { statusEngine } from "$lib/features/thread/statusEngine";
  import { SpawnTiming } from "$lib/features/thread/spawn-timing";
  import { longPress } from "$lib/shared/actions/longPress";
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
  let spawnRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let spawnRetryCount = 0;
  const SPAWN_RETRY_MAX = 30;
  // The launch currently being measured, and when this pane was mounted.
  //
  // The timing outlives the `spawn()` call that made it: the line is written on
  // the first byte the process prints, which arrives after `spawn()` has
  // returned, and the pane is what still exists then. The mount stamp is the
  // other half of the same question, because a thread that took six seconds to
  // show anything spent most of them before `spawn()` was ever called, waiting
  // on a pane that had no measured size yet.
  let launchTiming: SpawnTiming | null = null;
  let mountedAt = 0;
  // Which launch the pane is on. A relaunch bumps it, and a spawn that was
  // mid-flight when that happened reads its own number as stale and drops the
  // process it opened instead of installing it over the newer one. This is what
  // the component's remount used to provide: `destroyed` made the in-flight
  // spawn throw its PTY away.
  let spawnGeneration = 0;
  // The relaunch nonce this pane has already acted on. Null until the effect
  // below takes its baseline, which is how a real bump is told apart from that
  // effect's own first run.
  let respawnSeen: number | null = null;
  let ctxMenu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(
    null,
  );
  let lastOutputAt = 0;
  let sessionMonitor: SessionMonitor | null = null;
  let fitRafId: number | null = null;
  let fitSettleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastInputAt = 0;
  const encoder = new TextEncoder();
  const LF = new Uint8Array([0x0a]);

  // Output goes to xterm and nowhere else. Working detection used to keep its
  // own rolling window of these bytes; it reads the rows back off `term` now
  // (`thread/statusEngine.ts`), which is the same information without a copy
  // that can go stale.

  // Soft keyboard is opt-in on phones: tapping a terminal should focus it for
  // scroll/select without summoning the Android keyboard. `inputmode=none`
  // keeps the textarea focusable (key routing, hardware keyboards) but stops
  // the virtual keyboard; the floating button flips it on demand.
  let keyboardOpen = $state(false);
  const FONT_MIN = 8;
  const FONT_MAX = 32;
  // What 100% zoom means. The UI scale is applied as a root font-size, which a
  // canvas-drawn terminal cannot inherit, so the multiplication happens here:
  // the slider used to grow every box around the terminal and leave the text
  // inside it exactly where it was.
  const FONT_BASE = 13;
  let touchMode: "none" | "pinch" | "scroll" = "none";
  let pinchStartDist = 0;
  // Pinch rides on top of the UI scale rather than replacing it, so a pinched
  // pane still follows a later move of the slider.
  let pinchFactor = $state(1);
  let pinchStartFactor = 1;
  const fontSize = $derived(
    Math.max(
      FONT_MIN,
      Math.min(
        FONT_MAX,
        Math.round((FONT_BASE * settings.state.uiScalePercent * pinchFactor) / 100),
      ),
    ),
  );
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
  const finished = $derived(isFinished(thread.status));
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
  function rawWrite(s: string) {
    if (!shouldUsePty(ptyId)) return;
    lastInputAt = Date.now();
    // The one funnel every keystroke passes through, xterm's onData and the
    // phone's key bar alike, which is why the "what was I last on" order is
    // stamped here rather than anywhere that also sees the agent's own output.
    noteUserInput(thread.id, lastInputAt);
    void ptyWrite(ptyId, encoder.encode(s));
  }

  /** The two armed modifiers, as `keys` wants them. */
  function modifiers() {
    return { ctrl: ctrlArmed, alt: altArmed };
  }

  function applyPress(press: Press) {
    ctrlArmed = press.modifiers.ctrl;
    altArmed = press.modifiers.alt;
    if (press.send !== null) rawWrite(press.send);
  }

  // Text from the mobile input takeover, and from xterm's own onData.
  function sendInputText(data: string) {
    applyPress(encodeText(data, modifiers()));
  }

  function pressBarKey(id: string) {
    const press = encodeBarKey(id, modifiers());
    applyPress(press);
    // Focus goes back to the terminal on anything that sent. A modifier tap
    // leaves it where it is, because the next tap is on the bar too.
    if (press.send !== null) term?.focus();
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
      if (!visible) return;
      fit?.fit();
      loadWebgl();
    });
  }

  // Whether the WebGL renderer is on, or has been given up on.
  let webglSettled = false;

  /**
   * Hands rendering to the GPU, but only once the cell has a measured size.
   *
   * `WebglRenderer` acquires its glyph atlas once, from the cell dimensions it
   * finds at that moment, and a terminal whose box is not laid out yet has none:
   * `_refreshCharAtlas` returns without one, `GlyphRenderer.render` returns
   * early for the rest of that atlas's life, and `renderBackgrounds` keeps
   * drawing. That is a pane painting every diff block, every agent panel and
   * every selection in the right place with no text in any of them, until some
   * later pass — the cursor blink, the next byte out of the PTY — happens to
   * retry the atlas. It lasted seconds, and it was the whole screen.
   *
   * The addon used to load in the same breath as `term.open()`, before the first
   * fit, which is exactly when a freshly mounted pane has nothing measured yet.
   * `proposeDimensions()` is the public form of the same question the renderer
   * asks itself: it answers `undefined` while the cell is 0x0. So this is called
   * after every fit instead, and the terminal spends the meantime on the DOM
   * renderer, which needs no atlas and shows its text.
   */
  function loadWebgl() {
    if (webglSettled || !term) return;
    let measured = false;
    try {
      measured = !!fit?.proposeDimensions();
    } catch {
      measured = false;
    }
    if (!measured) return;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL unavailable (e.g. webkit2gtk without GPU). Fall back to DOM
      // renderer, and stop asking: it will not appear later.
    }
    webglSettled = true;
  }

  // Coalescing to one fit per frame is not enough for a splitter drag: the
  // ResizeObserver fires continuously, and every fit() re-measures the character
  // cell and reflows the whole buffer, so a drag cost 60 full passes a second per
  // visible pane. Refit once at the start so the resize is visible, then once the
  // pointer settles.
  const FIT_SETTLE_MS = 60;

  function scheduleSettledFit() {
    if (fitSettleTimer === null) scheduleFit();
    else clearTimeout(fitSettleTimer);
    fitSettleTimer = setTimeout(() => {
      fitSettleTimer = null;
      scheduleFit();
    }, FIT_SETTLE_MS);
  }

  function cleanTitle(raw: string): string {
    const m = raw.match(/[\p{L}\p{N}]/u);
    if (!m || m.index === undefined) return raw.trim();
    return raw.slice(m.index).trim();
  }

  // A thread that has a PTY is connected, and this is where that becomes
  // visible: it leaves `idle` on the first byte or title that arrives. Which of
  // `ready` and `running` it then is belongs to the status engine, which reads
  // it off the rows. Promoting from here as well only ever made the two fight,
  // and a promotion per output chunk is what made the dot flap.
  function syncAliveThread(known?: Thread | null) {
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
      app.setThreadStatus(thread.id, "ready", null);
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
      return;
    }

    if (event.type === "output") {
      const current = currentThread();
      if (!current || current.status === "stopped") return;
      syncAliveThread(current);
      lastOutputAt = Date.now();
      term.write(event.bytes);
      // Only a hint that the PTY is alive, which is all auto-sleep needs from
      // it. Remote threads take their status from the server, so not even that.
      if (clientStatus()) statusEngine.markOutput(thread.id);
    } else if (event.type === "title") {
      const current = currentThread();
      if (!current || current.status === "stopped") return;
      syncAliveThread(current);
      const cleaned = cleanTitle(event.value);
      const cwd =
        threadCwd(current, app.projects.find((p) => p.id === thread.projectId)) ?? undefined;
      if (cleaned && !isGenericTitle(cleaned, cwd)) {
        app.setThreadTitle(thread.id, cleaned);
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
      // Said out loud, not only logged: Ctrl+V that quietly does nothing reads
      // as a dead keybinding rather than as a clipboard the OS refused us.
      logger.error("terminal", "clipboard read failed", String(err));
      notifications.error(t("terminal.pasteFailed"));
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
      logger.error("terminal", "clipboard write failed", String(err));
      notifications.error(t("terminal.copyFailed"));
    }
    return true;
  }

  function terminalMenuItems(): ContextMenuItem[] {
    const sel = term?.getSelection();
    return [
      {
        label: t("terminal.copy"),
        disabled: !sel,
        action: () => {
          void copySelection()
            .then(() => term?.clearSelection())
            .finally(focusTerminalSoon);
        },
      },
      {
        label: t("terminal.paste"),
        action: () => {
          void pasteFromClipboard();
        },
      },
      { separator: true },
      {
        label: t("terminal.reloadThread"),
        action: () => {
          void reloadThread(thread.id);
          focusTerminalSoon();
        },
      },
    ];
  }

  function openTerminalContextMenu(e: MouseEvent) {
    e.preventDefault();
    if (!term) return;
    ctxMenu = { x: e.clientX, y: e.clientY, items: terminalMenuItems() };
  }

  // A finger held on the screen, which is the only right-click a phone has:
  // iOS never raises `contextmenu`, and the container claims every touch for
  // pinch-zoom and scroll, so Copy/Paste/Reload had no way in at all.
  function openTerminalMenuAt(x: number, y: number) {
    if (!term) return;
    // A pinch is a zoom, not a press. The second finger landing restarts the
    // press timer, so without this the menu would open mid-gesture.
    if (touchMode === "pinch") return;
    ctxMenu = { x, y, items: terminalMenuItems() };
    navigator.vibrate?.(10);
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
      notifications.error(t("terminal.openLinkFailed"));
    }
  }

  function shouldSendLineFeed(e: KeyboardEvent, code: string): boolean {
    return isLineFeed(e, code, {
      codex: thread.iconKey === "codex",
      powershellNewline: settings.state.powershellNewline,
    });
  }

  function sendLineFeed(e: KeyboardEvent): boolean {
    e.preventDefault();
    e.stopPropagation();
    if (ptyId) {
      noteUserInput(thread.id);
      void ptyWrite(ptyId, LF);
    }
    queueMicrotask(() => term?.focus());
    return false;
  }

  function handleCodexWheel(e: WheelEvent): boolean {
    if (thread.iconKey !== "codex" || e.ctrlKey || e.metaKey || !term) return true;
    if (e.deltaY === 0) return true;

    const lines = wheelLines(e.deltaY, e.deltaMode, term.rows);
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

  let disposeMobileInput: (() => void) | null = null;

  function clearHelperTextarea() {
    const ta = helperTextarea();
    if (ta && ta.value !== "") ta.value = "";
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

  const touches = new Touches();

  function onTouchStart(e: TouchEvent) {
    if (!mobile || !term) return;
    touches.start(e.touches, pinchFactor);
    if (touches.mode === "pinch") e.preventDefault();
  }

  function onTouchMove(e: TouchEvent) {
    if (!mobile || !term) return;
    // A pinch always owns the event, gesture or not: letting one through is the
    // browser zooming the whole page under a canvas that has its own idea of a
    // font size.
    if (touches.mode === "pinch") e.preventDefault();
    const gesture = touches.move(e.touches, fontSize * 1.25);
    if (gesture.kind === "zoom") {
      // Only the factor moves; `fontSize` clamps it against FONT_MIN/FONT_MAX
      // and the effect below applies the result and refits.
      pinchFactor = Math.max(0.25, Math.min(4, gesture.factor));
      return;
    }
    if (gesture.kind === "scroll") {
      term.scrollLines(gesture.lines);
      e.preventDefault();
    }
  }

  function onTouchEnd(e: TouchEvent) {
    touches.end(e.touches);
  }

  async function spawn(reattach = false) {
    const generation = spawnGeneration;
    const current = currentThread();
    // Whether to open at all, and whether opening means attaching to something
    // already running. Both live in `launch.ts`, where they can be tested: every
    // bug this function has had was in that verdict, and it was reachable only
    // through a mounted component with a live PTY behind it.
    const verdict = decideSpawn({
      spawned,
      spawning,
      destroyed,
      status: current?.status ?? null,
      reattach,
      clientStatus: clientStatus(),
      parked: parkedLocal.has(thread.id),
    });
    if (!verdict.go) {
      const said = `${thread.label}: not opening — ${verdict.why}`;
      if (verdict.level === "info") logger.info("spawn", said);
      else logger.debug("spawn", said);
      return;
    }
    const reattaching = verdict.reattaching;
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

    // A relaunch landing on a pane whose previous launch never printed a byte:
    // that measurement is over, and leaving it pending would let the older
    // launch write the line for the newer one's first output.
    launchTiming?.report("abandoned", { because: "relaunched" });
    const timing = new SpawnTiming(thread.label);
    launchTiming = timing;
    timing.start();
    // Whether this launch got as far as installing its PTY, which is what tells
    // an abandoned launch apart from one still on its way to a line of its own.
    let installed = false;
    let sawOutput = false;
    // Both read now rather than at report time, because both are gone by then:
    // the line is written after the first byte, and a successful install has
    // already put the retry count back to zero.
    const sinceMountMs = mountedAt ? Date.now() - mountedAt : null;
    const retries = spawnRetryCount;

    // Everything from here down runs with the flag latched, so it is wrapped:
    // the only way out is the `finally`. It used to be cleared inside the
    // spawn's own try and at each early return, which left the awaits above that
    // block able to reject and latch it true forever — and then
    // `if (!spawning) void spawn()` in respawnInPlace makes every later relaunch
    // a silent no-op. The component remount used to cure that; there is no
    // remount any more.
    try {
      // A just-created thread may still be having its worktree made. This wait
      // is what lets it appear in the sidebar the moment it is clicked: the
      // directory is settled off the click path, and only the PTY blocks on it.
      // Held after `spawning` is set so a retry cannot slip past and open a
      // second PTY in the meantime.
      //
      // It used to be a symlink and finished before anyone could see it. It now
      // copies the build output, which is seconds on a large repository, and an
      // unexplained black screen for that long reads as a terminal that failed
      // to open. Announced on a delay rather than always, so the ordinary case
      // is still a clean screen.
      const ready = threadDirectoryReady(thread.id);
      const screen = term;
      let notice: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        notice = null;
        if (!destroyed) screen.write("\r\n[boite] preparing an isolated worktree…\r\n");
      }, 400);
      await ready;
      if (notice) clearTimeout(notice);
      // Marked whether or not it waited: a zero here is the answer to "was it
      // the worktree?", and only a phase that is always present can give it.
      timing.mark("worktree");
      if (destroyed) return;
      // The wait has an end now, and reaching it is not the same thing as
      // getting a worktree. Said on screen because the difference is invisible
      // otherwise: the terminal opens, it works, and it is writing in the
      // user's own checkout rather than in an isolated one.
      if (worktreeWaitTimedOut(thread.id)) {
        term.write("\r\n[boite] no worktree came back — starting in the project folder\r\n");
      }
      // Relaunched while the directory was being settled. Nothing has been
      // opened yet, so handing over to the newer launch — which the `finally`
      // below does — is the whole cleanup.
      if (generation !== spawnGeneration) return;

      const cols = Math.max(2, term.cols || 80);
      const rows = Math.max(1, term.rows || 24);

      // Resolved once: the session lookup below matches on an exact cwd, so a
      // thread whose PTY starts in a worktree and whose transcripts are searched
      // under the project folder finds nothing and silently loses `--resume`.
      const cwd = threadCwd(thread, project) ?? project.cwd;

      const plan = launchPlan({
        cmd: thread.cmd,
        userArgs: await buildResumeArgsAsync(thread, cwd),
        iconKey: thread.iconKey,
        defaultShellId: settings.state.defaultShellId,
        powershellNoProfile: settings.state.powershellNoProfile,
      });
      const wrap = plan.wrap;
      // Everything between the worktree and the PTY: the resume lookup, which
      // searches a transcript store, and the launch plan. It is the phase most
      // likely to grow without anybody noticing, because it grows with the
      // user's history rather than with this code.
      timing.mark("resume");

      const spawnedAt = Date.now();

      // What the line says besides its durations. Built here because the
      // deadline below can write it long after `spawn()` has returned, and the
      // pane is the only thing still holding these by then.
      const launchDetail = () => ({
        cmd: plan.cmd,
        args: plan.args,
        cwd,
        reattaching,
        wrapShell: wrap?.shellId ?? null,
        iconKey: thread.iconKey ?? null,
        // A pane that was mounted seconds before the launch started spent them
        // being retried for want of a measured size, and that time is invisible
        // in the phases: they only start when the launch does.
        sinceMountMs,
        retries,
      });
      const reportLaunch = (extra?: Record<string, unknown>) =>
        timing.report(reattaching ? "reattached" : "spawned", {
          ...launchDetail(),
          ...extra,
        });

      // The first byte the process printed, which is what a user means by the
      // terminal having opened: a live PTY with nothing on screen looks exactly
      // like one that failed. Recorded whenever it arrives, including before
      // `open` resolves, but not written down until there is a PTY to write it
      // about.
      const noteOutput = () => {
        if (sawOutput || !timing.pendingReport) return;
        sawOutput = true;
        timing.mark("output");
        if (installed) reportLaunch();
      };

      // The reader thread can emit before invoke resolves with the pty id;
      // queue those events and flush them once the id is known.
      let channelPtyId: string | null = null;
      const earlyEvents: PtyEvent[] = [];
      const onEvent = (event: PtyEvent) => {
        if (event.type === "output") noteOutput();
        if (channelPtyId === null) {
          earlyEvents.push(event);
          return;
        }
        // The backend respawned this thread's PTY under a new id. Taken here
        // rather than in `handleEvent`, which gates every event on the id it is
        // about to replace, and which cannot reach this closure's own copy.
        if (event.type === "key") {
          if (ptyId !== channelPtyId) return;
          channelPtyId = event.key;
          ptyId = event.key;
          app.setThreadPtyId(thread.id, event.key);
          return;
        }
        handleEvent(event, channelPtyId);
      };

      try {
        const nextPtyId = await ptyOpen(
          {
            threadId: thread.id,
            spec: {
              cwd,
              cmd: plan.cmd,
              args: plan.args,
              cols,
              rows,
              wrap,
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
        timing.mark("pty");
        const current = currentThread();
        if (
          destroyed ||
          !term ||
          !current ||
          current.status === "stopped" ||
          // A relaunch landed while this one was opening. Installing this PTY
          // would leave the pane on the process the user asked to replace, and
          // the newer launch with nowhere to go.
          generation !== spawnGeneration
        ) {
          void ptyKill(nextPtyId, true).catch(() => {});
          return;
        }
        ptyId = nextPtyId;
        spawned = true;
        installed = true;
        channelPtyId = nextPtyId;
        parkedLocal.delete(thread.id);
        for (const event of earlyEvents.splice(0)) {
          handleEvent(event, nextPtyId);
        }
        spawnRetryCount = 0;
        app.setThreadPtyId(thread.id, ptyId);
        app.setThreadStatus(thread.id, "ready");
        // A thread whose CLI takes no positional prompt carries its opening line
        // here instead. Typed, never submitted — the same rule the Todo panel
        // follows, and for the same reason: an agent turn is expensive and hard
        // to call back, so the Enter is the user's.
        //
        // Only on a real spawn. Reattaching means the agent is already mid-
        // conversation, and claiming is one-shot so a respawn cannot repeat it.
        if (!reattaching) {
          const opening = claimTypedPrompt(thread.id);
          if (opening && ptyId) {
            // The user's own words, so it stamps the order like anything else
            // they type. The spawn itself does not: a respawn the app decided on
            // is not the user coming back to this thread.
            noteUserInput(thread.id);
            void ptyWrite(ptyId, encoder.encode(opening)).catch((err) => {
              logger.warn("spawn", `could not type the opening prompt`, String(err));
            });
          }
        }
        // The line is written on the first byte rather than here, because a PTY
        // that came back in 40ms and printed nothing for eight seconds is the
        // case worth seeing, and a line written here calls that one fast. The
        // deadline is what stops a shell that legitimately prints nothing from
        // costing the launch its only record.
        if (sawOutput) reportLaunch();
        else timing.opened(() => reportLaunch({ output: "none" }));
      } catch (err) {
        term?.write(`\r\n[boite] spawn failed: ${err}\r\n`);
        // Not for a launch that has already been superseded: an error status is
        // a finished thread, and the relaunch waiting behind this one would be
        // refused for the failure of the attempt it replaced.
        if (
          !destroyed &&
          generation === spawnGeneration &&
          currentThread()?.status !== "stopped"
        ) {
          app.setThreadStatus(thread.id, "error");
        }
        timing.report("failed", { ...launchDetail(), error: String(err) });
        return;
      }

      // An attach gets one too. The agent it is attaching to may have started a
      // conversation nobody wrote down — a thread parked before its first scan
      // could bind, a workspace switched away from and back — and skipping the
      // monitor there left that thread unbound for the rest of its life, so its
      // next relaunch opened a blank agent. Nothing is bound twice: a scan that
      // returns the session already on the row is a no-op.
      const detector = getDetector(thread);
      if (detector && ptyId) {
        const since = Math.max(0, spawnedAt - (thread.sessionId ? 1000 : 5000));
        stopSessionMonitor();
        sessionMonitor = startSessionMonitor({
          threadId: thread.id,
          cwd,
          // Same resolution the detector was picked with, so the two never
          // disagree on which agent this thread is.
          kind: resolveKey(thread) as string,
          detector,
          since,
          targetPtyId: ptyId,
          isPtyCurrent: (id) => ptyId === id,
          lastActivityAt: () => Math.max(lastInputAt, lastOutputAt),
        });
      }
    } finally {
      spawning = false;
      // Every way out of the block above that did not install a PTY: destroyed
      // mid-wait, superseded by a relaunch, no project, killed on arrival. None
      // of them is a launch anybody is waiting on, and leaving the timing armed
      // would have its stall watchdog fire about a thread that stopped being
      // launched fifteen seconds earlier.
      if (!installed) timing.report("abandoned", { because: "left before the pty was installed" });
      // Whatever this attempt did with its own PTY, the launch the user is
      // actually waiting for has not started yet, and this is the attempt that
      // has to hand over to it.
      if (!destroyed && !spawned && generation !== spawnGeneration) void spawn();
    }
  }

  onMount(() => {
    // One line per pane, and it exists to split a silence in two. A thread that
    // never opens leaves the same nothing in the log whether its terminal was
    // never mounted — the pane is gated on a group and a measured rect, and
    // failing either draws no terminal at all — or was mounted and refused to
    // spawn. Those are different bugs in different files, and without this the
    // log cannot say which one is being looked at.
    logger.info("terminal", `${thread.label}: pane mounted`);
    mountedAt = Date.now();
    term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize,
      fontFamily: xtermFontFamily(),
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

    // A launcher telling us what it turned this thread into. Returning false for anything
    // that is not ours leaves OSC 1337 to whoever else claims it.
    term.parser.registerOscHandler(PROMOTE_OSC, (payload) => {
      const promotion = parsePromotion(payload);
      if (!promotion) return false;
      void promoteThread(thread.id, promotion);
      return true;
    });

    term.attachCustomKeyEventHandler((e) => {
      // What the key means is `key-intent.ts`; what to do about it is here.
      // Splitting the two is what made the branch deciding whether Ctrl+C
      // copies or interrupts reachable by a test at all.
      const intent = keyIntent(
        e,
        { isMacOS: isDeviceMacOS, hasSelection: () => !!term?.getSelection() },
        shouldSendLineFeed(e, e.code),
      );
      switch (intent) {
        case "copy":
          consumeTerminalShortcut(e);
          void copySelection();
          return false;
        case "copy-and-clear":
          consumeTerminalShortcut(e);
          void copySelection().then(() => term?.clearSelection());
          return false;
        case "paste":
          consumeTerminalShortcut(e);
          void pasteFromClipboard();
          return false;
        case "restore-thread":
          consumeTerminalShortcut(e);
          void restoreLastClosedThread();
          return false;
        case "swallow":
          e.preventDefault();
          return false;
        case "line-feed":
          return sendLineFeed(e);
        case "pass":
          return true;
      }
    });

    term.attachCustomWheelEventHandler(handleCodexWheel);

    // Registered once for the component's lifetime. These used to be
    // re-registered at the end of every spawn(), stacking one handler per
    // respawn and duplicating every keystroke N times into the live PTY.
    term.onData((data) => {
      if (!shouldUsePty(ptyId)) return;
      syncAliveThread();
      sendInputText(data);
    });

    term.onResize(({ cols, rows }) => {
      if (!shouldUsePty(ptyId)) return;
      void ptyResize(ptyId, cols, rows);
    });

    term.open(container);
    // The terminal renders to a canvas, so nothing that reads the DOM can see
    // its output. This is the only handle on it.
    registerTerminal(thread.id, term);
    // Set inputmode before the focus below so the phone keyboard never flashes.
    syncMobileInput();
    disposeMobileInput = installMobileInput({
      container,
      enabled: () => mobile,
      sendText: sendInputText,
      sendSequence: rawWrite,
    });

    const initialFit = () => {
      try {
        fit?.fit();
      } catch {
        // ignore
      }
    };
    initialFit();
    loadWebgl();
    if (focused) term.focus();

    // Now, in this same tick, whenever the pane already has a box — which it
    // does as soon as its group has been laid out (see paneStore.rectFor). The
    // frame below was the last one standing between the click and the process
    // starting. The rAF stays as the fallback for a pane with nothing to measure
    // yet, and as the second fit for one whose glyph metrics were not ready for
    // the first: spawn() is guarded, so the later call is a no-op once this one
    // has taken.
    if (hasUsableTerminalSize()) void spawn();

    requestAnimationFrame(() => {
      initialFit();
      loadWebgl();
      void spawn();
    });

    resizeObserver = new ResizeObserver(() => {
      scheduleSettledFit();
    });
    resizeObserver.observe(container);

    container.addEventListener("touchstart", onTouchStart, { passive: false });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd);
    container.addEventListener("touchcancel", onTouchEnd);

    window.visualViewport?.addEventListener("resize", onViewportResize);
  });

  /**
   * Relaunches into this same terminal: one xterm, one WebGL context, one set
   * of handlers, a new process.
   *
   * The page used to key the whole component on the relaunch nonce, so a reload
   * disposed xterm and built another — a fresh WebGL context, its shaders and
   * its glyph atlas, every time. Chromium keeps 16 contexts alive at most, so
   * past a handful of panes the reloads were also taking each other's context
   * and silently dropping those panes to the DOM renderer.
   *
   * Reusing the handlers is safe because they were already written for it: they
   * gate on the live `ptyId` (see the note on term.onData), so the replaced
   * PTY's late events are dropped rather than written into the new one.
   */
  function respawnInPlace() {
    // The mount has not run yet; its own spawn is the launch this would be.
    if (!term) return;
    spawnGeneration++;
    clearSpawnRetry();
    spawnRetryCount = 0;
    stopSessionMonitor();
    // Never a kill here: every caller (reloadThread, a move, the post-update
    // resume) has already waited for the old process to die. Dropping the id is
    // what makes handleEvent ignore whatever its channel still flushes.
    ptyId = null;
    spawned = false;
    released = false;
    lastOutputAt = 0;
    lastInputAt = 0;
    // What the remount gave for free: an empty screen with no scrollback from
    // the conversation being replaced. It is also all the detection reset there
    // is to do: the status engine reads the rows back off `term` rather than
    // keeping a buffer of its own, so wiping the screen wipes what it sees.
    term.reset();
    // A spawn still in flight owns the restart: it reads its generation as
    // stale, drops whatever it opened and re-enters on its way out. Starting a
    // second one here is how two PTYs end up on one pane.
    if (!spawning) void spawn();
  }

  $effect(() => {
    const next = app.respawnNonce[thread.id] ?? 0;
    const seen = respawnSeen;
    respawnSeen = next;
    // First run takes the baseline; the mount's own spawn is this pane's launch.
    if (seen === null || next <= seen) return;
    respawnInPlace();
  });

  $effect(() => {
    if (visible && term) {
      queueMicrotask(() => {
        fit?.fit();
        // A pane that mounted hidden measured nothing, so this is where its
        // renderer becomes the GPU one.
        loadWebgl();
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
    if (cur && isFinished(cur.status)) return;
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
    if (term) {
      const next = finished || thread.status === "idle";
      if (term.options.disableStdin !== next) term.options.disableStdin = next;
    }
  });

  $effect(() => {
    if (focused && term) {
      queueMicrotask(() => term?.focus());
    }
  });

  // The grid is measured in pixels off a canvas, so neither the UI scale nor a
  // pinch reaches it through CSS. Push the resolved size in, then refit: the
  // cell size changed, so the column count did too.
  $effect(() => {
    const next = fontSize;
    if (term && term.options.fontSize !== next) {
      term.options.fontSize = next;
      scheduleFit();
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
    statusEngine.forget(thread.id);
    stopSessionMonitor();
    disposeMobileInput?.();
    disposeMobileInput = null;
    // Silently: the pane is gone, so a line about how long it took to open
    // describes something nobody is looking at any more, and its watchdog would
    // fire about a launch that has no pane left to land in.
    launchTiming?.dispose();
    launchTiming = null;
    releasePty();
    if (fitRafId !== null) cancelAnimationFrame(fitRafId);
    fitRafId = null;
    if (fitSettleTimer !== null) clearTimeout(fitSettleTimer);
    fitSettleTimer = null;
    resizeObserver?.disconnect();
    container?.removeEventListener("touchstart", onTouchStart);
    container?.removeEventListener("touchmove", onTouchMove);
    container?.removeEventListener("touchend", onTouchEnd);
    container?.removeEventListener("touchcancel", onTouchEnd);
    window.visualViewport?.removeEventListener("resize", onViewportResize);
    unregisterTerminal(thread.id);
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
  <!-- In landscape on a notched phone the cutout is on a side, not the top, and
       this pane fills the window: without the side insets the first columns of
       every line sit under it. -->
  <div
    class="relative min-h-0 flex-1 px-3 py-2"
    style={mobile
      ? "padding-left: max(env(safe-area-inset-left, 0px), 0.75rem); padding-right: max(env(safe-area-inset-right, 0px), 0.75rem);"
      : undefined}
  >
    <div
      bind:this={container}
      class="h-full w-full min-h-0 overflow-hidden"
      class:touch-none={mobile}
      use:longPress={{ onLongPress: openTerminalMenuAt }}
    ></div>
    {#if thread.status === "stopped"}
      <div
        class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[var(--color-background)] text-xs text-muted-foreground/60"
        role="status"
      >
        <!-- Decoration only: the readable state lives in the sibling span. -->
        <span aria-hidden="true">( -_-) zzZ</span>
        <span class="sr-only">{t("terminal.threadStopped")}</span>
      </div>
    {:else if thread.status === "done" || thread.status === "exited" || thread.status === "error"}
      <div class="absolute inset-x-0 bottom-3 z-10 flex justify-center">
        <button
          type="button"
          class="rounded-md border border-border bg-[var(--color-surface)] px-3 py-1 text-xs text-muted-foreground shadow-lg transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
          onclick={() => void reloadThread(thread.id)}
        >
          {thread.status === "done"
            ? t("terminal.finishedRelaunch")
            : thread.status === "error"
              ? t("terminal.spawnFailedRelaunch")
              : t("terminal.exitedRelaunch", { code: thread.exitCode ?? "?" })}
        </button>
      </div>
    {/if}
    {#if mobile && focused && !finished}
      <button
        type="button"
        class="absolute bottom-3 right-3 z-20 flex size-11 items-center justify-center rounded-full border shadow-lg transition active:scale-95"
        style:right="max(env(safe-area-inset-right, 0px), 0.75rem)"
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
        aria-label={t("terminal.keyboardLabel")}
        title={t("terminal.keyboardHint")}
      >
        <Keyboard class="size-5" />
      </button>
    {/if}
  </div>

  {#if showKeyBar}
    <div
      class="flex shrink-0 items-stretch gap-1 border-t border-border bg-[var(--color-surface)] px-1 py-1"
      style="padding-left: max(env(safe-area-inset-left, 0px), 0.25rem); padding-right: max(env(safe-area-inset-right, 0px), 0.25rem);"
    >
      <div class="hide-scrollbar flex flex-1 items-stretch gap-1 overflow-x-auto">
        {#each BAR_KEYS as k (k.id)}
          {@const armed =
            k.id === "ctrl" ? ctrlArmed : k.id === "alt" ? altArmed : false}
          <!-- 44px, not 36px: these are the only Ctrl, Alt and Esc a phone has,
               and h-9 puts them under the touch-target floor. -->
          <button
            type="button"
            class="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-border px-2 text-base font-medium transition active:scale-95"
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

{#if ctxMenu}
  <ContextMenu
    items={ctxMenu.items}
    x={ctxMenu.x}
    y={ctxMenu.y}
    onClose={closeContextMenu}
  />
{/if}
