<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { ArrowDown } from '@lucide/svelte';
  import type { Message } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import MessageTurnSummary from './MessageTurnSummary.svelte';
  import TurnFiles from './TurnFilesLoader.svelte';
  import { TurnFileCache, visibleTurnFiles, type TurnFilesData } from '../lib/turn-files';
  import { chatPrefs } from '../lib/chat-prefs.svelte';
  import MessageOutline from './MessageOutline.svelte';
  import AgentMessageGroup from './AgentMessageGroup.svelte';
  import { agentMailFor, groupAgentMail, withAgentMail } from '../lib/agent-mail';
  import DelegationActivity from './DelegationActivity.svelte';
  import UserMessage from './UserMessage.svelte';
  import ImageViewer from './ImageViewer.svelte';
  import { provideViewerHost, type Gallery } from '../lib/media-gallery';
  import AssistantMessage from './AssistantMessage.svelte';
  import MoveMarker from './MoveMarker.svelte';
  import SpawnMarker from './SpawnMarker.svelte';
  import MemoryRow from './MemoryRow.svelte';
  import { placeMemoryEvents } from '../lib/memory-timeline';
  import MessageActions from './MessageActions.svelte';
  import { movedBy, pendingMoveOf, startedFrom, turnAnswer } from '../lib/message-display';
  import { focusComposer } from '../lib/focus';
  import { isSending } from '../lib/composer-queue';
  import { retryTurn } from '../lib/composer-edit';
  import { TurnProgress } from '../lib/turn-progress.svelte';
  import { GAP, OVERSCAN, SlotTotals, WINDOW_FROM, atOrBefore, estimateSlot, gapChanged, measurable, reaches, sameView, slotGap, windowStats, type WindowView } from '../lib/message-window';
  import { TimelineRows, rowEstimate, rowIndexOf, seam, type TimelineRow } from '../lib/timeline-rows';
  import WorkflowActivity from './WorkflowActivity.svelte';
  import { dockRoom } from '../lib/question-dock.svelte';
  import { glides } from '../lib/motion';
  import { BottomEdge, BottomGlide, PointerHold, keysUp, typingKey, watchWheel, wheelsUp } from '../lib/timeline-follow';
  import { selectionClicks } from '../lib/selection-clicks';
  import { editWhole, pullNewer, pullOlder } from '../lib/reading-window';
  import { ReadingAnchor, type RowAnchor } from '../lib/reading-anchor';
  import { MediaQuery } from 'svelte/reactivity';
  import { placeViews, viewPart } from '../lib/inline-view';

  /** A phone has no room left of the bubbles for the outline rail: it is not drawn there. */
  const narrow = new MediaQuery('(max-width: 720px)');

  let {
    store,
    threadId,
    messages
  }: { store: Store; threadId: string; messages: Message[] } = $props();
  /**
   * The open viewer belongs to the list, not to the row it was opened from: a
   * running turn moves the window of rows, and the row leaving it must not
   * close the viewer. Object URLs of rows gone meanwhile wait for it to close.
   */
  let viewing = $state<Gallery | null>(null);
  const held = new Set<string>();
  function releaseHeld(): void {
    for (const url of held) if (!viewing?.items.some(item => item.src === url)) { URL.revokeObjectURL(url); held.delete(url); }
  }
  provideViewerHost({
    open: (gallery) => { viewing = gallery; releaseHeld(); },
    release: (url) => { held.add(url); releaseHeld(); }
  });
  onDestroy(() => { viewing = null; releaseHeld(); });
  /** The find bar is its own chunk, fetched the first time it opens. A failed fetch tries again on the next open. */
  let FindBar = $state.raw<typeof import('./FindBar.svelte').default>();
  $effect(() => {
    if (store.findOpen && !FindBar) void import('./FindBar.svelte').then((module) => { FindBar = module.default; }).catch(() => { store.findOpen = false; });
  });
  const delegation = $derived(store.delegation && (store.delegation.rootThreadId === threadId || store.delegation.agents.some(agent => agent.thread.id === threadId)) ? store.delegation : null);
  const mail = $derived(agentMailFor(store, threadId));
  /** The thread's account is signed out and no other of its agent can take the next turn: an error carries the way back in. */
  const signedOut = $derived.by(() => {
    const thread = store.openThread;
    if (!thread || thread.id !== threadId) return null;
    const account = store.accountOf(thread.accountId);
    return account?.status === 'unauthenticated' && store.usableAccountOf(account.providerId, account.id) === null ? account : null;
  });
  const team = $derived(delegation?.rootThreadId === threadId ? delegation.agents : []);
  const teamRowId = $derived(`delegation:${threadId}`);
  /** The runs this thread started, each a card where it began. */
  const workflowRows = $derived(new Map(store.workflowsOf(threadId).filter(run => run.rootThreadId === threadId).map(run => [`workflow:${run.id}`, run])));
  /** The turns of the thread this list shows, open or delegated. */
  const shownTurns = $derived(store.openThread?.id === threadId ? store.openThread.turns : store.delegationThread?.id === threadId ? store.delegationThread.turns : []);
  const grouped = $derived.by(() => {
    if (mail.length === 0 && team.length === 0 && workflowRows.size === 0 && memoryRows.size === 0) return { timeline: messages, groups: new Map() };
    const activity: Message[] = team.length ? [{
      id: teamRowId, threadId, turnId: teamRowId, role: 'system', parts: [], state: 'complete',
      createdAt: Math.min(...team.map(agent => agent.thread.createdAt))
    }] : [];
    const runs: Message[] = [...workflowRows].map(([id, run]) => ({ id, threadId, turnId: id, role: 'system', parts: [], state: 'complete', createdAt: run.createdAt }));
    const memory: Message[] = [...memoryRows].map(([id, event]) => ({ id, threadId, turnId: id, role: 'system', parts: [], state: 'complete', createdAt: event.at }));
    // Output that already existed in this millisecond precedes its exchange.
    const rows = [...withAgentMail(messages, mail, threadId, shownTurns), ...activity, ...runs, ...memory].sort((a, b) =>
      a.createdAt - b.createdAt || Number(a.id.startsWith('coordination:')) - Number(b.id.startsWith('coordination:')) || a.id.localeCompare(b.id));
    return groupAgentMail(rows, mail);
  });
  /** A turn's views go after its answer, and wait for a turn still running to end (`placeViews`). */
  const timeline = $derived(placeViews(grouped.timeline, store.openThread?.id === threadId ? store.openThread.turns : store.delegationThread?.id === threadId ? store.delegationThread.turns : []));
  const memoryPlacement = $derived(placeMemoryEvents(messages, store.openThread?.id === threadId ? store.openThread.memoryEvents ?? [] : store.delegationThread?.id === threadId ? store.delegationThread.memoryEvents ?? [] : []));
  const memoryRows = $derived(new Map(memoryPlacement.standalone.map((event, index) => [`memory:${event.at}:${event.kind}:${index}`, event])));
  /** What the window lists and measures: a row per message, several for the message of a long turn (lib/timeline-rows.ts). */
  const cut = new TimelineRows();
  const rows = $derived.by(() => {
    const built = cut.build(timeline, memoryPlacement.inline);
    // A row that grew or was cut weighs something else until it is measured.
    if (cut.changedFrom < slots.dirty) slots.dirty = cut.changedFrom;
    return built;
  });
  const timelineOrder = $derived.by(() => { void rows; return cut.order; });
  const savedReading = untrack(() => store.readingPositions?.get(threadId));

  /** How often the bottom message's height is allowed to speak to the pin. */
  const TAIL_GAP_MS = 100;

  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let pinned = $state(savedReading?.pinned ?? true);
  let behind = $state(false);
  /** The newest message the reader was at the bottom for; what came after it is what the button counts. */
  let seenLast = $state<string | null>(null);
  let unseen = $derived.by(() => {
    if (!behind || seenLast === null) return 0;
    const at = timeline.findIndex((message) => message.id === seenLast);
    return at < 0 ? 0 : timeline.length - 1 - at;
  });
  function markSeen() {
    seenLast = timeline.at(-1)?.id ?? null;
  }
  let shown = savedReading ? untrack(() => threadId) : '';

  /** Measured slot heights by message id. What is not in here is worth its estimate. */
  const heights = new Map<string, number>(savedReading?.heights);
  /** Bumped by every measurement that moved a height, so the window recomputes on real numbers. */
  let measured = $state(0);
  /** Ids that already played the rise, so a message re-entering the window stays still. */
  const risen = new Set<string>([...(savedReading?.heights.keys() ?? []), ...untrack(() => messages.map(message => message.id))]);
  /** One observer for the viewport's height and for every rendered message. */
  let boxes: ResizeObserver | undefined;

  const slots = new SlotTotals<TimelineRow>(heights, row => rowEstimate(row, estimateSlot(row.message)));
  /** Where the reader is, and the rows on the page by id (lib/reading-anchor.ts). */
  const anchors = new ReadingAnchor(savedReading);
  const savedTop = untrack(() => {
    const anchor = savedReading?.pinned ? undefined : anchors.current;
    const at = anchor ? rows.findIndex(row => row.id === anchor.id) : -1;
    return at < 0 ? savedReading?.top ?? 0 : Math.max(0, (slots.totals(rows, timelineOrder)[at] ?? 0) - anchor!.offset);
  });
  let scrollTop = $state(savedTop);
  let column = $state<HTMLDivElement | undefined>(undefined);
  function rememberAnchor() { anchors.remember(viewport, column); }
  /** Typing in a field never leaves the thread: a chord, Enter, Escape or a key outside a field reads the anchor. */
  function rememberBeforeKey(event: KeyboardEvent) { if (!typingKey(event)) rememberAnchor(); }
  function restoreAnchor(anchor: RowAnchor | undefined = anchors.current) {
    if (!anchor || !viewport?.isConnected || pinned || navigationTarget || promptTarget) return;
    const delta = anchors.drift(viewport, anchor);
    if (delta === null) return;
    if (Math.abs(delta) > 1) { viewport.scrollTop += delta; scrollTop = viewport.scrollTop; }
    anchors.current = anchor;
  }
  function releaseAnchor() { anchors.restoring = false; }
  onMount(() => {
    // Capture the settled layout before a navigation click removes this list.
    document.addEventListener('pointerdown', rememberAnchor, true);
    document.addEventListener('keydown', rememberBeforeKey, true);
    return () => {
      document.removeEventListener('pointerdown', rememberAnchor, true);
      document.removeEventListener('keydown', rememberBeforeKey, true);
    };
  });
  let restoredReading = false;
  onDestroy(() => {
    if (!viewport || !store.readingPositions) return;
    store.readingPositions.delete(threadId);
    store.readingPositions.set(threadId, { top: scrollTop, pinned, heights: new Map(heights), anchor: anchors.saved(), height: viewHeight, reservePrompt, followPrompt: promptTarget });
    while (store.readingPositions.size > 32) store.readingPositions.delete(store.readingPositions.keys().next().value!);
  });
  let viewHeight = $state(savedReading?.height ?? 0);
  let navigationTarget = $state<string | null>(null);
  let promptTarget = $state<string | null>(savedReading?.followPrompt ?? null);
  let reservePrompt = $state<string | null>(savedReading?.reservePrompt ?? null);
  let lifting = $state(false);
  let liftFrame = 0;
  let liftFrom = 0;
  let handledFocus = untrack(() => store.promptFocus);
  function stopLift() {
    cancelAnimationFrame(liftFrame);
    liftFrame = 0;
    lifting = false;
  }
  function releaseNavigation(event?: KeyboardEvent) {
    releaseAnchor(); navigationTarget = null;
    if (promptTarget) pinned = false;
    promptTarget = null;
    stopLift();
    endGlide(false);
    if (event && !typingKey(event)) { pinned = false; if (keysUp(event, viewport)) leftBottom = true; }
  }
  onDestroy(stopLift);
  const activePrompt = $derived.by(() => {
    void measured;
    if (!pinned && promptTarget && timeline.some(message => message.id === promptTarget)) return promptTarget;
    const total = totals(rows);
    const at = pinned ? rows.length - 1 : atOrBefore(total, rows.length, scrollTop + 24);
    for (let index = Math.min(at, rows.length - 1); index >= 0; index--) {
      if (rows[index]?.message.role === 'user') return rows[index]!.message.id;
    }
    return null;
  });

  /** To a message, or to the row of it that draws `part` when a long one is cut in several. */
  function jumpToMessage(id: string, part?: number) {
    releaseNavigation();
    const box = viewport;
    const index = rowIndexOf(rows, id, part);
    if (!box || index < 0) return;
    navigationTarget = rows[index]!.id;
    pinned = false;
    behind = true;
    box.scrollTop = totals(rows)[index] ?? 0;
    scrollTop = box.scrollTop;
  }

  // Keep the target aligned as estimated heights become real measurements.
  // Wheel, touch, scrollbar and keyboard input return control to the reader.
  $effect(() => {
    const id = navigationTarget;
    void measured;
    void view;
    if (!id) return;
    const frame = requestAnimationFrame(() => {
      const box = viewport;
      if (!box || navigationTarget !== id) return;
      const node = anchors.nodes.get(id);
      if (!node?.isConnected) return;
      node.style.animation = 'none';
      const delta = node.getBoundingClientRect().top - box.getBoundingClientRect().top - 20;
      if (Math.abs(delta) > 1) box.scrollTop += delta;
      scrollTop = box.scrollTop;
    });
    return () => cancelAnimationFrame(frame);
  });

  const windowed = $derived(rows.length > WINDOW_FROM);
  /** The window was opened around a reading position and stops short of the thread's last message. */
  const cutBelow = $derived((store.messagesAfter ?? null) !== null);
  /** A move the user made, said at the foot of the thread until the prompt that tells the agent goes. */
  const pendingMove = $derived(cutBelow || isSending(timeline.at(-1) ?? { id: '' }) ? null : pendingMoveOf(store.openThread, threadId));

  function totals(list: TimelineRow[]): number[] {
    return slots.totals(list, timelineOrder);
  }

  const promptInset = $derived(Math.min(96, Math.max(48, viewHeight * 0.12)));
  const promptLead = $derived.by(() => {
    void measured;
    const before = reservePrompt ? totals(rows)[rows.findIndex(row => row.id === reservePrompt)] ?? 0 : Infinity;
    return Math.max(0, promptInset - 20 - before);
  });
  // Keep the remaining screen below the sent prompt. Real response height replaces the
  // reserved space, including in a virtualized conversation, without moving it.
  const promptRoom = $derived.by(() => {
    void measured;
    if (!reservePrompt) return 0;
    const at = rows.findIndex(row => row.id === reservePrompt);
    if (at < 0) return 0;
    const total = totals(rows);
    const content = (total[rows.length] ?? 0) - (total[at] ?? 0) - GAP;
    return Math.max(0, viewHeight - promptInset - 20 - dockRoom.height - content);
  });

  function promptTop(id: string): number {
    const box = viewport!;
    const node = anchors.nodes.get(id);
    if (node?.isConnected) {
      node.style.animation = 'none';
      return box.scrollTop + node.getBoundingClientRect().top - box.getBoundingClientRect().top - promptInset;
    }
    const top = totals(rows)[rows.findIndex(row => row.id === id)];
    return top === undefined ? box.scrollTop : top + 20 + promptLead - promptInset;
  }

  $effect(() => {
    const request = store.promptFocus;
    if (!request || request === handledFocus || request.threadId !== threadId) return;
    const message = messages.findLast(message => message.role === 'user' && message.turnId === request.turnId && message.id !== request.after);
    if (!message || !viewport) return;
    handledFocus = request;
    untrack(() => {
      releaseNavigation();
      pinned = false;
      behind = false;
      // A prompt sent brings the reader back to the live end, whatever the wheel did before.
      leftBottom = false;
      reservePrompt = promptTarget = message.id;
      lifting = true;
      liftFrom = viewport!.scrollTop;
      const style = getComputedStyle(viewport!);
      const token = style.getPropertyValue('--dur-3').trim();
      const duration = parseFloat(token) * (token.endsWith('ms') ? 1 : 1000) || 0;
      let started: number | undefined;
      const step = (now: number) => {
        if (!viewport || promptTarget !== message.id) return;
        started ??= now;
        const progress = duration > 1 ? Math.min(1, (now - started) / duration) : 1;
        viewport.scrollTop = liftFrom + (promptTop(message.id) - liftFrom) * (1 - (1 - progress) ** 5);
        scrollTop = viewport.scrollTop;
        if (progress < 1) liftFrame = requestAnimationFrame(step);
        else { liftFrame = 0; lifting = false; }
      };
      liftFrame = requestAnimationFrame(step);
    });
  });

  $effect(() => {
    const id = promptTarget;
    void measured;
    void viewHeight;
    void view;
    const room = promptRoom;
    if (!id || lifting || !viewport) return;
    const frame = requestAnimationFrame(() => {
      if (!viewport || promptTarget !== id) return;
      if (room <= 1) {
        viewport.scrollTop = viewport.scrollHeight;
        scrollTop = viewport.scrollTop;
        pinned = true;
      } else {
        pinned = false;
        viewport.scrollTop = promptTop(id);
        scrollTop = viewport.scrollTop;
        behind = false;
        markSeen();
        rememberAnchor();
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  /**
   * The slice of messages that meets the viewport, the overscan added, and the
   * two heights the spacers carry for everything left out. While pinned the
   * window hangs off the end of the list instead of off `scrollTop`, so the
   * bottom is right on the first frame rather than after a measurement.
   */
  let lastView: WindowView | undefined;
  const view = $derived.by(() => {
    void measured;
    windowStats.recomputes += 1;
    const list = rows;
    if (!windowed) {
      return lastView = sameView(lastView, { start: 0, end: list.length, first: 0, above: 0, below: 0 });
    }

    const count = list.length;
    const total = totals(list);
    const whole = total[count] ?? 0;
    let first: number;
    let last: number;
    if (pinned) {
      first = atOrBefore(total, count, whole - viewHeight);
      last = count;
    } else {
      first = atOrBefore(total, count, scrollTop);
      last = reaches(total, count, first, scrollTop + viewHeight);
    }

    // At the live end, paint fewer offscreen rows. Reading history keeps the
    // larger buffer in both directions for wheel and touch navigation.
    const start = Math.max(0, first - (pinned ? 2 : OVERSCAN));
    const end = Math.min(count, last + OVERSCAN);
    // The same object while the window covers the same rows: a scroll inside them redraws nothing.
    return lastView = sameView(lastView, { start, end, first, above: total[start] ?? 0, below: whole - (total[end] ?? 0) });
  });

  const rendered = $derived(rows.slice(view.start, view.end));

  /**
   * A rendered message's real height replaces its estimate. One that sits above
   * what the user is reading would push the text down as it lands, so the same
   * delta goes back into `scrollTop` and the viewport does not move.
   */
  function onMeasured(entries: ResizeObserverEntry[]): void {
    const box = viewport;
    const lastId = rows.at(-1)?.id;
    let shift = 0;
    let moved = false;
    for (const entry of entries) {
      const node = entry.target as HTMLElement;
      if (node === box) {
        viewHeight = node.clientHeight;
        continue;
      }
      const id = node.dataset['mid'];
      if (!id) continue;
      // The observer already measured the box; reading `offsetHeight` again would lay out, mid-scroll,
      // whatever the window just mounted. A row that continues a message sits a paragraph's gap under it.
      const gap = slotGap(node.dataset['seam'], node.dataset['rest'] !== undefined);
      node.dataset['gap'] = String(gap);
      const next = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight) + gap;
      const at = slots.indexOf(rows, id);
      const previous = heights.get(id) ?? slots.estimateOf(rows[at]);
      if (previous === next) continue;
      heights.set(id, next);
      moved = true;
      if (at < 0) continue;
      // Everything from here down is worth a different number now.
      if (at < slots.dirty) slots.dirty = at;
      if (at < view.first) shift += next - previous;
      if (id === lastId) noteTail(next);
    }
    if (!moved) return;
    measured += 1;
    if (box && shift !== 0 && !pinned) {
      box.scrollTop += shift;
      // The window moves with it at once: computed on the old position, it mounted a message above
      // for a frame and dropped it unmeasured, moving the text with no scroll event to read the anchor.
      scrollTop = box.scrollTop;
      if (lifting) liftFrom += shift;
    }
  }

  /** The bottom message's height, at most ten times a second: what the pin follows. */
  let tail = $state(0);
  let tailAt = 0;
  let tailTimer = 0;

  function noteTail(height: number): void {
    if (tailTimer) return;
    const wait = TAIL_GAP_MS - (performance.now() - tailAt);
    if (wait <= 0) {
      tailAt = performance.now();
      tail = height;
      return;
    }
    tailTimer = window.setTimeout(() => {
      tailTimer = 0;
      tailAt = performance.now();
      const last = rows.at(-1);
      tail = last ? (heights.get(last.id) ?? slots.estimateOf(last)) : 0;
    }, wait);
  }

  $effect(() => () => {
    if (tailTimer) clearTimeout(tailTimer);
  });

  /**
   * Every rendered message reports its height here and says which id it is. The
   * rise plays once per message: a second element for the same id, minted when
   * the window scrolled back over it, opens with the animation off.
   */
  function track(node: HTMLElement, { row }: { row: TimelineRow; joined: string | null }): { update(next: { row: TimelineRow; joined: string | null }): void; destroy(): void } {
    const id = row.id;
    node.dataset['mid'] = id;
    if (!row.first) { node.dataset['rest'] = ''; node.dataset['message'] = row.message.id; }
    // A message rises as it arrives at the bottom being watched. One that a
    // scroll up the history brings into the window is already there: rising
    // then animated every message a fast scroll crossed.
    // The core's copy of a prompt sent from here replaces the row already on
    // screen: same height, and it does not rise a second time.
    const local = row.first ? store.landedFrom?.(id) : undefined;
    if (local !== undefined && risen.has(local)) {
      risen.add(id);
      const height = heights.get(local);
      if (height !== undefined && !heights.has(id)) heights.set(id, height);
    }
    // The rest of a cut message is the same message going on: it never rises on its own.
    if (risen.has(id) || !pinned || !row.first) node.style.animation = 'none';
    risen.add(id);
    anchors.nodes.set(id, node);
    boxes?.observe(node);
    return {
      update: ({ row: next, joined }) => { if (gapChanged(node, joined, !next.first)) { boxes?.unobserve(node); boxes?.observe(node); } },
      destroy() {
        boxes?.unobserve(node);
        // A second element for the same row may already have taken its place.
        if (anchors.nodes.get(id) === node) anchors.nodes.delete(id);
      }
    };
  }

  $effect(() => {
    const box = viewport;
    if (!box) return;
    if (!restoredReading) {
      restoredReading = true;
      if (savedReading && !savedReading.pinned) {
        box.scrollTop = savedTop;
        // What is loaded now is the baseline: the button counts what arrives after.
        untrack(markSeen);
      }
    }
    viewHeight = box.clientHeight;
    scrollTop = box.scrollTop;
    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const pending = new Map<Element, ResizeObserverEntry>();
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) pending.set(entry.target, entry);
      // Pinned, the list follows what grows at its bottom in this same frame: the observer runs
      // after layout, so the new line is painted already in view (docs/performance.md).
      if (following()) edge.follow(box);
      if (frame) return;
      // Applying slot heights inside ResizeObserver can resize that same batch.
      frame = requestAnimationFrame(() => {
        frame = 0;
        const batch = measurable([...pending.values()], id => slots.indexOf(rows, id) >= 0);
        pending.clear();
        // Estimated rows can be taller than their slot totals. Keep the actual
        // visible message, then align it after Svelte updates the spacers.
        rememberAnchor();
        const anchor = anchors.current;
        onMeasured(batch);
        void tick().then(() => restoreAnchor(anchor));
      });
    });
    boxes = observer;
    observer.observe(box);
    for (const node of anchors.nodes.values()) observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      pending.clear();
      boxes = undefined;
    };
  });

  function atBottom(box: HTMLDivElement): boolean {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }

  let scrolledHeight = 0;
  function onscroll() {
    const box = viewport;
    if (!box) return;
    const height = box.scrollHeight;
    const resized = height !== scrolledHeight;
    scrolledHeight = height;
    // Pulled up by a finger or the scrollbar thumb, the list leaves the bottom as the wheel does.
    if (hold.held && box.scrollTop < scrollTop - 1) leftBottom = true;
    const rose = edge.rose(box);
    const movedDown = box.scrollTop > scrollTop + 1;
    scrollTop = box.scrollTop;
    viewHeight = box.clientHeight;
    if (navigationTarget || promptTarget) return;
    // Read the anchor after the render, before another navigation can restore it.
    void tick().then(rememberAnchor);
    const distance = height - box.scrollTop - box.clientHeight;
    if (glide.active) {
      if (distance > 1) return;
      endGlide(false);
    }
    // A busy phone delivers the touchstart after its scroll: a rise off the bottom is the reader too.
    if (rose && pinned && distance > 1) leftBottom = true;
    if (distance <= 1 && movedDown) leftBottom = false;
    // A card shrinking can clamp scrollTop before new output grows the list again.
    pinned = !cutBelow && !leftBottom && (atBottom(box) || (pinned && resized && !hold.held));
    if (anchors.restoring) pinned = false;
    // Away from the bottom, the way back shows, whether or not anything new came in.
    behind = !pinned;
    if (pinned) markSeen();
    loadAbove(box);
    pullNewer(store, box, LOAD_AT);
  }

  /** A wheel turned up leaves the bottom at once: waiting for the 80 px that unpin it let a
   *  streaming answer pull the first notches of a smooth wheel back down, frame after frame. */
  let leftBottom = false;
  function onwheel(event: WheelEvent) {
    releaseNavigation();
    // Away from the bottom already, a notch releases nothing: asking where it turns would read the list's box.
    if (!viewport || (leftBottom && !pinned) || !wheelsUp(event, viewport)) return;
    leftBottom = true;
    if (pinned) { pinned = false; behind = true; }
  }

  /** A finger, a text selection or the scrollbar thumb holds the list where it is; the glide is what
   *  "Jump to latest" starts, whose scroll events neither unpin the list nor bring the button back. */
  const hold = new PointerHold(), glide = new BottomGlide(), edge = new BottomEdge();
  function press(event: PointerEvent | TouchEvent) { releaseNavigation(); hold.press(event); }
  /** Whether the list keeps to the bottom right now: pinned, and nobody is moving it. */
  const following = () => pinned && !navigationTarget && !glide.active && !hold.held;

  // -- paging: `pullOlder` and `pullNewer` (lib/reading-window.ts). Everything above is the windowing. --

  /** How close to the top the viewport gets before the page above it is asked for. */
  const LOAD_AT = 400;

  /** The page above the window, its height put back into the scroll position (`pullOlder`). */
  function loadAbove(box: HTMLDivElement): void {
    pullOlder(store, box, LOAD_AT, rows[0]?.id, (head) => {
      const before = head ? rows.findIndex(row => row.id === head) : rows.length;
      return totals(rows)[Math.max(0, before)] ?? 0;
    }, () => { scrollTop = box.scrollTop; });
  }

  // The reader's own prompt takes the bottom, wherever the history was scrolled to.
  let jumpedFor = '';
  $effect(() => {
    const last = messages.at(-1);
    if (!last || !isSending(last) || last.id === jumpedFor) return;
    jumpedFor = last.id;
    untrack(jump);
  });

  function jump() {
    releaseNavigation();
    const box = viewport;
    if (!box) return;
    // A window short of the end reads the last page first, then lands at its bottom.
    if (cutBelow) { void store.loadLatest().then(() => { if (!cutBelow) jump(); }); return; }
    reservePrompt = null;
    behind = false;
    markSeen();
    leftBottom = false;
    // The room reserved under a lifted prompt leaves with this flush: the bottom is read after it.
    void tick().then(() => { if (box.isConnected) descend(box); });
  }

  /** To the bottom of `box`: at once when it is there or motion is reduced, on a glide otherwise. */
  function descend(box: HTMLDivElement) {
    behind = false;
    if (glides() && box.scrollHeight - box.clientHeight - box.scrollTop > 1) { glide.start(box, () => endGlide(true)); return; }
    pinned = true;
    edge.follow(box);
    scrollTop = box.scrollTop;
  }

  /** The glide is over: arrived or out of time, the list pins again; taken over by the reader, it stays where it stopped. */
  function endGlide(arrived: boolean) {
    if (!glide.active) return;
    glide.stop();
    const box = viewport;
    if (!box) return;
    if (arrived) {
      edge.follow(box);
      scrollTop = box.scrollTop;
    }
    pinned = arrived || atBottom(box);
    behind = !pinned;
    if (pinned) markSeen();
  }

  $effect(() => () => { glide.stop(); hold.release(); });

  /** Follow new messages and measured tail growth, never text deltas. */
  $effect(() => {
    void timeline.length;
    // A long answer being written gains rows as it is cut: the bottom is still its last one.
    void rows.length;
    void tail;
    const box = viewport;
    if (!box) return;
    const opened = shown !== threadId;
    shown = threadId;
    if (promptTarget && !pinned) {
      behind = false;
      untrack(markSeen);
    } else if (opened || pinned) {
      // Held by the reader or on its way down, the list is still at the bottom: it takes the new height once free.
      if (opened || untrack(following)) {
        scrolledHeight = box.scrollHeight; edge.follow(box);
        scrollTop = box.scrollTop;
      }
      pinned = true;
      behind = false;
      untrack(markSeen);
    } else if (!glide.active) {
      behind = true;
    }
  });

  /** Lift a pinned tail for the dock, including a short history that previously fit. */
  $effect(() => {
    void dockRoom.height;
    const box = viewport;
    if (!box || !pinned) return;
    edge.follow(box);
    scrollTop = box.scrollTop;
  });

  /** The window moving under a pinned viewport changes the spacers: take the bottom again. */
  $effect(() => {
    void view;
    if (!untrack(following)) return;
    const box = viewport;
    if (!box) return;
    edge.follow(box);
  });

  // Finished and streaming messages are derived apart, so a delta never rescans the thread.
  const progress = new TurnProgress(() => messages);
  /** One model attribution per turn, independent of the rendered window and streamed parts. */
  const firstAssistantInTurn = $derived.by(() => {
    const result = new Map<string, string>();
    for (const message of messages) {
      // A view is drawn after the answer, wherever it was published: the answer's first message carries the model.
      if (message.role === 'assistant' && !result.has(message.turnId) && !viewPart(message)) result.set(message.turnId, message.id);
    }
    return result;
  });
  const lastInTurn = $derived.by(() => {
    const result = new Map<string, string>();
    for (const message of timeline) result.set(message.turnId, message.id);
    return result;
  });
  /** Visible turn ends, kept as a stable string so scrolling within the same turns does not reread files. */
  const closingTurns = $derived(rendered.filter(row => row.last && lastInTurn.get(row.message.turnId) === row.message.id).map(row => row.message.turnId).join('\0'));
  /** One file summary at the turn's end, updated during work when changes are grouped. */
  const fileCache = new TurnFileCache();
  const filesByTurn = $derived.by(() => {
    const thread = store.openThread;
    if (!thread || thread.id !== threadId || closingTurns === '') return new Map<string, TurnFilesData>();
    windowStats.turnFiles += 1;
    return visibleTurnFiles(messages, thread.turns, new Set(closingTurns.split('\0')), thread.cwd, chatPrefs.groupChanges, fileCache);
  });
  /** Everything the agent wrote in a turn, its tool cards left out: what the turn's copy button takes. */
  function answerOf(turnId: string): string {
    return turnAnswer(messages, turnId);
  }

  /**
   * Edit, retry and fork go through the core's rewind and fork, which a
   * persistent agent's session refuses, and only on a thread at rest: a turn
   * still running is stopped first (Escape).
   */
  const branchable = $derived.by(() => {
    const thread = store.openThread;
    return thread !== null && thread.id === threadId && !thread.agentSessionId && thread.projectId !== null;
  });
  // A prompt still waiting in the queue would run after the edit, on the rewound thread.
  // So would an edit started under a prompt still on its way to the core.
  const atRest = $derived(branchable && !store.busy && (store.composerStates[threadId]?.queued.length ?? 0) === 0 && !store.composerStates[threadId]?.sending);

  async function editMessage(message: Message): Promise<void> {
    if (await editWhole(store, threadId, message)) focusComposer();
  }

  /** The last turn again from its own prompt, on screen before the core rewinds (`retryTurn`). */
  async function retry(turnId: string): Promise<void> {
    const prompt = messages.find((message) => message.turnId === turnId && message.role === 'user');
    if (prompt) await retryTurn(store, threadId, prompt);
  }

