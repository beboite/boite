<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { ArrowDown } from '@lucide/svelte';
  import type { Message, MoveNotice, ThreadLink } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import MessageTurnSummary from './MessageTurnSummary.svelte';
  import TurnFiles from './TurnFiles.svelte';
  import { visibleTurnFiles } from '../lib/turn-files';
  import MessageOutline from './MessageOutline.svelte';
  import AgentMessageGroup from './AgentMessageGroup.svelte';
  import { agentMailFor, groupAgentMail, withAgentMail } from '../lib/agent-mail';
  import DelegationActivity from './DelegationActivity.svelte';
  import UserMessage from './UserMessage.svelte';
  import AssistantMessage from './AssistantMessage.svelte';
  import MoveMarker from './MoveMarker.svelte';
  import SpawnMarker from './SpawnMarker.svelte';
  import MemoryRow from './MemoryRow.svelte';
  import { placeMemoryEvents } from '../lib/memory-timeline';
  import MessageActions from './MessageActions.svelte';
  import { turnAnswer } from '../lib/message-display';
  import { focusComposer } from '../lib/focus';
  import { TurnProgress } from '../lib/turn-progress.svelte';
  import { ESTIMATE, GAP, OVERSCAN, SlotTotals, WINDOW_FROM, atOrBefore, reaches, windowStats } from '../lib/message-window';
  import WorkflowActivity from './WorkflowActivity.svelte';
  import { dockRoom } from '../lib/question-dock.svelte';
  import { glides } from '../lib/motion';
  import { BottomGlide, PointerHold, keysUp, typingKey, watchWheel, wheelsUp } from '../lib/timeline-follow';

  let {
    store,
    threadId,
    messages
  }: { store: Store; threadId: string; messages: Message[] } = $props();
  /** The find bar is its own chunk, fetched the first time it opens. A failed fetch tries again on the next open. */
  let FindBar = $state.raw<typeof import('./FindBar.svelte').default>();
  $effect(() => {
    if (store.findOpen && !FindBar) void import('./FindBar.svelte').then((module) => { FindBar = module.default; }).catch(() => { store.findOpen = false; });
  });
  const delegation = $derived(store.delegation && (store.delegation.rootThreadId === threadId || store.delegation.agents.some(agent => agent.thread.id === threadId)) ? store.delegation : null);
  const mail = $derived(agentMailFor(store, threadId));
  /** The thread's account is signed out: an error then carries the way back in. */
  const signedOut = $derived.by(() => {
    const thread = store.openThread;
    if (!thread || thread.id !== threadId) return null;
    const account = store.accountOf(thread.accountId);
    return account?.status === 'unauthenticated' ? account : null;
  });
  const team = $derived(delegation?.rootThreadId === threadId ? delegation.agents : []);
  const teamRowId = $derived(`delegation:${threadId}`);
  /** The runs this thread started, each a card where it began. */
  const workflowRows = $derived(new Map(store.workflowsOf(threadId).filter(run => run.rootThreadId === threadId).map(run => [`workflow:${run.id}`, run])));
  const grouped = $derived.by(() => {
    if (mail.length === 0 && team.length === 0 && workflowRows.size === 0 && memoryRows.size === 0) return { timeline: messages, groups: new Map() };
    const activity: Message[] = team.length ? [{
      id: teamRowId, threadId, turnId: teamRowId, role: 'system', parts: [], state: 'complete',
      createdAt: Math.min(...team.map(agent => agent.thread.createdAt))
    }] : [];
    const runs: Message[] = [...workflowRows].map(([id, run]) => ({ id, threadId, turnId: id, role: 'system', parts: [], state: 'complete', createdAt: run.createdAt }));
    const memory: Message[] = [...memoryRows].map(([id, event]) => ({ id, threadId, turnId: id, role: 'system', parts: [], state: 'complete', createdAt: event.at }));
    const rows = [...withAgentMail(messages, mail, threadId), ...activity, ...runs, ...memory].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return groupAgentMail(rows, mail);
  });
  const timeline = $derived(grouped.timeline);
  const memoryPlacement = $derived(placeMemoryEvents(messages, store.openThread?.id === threadId ? store.openThread.memoryEvents ?? [] : store.delegationThread?.id === threadId ? store.delegationThread.memoryEvents ?? [] : []));
  const memoryRows = $derived(new Map(memoryPlacement.standalone.map((event, index) => [`memory:${event.at}:${event.kind}:${index}`, event])));
  const timelineOrder = $derived(timeline.map(message => message.id).join('\0'));
  const savedReading = untrack(() => store.readingPositions?.get(threadId));

  /** The core's line for a move the agent asked for itself (`boite thread move`), drawn as a marker, not a message. */
  function movedBy(message: Message): MoveNotice | null {
    if (message.role !== 'system') return null;
    for (const part of message.parts) if (part.type === 'text' && part.moved?.by === 'agent') return part.moved;
    return null;
  }

  /** The core's line for a thread the agent started (`boite thread new`). */
  function startedFrom(message: Message): ThreadLink | null {
    if (message.role !== 'system') return null;
    for (const part of message.parts) if (part.type === 'text' && part.started) return part.started;
    return null;
  }

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

  /** Measured slot heights by message id. What is not in here is worth ESTIMATE. */
  const heights = new Map<string, number>(savedReading?.heights);
  /** Bumped by every measurement that moved a height, so the window recomputes on real numbers. */
  let measured = $state(0);
  /** Ids that already played the rise, so a message re-entering the window stays still. */
  const risen = new Set<string>([...(savedReading?.heights.keys() ?? []), ...untrack(() => messages.map(message => message.id))]);
  /** One observer for the viewport's height and for every rendered message. */
  let boxes: ResizeObserver | undefined;

  const slots = new SlotTotals(heights);
  const savedTop = untrack(() => {
    const anchor = savedReading?.pinned ? undefined : savedReading?.anchor;
    const at = anchor ? timeline.findIndex(message => message.id === anchor.id) : -1;
    return at < 0 ? savedReading?.top ?? 0 : Math.max(0, (slots.totals(timeline, timelineOrder)[at] ?? 0) - anchor!.offset);
  });
  let scrollTop = $state(savedTop);
  let readingAnchor = savedReading?.anchor;
  let restoringAnchor = Boolean(savedReading?.anchor && !savedReading.pinned);
  function rememberAnchor() {
    if (!viewport?.isConnected || !viewport.clientHeight || restoringAnchor) return;
    const top = viewport.getBoundingClientRect().top;
    for (const node of viewport.querySelectorAll<HTMLElement>('[data-mid]')) {
      const box = node.getBoundingClientRect();
      if (box.bottom <= top) continue;
      if (node.dataset.mid) readingAnchor = { id: node.dataset.mid, offset: box.top - top };
      return;
    }
  }
  /** Typing in a field never leaves the thread: a chord, Enter, Escape or a key outside a field reads the anchor. */
  function rememberBeforeKey(event: KeyboardEvent) { if (!typingKey(event)) rememberAnchor(); }
  function restoreAnchor(anchor = readingAnchor) {
    if (!anchor || !viewport?.isConnected || pinned || navigationTarget || promptTarget) return;
    const node = [...viewport.querySelectorAll<HTMLElement>('[data-mid]')].find(node => node.dataset.mid === anchor.id);
    if (!node) return;
    const delta = node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) > 1) { viewport.scrollTop += delta; scrollTop = viewport.scrollTop; }
    readingAnchor = anchor;
  }
  function releaseAnchor() { restoringAnchor = false; }
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
    store.readingPositions.set(threadId, { top: scrollTop, pinned, heights: new Map(heights), anchor: readingAnchor, height: viewHeight, reservePrompt, followPrompt: promptTarget });
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
    const total = totals(timeline);
    const at = pinned ? timeline.length - 1 : atOrBefore(total, timeline.length, scrollTop + 24);
    for (let index = Math.min(at, timeline.length - 1); index >= 0; index--) {
      if (timeline[index]?.role === 'user') return timeline[index]!.id;
    }
    return null;
  });

  function jumpToMessage(id: string) {
    releaseNavigation();
    const box = viewport;
    const index = timeline.findIndex(message => message.id === id);
    if (!box || index < 0) return;
    navigationTarget = id;
    pinned = false;
    behind = true;
    box.scrollTop = totals(timeline)[index] ?? 0;
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
      const node = Array.from(box.querySelectorAll<HTMLElement>('[data-mid]')).find(node => node.dataset.mid === id);
      if (!node) return;
      node.style.animation = 'none';
      const delta = node.getBoundingClientRect().top - box.getBoundingClientRect().top - 20;
      if (Math.abs(delta) > 1) box.scrollTop += delta;
      scrollTop = box.scrollTop;
    });
    return () => cancelAnimationFrame(frame);
  });

  const windowed = $derived(timeline.length > WINDOW_FROM);

  function totals(list: Message[]): number[] {
    return slots.totals(list, timelineOrder);
  }

  const promptInset = $derived(Math.min(96, Math.max(48, viewHeight * 0.12)));
  const promptLead = $derived.by(() => {
    void measured;
    const before = reservePrompt ? totals(timeline)[timeline.findIndex(message => message.id === reservePrompt)] ?? 0 : Infinity;
    return Math.max(0, promptInset - 20 - before);
  });
  // Keep the remaining screen below the sent prompt. Real response height replaces the
  // reserved space, including in a virtualized conversation, without moving it.
  const promptRoom = $derived.by(() => {
    void measured;
    if (!reservePrompt) return 0;
    const at = timeline.findIndex(message => message.id === reservePrompt);
    if (at < 0) return 0;
    const total = totals(timeline);
    const content = (total[timeline.length] ?? 0) - (total[at] ?? 0) - GAP;
    return Math.max(0, viewHeight - promptInset - 20 - dockRoom.height - content);
  });

  function promptTop(id: string): number {
    const box = viewport!;
    const node = [...box.querySelectorAll<HTMLElement>('[data-mid]')].find(node => node.dataset.mid === id);
    if (node) {
      node.style.animation = 'none';
      return box.scrollTop + node.getBoundingClientRect().top - box.getBoundingClientRect().top - promptInset;
    }
    const top = totals(timeline)[timeline.findIndex(message => message.id === id)];
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
  const view = $derived.by(() => {
    void measured;
    windowStats.recomputes += 1;
    const list = timeline;
    if (!windowed) {
      return { start: 0, end: list.length, first: 0, above: 0, below: 0 };
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
    return { start, end, first, above: total[start] ?? 0, below: whole - (total[end] ?? 0) };
  });

  const rendered = $derived(timeline.slice(view.start, view.end));

  /**
   * A rendered message's real height replaces its estimate. One that sits above
   * what the user is reading would push the text down as it lands, so the same
   * delta goes back into `scrollTop` and the viewport does not move.
   */
  function onMeasured(entries: ResizeObserverEntry[]): void {
    const box = viewport;
    const lastId = timeline.at(-1)?.id;
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
      // The observer already measured the box; reading `offsetHeight` again
      // would lay out, mid-scroll, whatever the window just mounted.
      const next = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight) + GAP;
      const previous = heights.get(id) ?? ESTIMATE;
      if (previous === next) continue;
      heights.set(id, next);
      moved = true;
      const at = slots.indexOf(timeline, id);
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
      const last = timeline.at(-1);
      tail = last ? (heights.get(last.id) ?? ESTIMATE) : 0;
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
  function track(node: HTMLElement, id: string): { destroy(): void } {
    node.dataset['mid'] = id;
    // A message rises as it arrives at the bottom being watched. One that a
    // scroll up the history brings into the window is already there: rising
    // then animated every message a fast scroll crossed.
    if (risen.has(id) || !pinned) node.style.animation = 'none';
    risen.add(id);
    boxes?.observe(node);
    return {
      destroy() {
        boxes?.unobserve(node);
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
      if (following()) box.scrollTop = box.scrollHeight;
      if (frame) return;
      // Applying slot heights inside ResizeObserver can resize that same batch.
      frame = requestAnimationFrame(() => {
        frame = 0;
        const batch = [...pending.values()].filter(entry => entry.target.isConnected);
        pending.clear();
        // Estimated rows can be taller than their slot totals. Keep the actual
        // visible message, then align it after Svelte updates the spacers.
        rememberAnchor();
        const anchor = readingAnchor;
        onMeasured(batch);
        void tick().then(() => restoreAnchor(anchor));
      });
    });
    boxes = observer;
    observer.observe(box);
    for (const node of box.querySelectorAll<HTMLElement>('[data-mid]')) observer.observe(node);
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
    if (distance <= 1 && movedDown) leftBottom = false;
    // A card shrinking can clamp scrollTop before new output grows the list again.
    pinned = !leftBottom && (atBottom(box) || (pinned && resized && !hold.held));
    if (restoringAnchor) pinned = false;
    // Away from the bottom, the way back shows, whether or not anything new came in.
    behind = !pinned;
    if (pinned) markSeen();
    pullOlder(box);
  }

  /** A wheel turned up leaves the bottom at once: waiting for the 80 px that unpin it let a
   *  streaming answer pull the first notches of a smooth wheel back down, frame after frame. */
  let leftBottom = false;
  function onwheel(event: WheelEvent) {
    releaseNavigation();
    if (!viewport || !wheelsUp(event, viewport)) return;
    leftBottom = true;
    if (pinned) { pinned = false; behind = true; }
  }

  /** A finger, a text selection or the scrollbar thumb holds the list where it is; the glide is what
   *  "Jump to latest" starts, whose scroll events neither unpin the list nor bring the button back. */
  const hold = new PointerHold(), glide = new BottomGlide();
  function press(event: PointerEvent | TouchEvent) { releaseNavigation(); hold.press(event); }
  /** Whether the list keeps to the bottom right now: pinned, and nobody is moving it. */
  const following = () => pinned && !navigationTarget && !glide.active && !hold.held;

  // -- paging ----------------------------------------------------------------
  // Two things in this file belong to the paged history, and they are both here:
  // the trigger near the top of the list, and the scroll compensation once the
  // prepended page has been laid out. Everything else above is the windowing.

  /** How close to the top the viewport gets before the page above it is asked for. */
  const LOAD_AT = 400;

  /**
   * Asks the store for the page above the window, then puts the height it added
   * back into `scrollTop` on the next frame, so the message being read stays
   * exactly where it was. The store itself refuses a second call while one is in
   * flight and a call with no cursor left.
   */
  function pullOlder(box: HTMLDivElement): void {
    if (box.scrollTop > LOAD_AT) return;
    if (store.messagesBefore === null || store.loadingOlder) return;
    const topBefore = box.scrollTop;
    const headBefore = timeline[0]?.id;
    void store.loadOlder().then((added) => {
      if (added === 0) return;
      requestAnimationFrame(() => {
        // What the page put in front is the running total of its own messages,
        // which is a read rather than a measurement of a list that has just
        // been laid out, and it is right whether they landed in the window or
        // in the spacer above it.
        const total = totals(timeline);
        const before = headBefore ? timeline.findIndex(message => message.id === headBefore) : Math.min(added, timeline.length);
        const grew = total[Math.max(0, before)] ?? 0;
        if (grew <= 0) return;
        box.scrollTop = topBefore + grew;
        scrollTop = box.scrollTop;
      });
    });
  }
  // -- end paging ------------------------------------------------------------

  function jump() {
    releaseNavigation();
    const box = viewport;
    if (!box) return;
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
    box.scrollTop = box.scrollHeight;
    scrollTop = box.scrollTop;
  }

  /** The glide is over: arrived or out of time, the list pins again; taken over by the reader, it stays where it stopped. */
  function endGlide(arrived: boolean) {
    if (!glide.active) return;
    glide.stop();
    const box = viewport;
    if (!box) return;
    if (arrived) {
      box.scrollTop = box.scrollHeight;
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
        scrolledHeight = box.scrollHeight; box.scrollTop = scrolledHeight;
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
    box.scrollTop = box.scrollHeight;
    scrollTop = box.scrollTop;
  });

  /** The window moving under a pinned viewport changes the spacers: take the bottom again. */
  $effect(() => {
    void view;
    if (!untrack(following)) return;
    const box = viewport;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  });

  // Finished and streaming messages are derived apart, so a delta never rescans the thread.
  const progress = new TurnProgress(() => messages);
  /** One model attribution per turn, independent of the rendered window and streamed parts. */
  const firstAssistantInTurn = $derived.by(() => {
    const result = new Map<string, string>();
    for (const message of messages) {
      if (message.role === 'assistant' && !result.has(message.turnId)) result.set(message.turnId, message.id);
    }
    return result;
  });
  /** What each finished turn wrote, shown once at its end; a turn still running is left alone. */
  const filesByTurn = $derived.by(() => {
    const thread = store.openThread;
    if (!thread || thread.id !== threadId) return new Map();
    return visibleTurnFiles(messages, thread.turns, new Set(rendered.map(message => message.turnId)), thread.cwd);
  });
  const lastInTurn = $derived.by(() => {
    const result = new Map<string, string>();
    for (const message of messages) result.set(message.turnId, message.id);
    return result;
  });
  /**
   * The images a user message carries, shown at their natural size once
   * clicked: `message.id:index` per picture, so the pair survives the window
   * dropping the message and building it again.
   */
  let expanded = $state<string[]>([]);

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
  const atRest = $derived(branchable && !store.busy && (store.composerStates[threadId]?.queued.length ?? 0) === 0);

  function editMessage(message: Message): void {
    store.startEdit(threadId, message);
    focusComposer();
  }

  /** The last turn again from its own prompt: the answer and what followed it leave, the same prompt goes out. */
  async function retry(turnId: string): Promise<void> {
    const prompt = messages.find((message) => message.turnId === turnId && message.role === 'user');
    if (!prompt) return;
    const rewound = await store.rewind(prompt.id);
    if (!rewound) return;
    const sent = await store.send(rewound.prompt, threadId, rewound.attachments, rewound.previewReferences);
    // The rewind already took the prompt away: a failed send leaves it in the box, not nowhere.
    if (!sent) store.restoreDraft(threadId, rewound.prompt, rewound.attachments, rewound.previewReferences);
  }

  function toggleImage(id: string): void {
    expanded = expanded.includes(id) ? expanded.filter((entry) => entry !== id) : [...expanded, id];
  }
</script>

<div class="timeline-wrap" style:--dock-room="{dockRoom.height}px" style:--dock-clearance="{dockRoom.clearance}px">
  {#if store.findOpen && FindBar}
    <FindBar {messages} {viewport} request={store.findRequest} jump={(id) => jumpToMessage(id)} onclose={() => (store.findOpen = false)} />
  {/if}
  <MessageOutline {messages} active={activePrompt} jump={id => void jumpToMessage(id)}
    hasOlder={store.messagesBefore !== null} loading={store.loadingOlder} loadOlder={() => { if (viewport) { releaseNavigation(); viewport.scrollTop = 0; pinned = false; pullOlder(viewport); } }} />
  <!-- Input releases restored and navigation anchors; programmatic corrections keep them. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="timeline" bind:this={viewport} use:watchWheel={onwheel} {onscroll} ontouchstart={press} onpointerdown={press} onkeydown={releaseNavigation} style:padding-top="{20 + promptLead}px" style:overflow-anchor={timeline.at(-1)?.state === 'streaming' ? 'none' : undefined} data-testid="timeline">
    <div class="column">
      <!-- paging: the one line the top of the list shows while a page is in flight. -->
      {#if store.loadingOlder}
        <p class="loading-older" data-testid="loading-older">{strings.chat.loadingOlder}</p>
      {/if}
      {#if view.above > 0}
        <div class="spacer" data-testid="timeline-above" style="height: {view.above}px"></div>
      {/if}
      {#each rendered as message (message.id)}
        {@const group = grouped.groups.get(message.id)}
        {@const turn = store.openThread?.turns.find(turn => turn.id === message.turnId)}
        <article
          use:track={message.id}
          class="message {message.role}"
          data-testid="message"
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
            <UserMessage {store} {message} {turn} {progress} {expanded} ontoggle={toggleImage} edit={atRest ? () => editMessage(message) : undefined} />
          {:else}
            <AssistantMessage {store} {threadId} {message} {signedOut} showModel={firstAssistantInTurn.get(message.turnId) === message.id} memoryEvents={memoryPlacement.inline.get(message.id) ?? []} />
          {/if}
          {#if turn && lastInTurn.get(turn.id) === message.id && filesByTurn.has(turn.id)}
            <TurnFiles {store} {...filesByTurn.get(turn.id)!} />
          {/if}
          {#if turn && lastInTurn.get(turn.id) === message.id}
            <MessageTurnSummary {store} {threadId} {turn} {message}>
              {#snippet actions()}
                <MessageActions
                  text={() => answerOf(turn.id)}
                  retry={atRest && store.openThread?.turns.at(-1)?.id === turn.id ? () => void retry(turn.id) : undefined}
                  fork={branchable && message.state !== 'streaming' ? (worktree) => void store.fork(message.id, { worktree }) : undefined}
                />
              {/snippet}
            </MessageTurnSummary>
          {/if}
        </article>
      {/each}
      {#if view.below > 0}
        <div class="spacer" data-testid="timeline-below" style="height: {view.below}px"></div>
      {/if}
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
    gap: 24px;
    width: 100%;
    max-width: var(--content);
    margin: 0 auto;
  }

  /* What a long thread's unrendered messages weigh, above and below the window. */
  .spacer {
    flex: 0 0 auto;
  }

  /* paging: one muted line at the top while the page above is being read. */
  .loading-older {
    flex: 0 0 auto;
    text-align: center;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }

  .message {
    display: flex;
    flex-direction: column;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .message.user {
    align-items: flex-end;
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