</script>

<div class="timeline-wrap" style:--dock-room="{dockRoom.height}px" style:--dock-clearance="{dockRoom.clearance}px">
  {#if store.findOpen && FindBar}
    <FindBar {messages} {viewport} request={store.findRequest} jump={(id, part) => jumpToMessage(id, part)}
      rowOf={(id, part) => rows[rowIndexOf(rows, id, part)] ?? { id, from: 0 }} onclose={() => (store.findOpen = false)} />
  {/if}
  {#if !narrow.current}<MessageOutline {messages} active={activePrompt} jump={id => void jumpToMessage(id)}
    hasOlder={store.messagesBefore !== null} loading={store.loadingOlder} loadOlder={() => { if (viewport) { releaseNavigation(); viewport.scrollTop = 0; pinned = false; loadAbove(viewport); } }} />{/if}
  <!-- Input releases restored and navigation anchors; programmatic corrections keep them. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="timeline" bind:this={viewport} use:watchWheel={onwheel} use:selectionClicks {onscroll} ontouchstart={press} onpointerdown={press} onkeydown={releaseNavigation} style:padding-top="{20 + promptLead}px" style:overflow-anchor={timeline.at(-1)?.state === 'streaming' ? 'none' : undefined} data-testid="timeline" data-media-gallery>
    <div class="column" bind:this={column}>
      <!-- paging: the one line the top of the list shows while a page is in flight. -->
      {#if store.loadingOlder}<p class="loading-older" data-testid="loading-older">{strings.chat.loadingOlder}</p>{/if}
      {#if view.above > 0}
        <div class="spacer" data-testid="timeline-above" style="height: {view.above}px"></div>
      {/if}
      {#each rendered as row, index (row.id)}
        {@const message = row.message}
        {@const group = grouped.groups.get(message.id)}
        {@const turn = store.openThread?.turns.find(turn => turn.id === message.turnId)}
        {@const source = group || viewPart(message) ? messages.findLast(current => current.turnId === message.turnId) : message}
        {@const closes = row.last && turn !== undefined && lastInTurn.get(turn.id) === message.id}
        {@const joined = seam(rows[view.start + index - 1], row)}
        <article
          use:track={{ row, joined }}
          class="message {message.role}"
          class:rest={!row.first}
          data-seam={joined}
          style:margin-top={joined && `calc(var(--chat-${joined}-gap) - var(--chat-message-gap))`}
          data-testid={row.first ? 'message' : 'message-rest'}
          data-role={group ? 'agent-mail' : message.role}
        >
          {#if message.id === teamRowId}
            <DelegationActivity {store} agents={team} />
          {:else if workflowRows.has(message.id)}
            <WorkflowActivity {store} run={workflowRows.get(message.id)!} />
          {:else if group}
            <AgentMessageGroup {store} {group} />
          {:else if memoryRows.has(message.id)}
            <MemoryRow event={memoryRows.get(message.id)!} onconfigure={store.owner ? () => store.showSettings('resources', 'limits') : undefined} />
          {:else if movedBy(message)}
            <MoveMarker notice={movedBy(message)!} />
          {:else if startedFrom(message)}
            <SpawnMarker {store} link={startedFrom(message)!} direction="to" />
          {:else if message.role === 'user'}
            <UserMessage {store} {message} {turn} {progress} edit={atRest && !isSending(message) ? () => void editMessage(message) : undefined} />
          {:else}
            <AssistantMessage {store} {threadId} {message} from={row.from} to={row.to} {signedOut} showModel={row.first && firstAssistantInTurn.get(message.turnId) === message.id}
              latestInTurn={lastInTurn.get(message.turnId) === message.id} memoryEvents={memoryPlacement.inline.get(message.id) ?? []} />
          {/if}
          {#if turn && closes && filesByTurn.has(turn.id)}
            <TurnFiles {store} {...filesByTurn.get(turn.id)!}
              loadDiffs={() => Promise.all(filesByTurn.get(turn.id)!.deferred.map(source => store.loadToolOutput(threadId, source.messageId, source.toolId))).then(() => {})} />
          {/if}
          {#if turn && closes}
            <MessageTurnSummary {store} {threadId} {turn} turns={shownTurns} message={source ?? message} {messages}>
              {#snippet actions()}
                <MessageActions
                  text={() => answerOf(turn.id)}
                  retry={atRest && store.openThread?.turns.at(-1)?.id === turn.id ? () => void retry(turn.id) : undefined}
                  fork={branchable && !store.openThread?.incognito && source && source.state !== 'streaming' ? (worktree) => void store.fork(source.id, { worktree }) : undefined}
                />
              {/snippet}
            </MessageTurnSummary>
          {/if}
        </article>
      {/each}
      {#if view.below > 0}
        <div class="spacer" data-testid="timeline-below" style="height: {view.below}px"></div>
      {/if}
      {#if store.loadingNewer}<p class="loading-older" data-testid="loading-newer">{strings.chat.loadingNewer}</p>{/if}
      {#if pendingMove}<MoveMarker notice={pendingMove} pending />{/if}
    </div>
    {#if promptRoom > 0}
      <div class="spacer" data-testid="prompt-room" style:height="{promptRoom}px" aria-hidden="true"></div>
    {/if}
  </div>

  {#if behind}
    <button type="button" class="small jump" onclick={jump} data-testid="jump-to-latest">
      <ArrowDown size={14} strokeWidth={2} />
      <span class="ui-label">{unseen > 0 ? fill(unseen === 1 ? strings.chat.newMessage : strings.chat.newMessages, { count: String(unseen) }) : strings.chat.jumpToLatest}</span>
    </button>
  {/if}
</div>
{#if viewing}<ImageViewer items={viewing.items} index={viewing.index} onclose={() => { viewing = null; releaseHeld(); }} />{/if}

<style>
  .timeline-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .timeline {
    flex: 1;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable both-edges;
    /* Balance the outline rail on both sides; keep room below for the activity overlay. */
    padding: 20px var(--outline-room) calc(var(--dock-room, 0px) + 20px);
    overscroll-behavior: contain;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: var(--chat-message-gap);
    width: 100%;
    max-width: var(--content);
    margin: 0 auto;
  }

  /* What a long thread's unrendered messages weigh, above and below the window. */
  .spacer {
    flex: 0 0 auto;
  }

  /* paging: one muted line at the top while the page above is being read. */
  .loading-older { flex: 0 0 auto; text-align: center; color: var(--color-muted-foreground); font-size: var(--text-sm); }

  .message {
    display: flex;
    flex-direction: column;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .message.user {
    align-items: flex-end;
  }

  /* The rest of a cut message: the gap its first paragraph takes inside a message, and no rise of its own. */
  .message.rest {
    margin-top: calc(var(--chat-block-gap) - var(--chat-message-gap));
    animation: none;
  }

  .jump {
    position: absolute;
    left: 50%;
    bottom: calc(var(--dock-clearance, 0px) + 12px);
    /* The entrance animates transform; centering must survive every frame. */
    translate: -50% 0;
    max-width: calc(100% - 24px);
    padding: 0 10px 0 8px;
    border-radius: 999px;
    background: var(--color-surface-2);
    box-shadow: var(--shadow-e2);
    font-size: var(--text-sm);
    animation: rise var(--dur-2) var(--ease-out-quint);
  }
</style>
