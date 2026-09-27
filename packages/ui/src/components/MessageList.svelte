<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { ArrowDown } from '@lucide/svelte';
  import type { AgentLetter, Message } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import TurnSummary from './TurnSummary.svelte';
  import TurnFiles from './TurnFiles.svelte';
  import { turnFiles, type TurnFile } from '../lib/turn-files';
  import MessageOutline from './MessageOutline.svelte';
  import ForwardedAgentMessage from './ForwardedAgentMessage.svelte';
  import DelegationActivity from './DelegationActivity.svelte';
  import UserMessage from './UserMessage.svelte';
  import AssistantMessage from './AssistantMessage.svelte';
  import { TurnProgress } from '../lib/turn-progress.svelte';
  import { ESTIMATE, GAP, OVERSCAN, SlotTotals, WINDOW_FROM, atOrBefore, reaches, windowStats } from '../lib/message-window';
  import WorkflowActivity from './WorkflowActivity.svelte';

  let {
    store,
    threadId,
    messages
  }: { store: Store; threadId: string; messages: Message[] } = $props();
  const coordination = $derived(store.coordination?.self.threadId === threadId ? store.coordination : null);
  const delegation = $derived(store.delegation && (store.delegation.rootThreadId === threadId || store.delegation.agents.some(agent => agent.thread.id === threadId)) ? store.delegation : null);
  const letters = $derived([
    ...(coordination?.messages ?? []),
    ...(delegation?.messages.filter(letter => letter.from.threadId === threadId || letter.to.threadId === threadId) ?? [])
  ]);
  const delegationLetterIds = $derived(new Set(delegation?.messages.map(letter => letter.id) ?? []));
  /** The thread's account is signed out: an error then carries the way back in. */
  const signedOut = $derived.by(() => {
    const thread = store.openThread;
    if (!thread || thread.id !== threadId) return null;
    const account = store.accountOf(thread.accountId);
    return account?.status === 'unauthenticated' ? account : null;
  });
  const letterRows = $derived.by(() => new Map(letters.map(letter => [`coordination:${letter.id}`, letter])));
  const team = $derived(delegation?.rootThreadId === threadId ? delegation.agents : []);
  const teamRowId = $derived(`delegation:${threadId}`);
  /** The runs this thread started, each a card where it began. */
  const workflowRows = $derived(new Map(store.workflowsOf(threadId).filter(run => run.rootThreadId === threadId).map(run => [`workflow:${run.id}`, run])));
  const timeline = $derived.by(() => {
    if (letters.length === 0 && team.length === 0 && workflowRows.size === 0) return messages;
    const ids = new Set(letters.map(letter => letter.id));
    const visible = messages.filter(message => !coordinationPlaceholder(message, ids));
    const forwarded = letters.map((letter): Message => ({
      id: `coordination:${letter.id}`,
      threadId,
      turnId: `coordination:${letter.id}`,
      role: 'system',
      parts: [],
      state: 'complete',
      createdAt: letter.createdAt
    }));
    const activity: Message[] = team.length ? [{
      id: teamRowId, threadId, turnId: teamRowId, role: 'system', parts: [], state: 'complete',
      createdAt: Math.min(...team.map(agent => agent.thread.createdAt))
    }] : [];
    const runs: Message[] = [...workflowRows].map(([id, run]) => ({ id, threadId, turnId: id, role: 'system', parts: [], state: 'complete', createdAt: run.createdAt }));
    return [...visible, ...forwarded, ...activity, ...runs].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  });
  const timelineOrder = $derived(timeline.map(message => message.id).join('\0'));
  const savedReading = untrack(() => store.readingPositions?.get(threadId));

  function coordinationPlaceholder(message: Message, ids: Set<string>): boolean {
    if (message.role !== 'system') return false;
    return message.parts.some(part => part.type === 'text' &&
      (part.text.startsWith('Boite agent coordination.') || part.text.startsWith('Boite delegation messages.')) &&
      [...ids].some(id => part.text.includes(`"id":"${id}"`)));
  }

  function letterSelf(letter: AgentLetter): { coreId: string; threadId: string } | null {
    if (delegationLetterIds.has(letter.id)) return { coreId: 'local', threadId };
    return coordination?.self ?? null;
  }

  /** How often the bottom message's height is allowed to speak to the pin. */
  const TAIL_GAP_MS = 100;

  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let pinned = $state(savedReading?.pinned ?? true);
  let behind = $state(false);
  let shown = savedReading ? untrack(() => threadId) : '';

  /** Measured slot heights by message id. What is not in here is worth ESTIMATE. */
  const heights = new Map<string, number>(savedReading?.heights);
  /** Bumped by every measurement that moved a height, so the window recomputes on real numbers. */
  let measured = $state(0);
  /** Ids that already played the rise, so a message re-entering the window stays still. */
  const risen = new Set<string>(savedReading?.heights.keys());
  /** One observer for the viewport's height and for every rendered message. */
  let boxes: ResizeObserver | undefined;

  let scrollTop = $state(savedReading?.top ?? 0);
  let readingAnchor = savedReading?.anchor;
  let restoringAnchor = Boolean(savedReading?.anchor && !savedReading.pinned);
  function rememberAnchor() {
    if (!viewport?.isConnected || !viewport.clientHeight || restoringAnchor) return;
    const top = viewport.getBoundingClientRect().top;
    const node = [...viewport.querySelectorAll<HTMLElement>('[data-mid]')].find(node => node.getBoundingClientRect().bottom > top);
    if (node?.dataset.mid) readingAnchor = { id: node.dataset.mid, offset: node.getBoundingClientRect().top - top };
  }
  function restoreAnchor() {
    if (!restoringAnchor || !readingAnchor || !viewport) return;
    const node = [...viewport.querySelectorAll<HTMLElement>('[data-mid]')].find(node => node.dataset.mid === readingAnchor?.id);
    if (!node) return;
    const delta = node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - readingAnchor.offset;
    if (Math.abs(delta) > 1) { viewport.scrollTop += delta; scrollTop = viewport.scrollTop; }
  }
  function releaseAnchor() { restoringAnchor = false; }
  onMount(() => {
    // Capture the settled layout before a navigation click removes this list.
    document.addEventListener('pointerdown', rememberAnchor, true);
    document.addEventListener('keydown', rememberAnchor, true);
    return () => {
      document.removeEventListener('pointerdown', rememberAnchor, true);
      document.removeEventListener('keydown', rememberAnchor, true);
    };
  });
  let restoredReading = false;
  onDestroy(() => {
    if (!viewport || !store.readingPositions) return;
    store.readingPositions.delete(threadId);
    store.readingPositions.set(threadId, { top: scrollTop, pinned, heights: new Map(heights), anchor: readingAnchor });
    while (store.readingPositions.size > 32) store.readingPositions.delete(store.readingPositions.keys().next().value!);
  });
  let viewHeight = $state(0);
  let navigationTarget = $state<string | null>(null);
  function releaseNavigation() { releaseAnchor(); navigationTarget = null; }
  const activePrompt = $derived.by(() => {
    void measured;
    const total = totals(timeline);
    const at = pinned ? timeline.length - 1 : atOrBefore(total, timeline.length, scrollTop + 24);
    for (let index = Math.min(at, timeline.length - 1); index >= 0; index--) {
      if (timeline[index]?.role === 'user') return timeline[index]!.id;
    }
    return null;
  });

  function jumpToMessage(id: string) {
    releaseAnchor();
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

  /** The running totals of the slot heights, which the window bisects. */
  const slots = new SlotTotals(heights);

  function totals(list: Message[]): number[] {
    return slots.totals(list, timelineOrder);
  }

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

    const start = Math.max(0, first - OVERSCAN);
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
      const next = Math.round(node.offsetHeight) + GAP;
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
    if (box && shift !== 0 && !pinned) box.scrollTop += shift;
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
    if (risen.has(id)) node.style.animation = 'none';
    else risen.add(id);
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
      if (savedReading && !savedReading.pinned) box.scrollTop = savedReading.top;
    }
    viewHeight = box.clientHeight;
    scrollTop = box.scrollTop;
    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const pending = new Map<Element, ResizeObserverEntry>();
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) pending.set(entry.target, entry);
      if (frame) return;
      // Applying slot heights inside ResizeObserver can resize that same batch.
      frame = requestAnimationFrame(() => {
        frame = 0;
        const batch = [...pending.values()].filter(entry => entry.target.isConnected);
        pending.clear();
        onMeasured(batch);
        restoreAnchor();
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

  function onscroll() {
    const box = viewport;
    if (!box) return;
    scrollTop = box.scrollTop;
    viewHeight = box.clientHeight;
    if (navigationTarget) return;
    pinned = atBottom(box);
    if (restoringAnchor) pinned = false;
    void tick().then(rememberAnchor);
    if (pinned) behind = false;
    pullOlder(box);
  }

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
    releaseAnchor();
    const box = viewport;
    if (!box) return;
    navigationTarget = null;
    pinned = true;
    behind = false;
    box.scrollTop = box.scrollHeight;
    scrollTop = box.scrollTop;
  }

  /**
   * A message arriving, and the bottom one growing no more than ten times a
   * second. Never the character count of what streams: reading that here ran
   * this whole effect on every token of every answer.
   */
  $effect(() => {
    void timeline.length;
    void tail;
    const box = viewport;
    if (!box) return;
    const opened = shown !== threadId;
    shown = threadId;
    if (opened || pinned) {
      box.scrollTop = box.scrollHeight;
      scrollTop = box.scrollTop;
      pinned = true;
      behind = false;
    } else {
      behind = true;
    }
  });

  /** The window moving under a pinned viewport changes the spacers: take the bottom again. */
  $effect(() => {
    void view;
    if (!pinned) return;
    const box = viewport;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  });

  // Finished and streaming messages are derived apart, so a delta never rescans the thread.
  const progress = new TurnProgress(() => messages);
  /** What each finished turn wrote, shown once at its end; a turn still running is left alone. */
  const filesByTurn = $derived.by(() => {
    const thread = store.openThread;
    const result = new Map<string, TurnFile[]>();
    if (!thread || thread.id !== threadId) return result;
    const parts = new Map<string, Message['parts']>();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      parts.set(message.turnId, [...(parts.get(message.turnId) ?? []), ...message.parts]);
    }
    for (const turn of thread.turns) {
      if (turn.status === 'running' || turn.status === 'queued') continue;
      const files = turnFiles(parts.get(turn.id) ?? [], thread.cwd);
      if (files.length > 0) result.set(turn.id, files);
    }
    return result;
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

  function toggleImage(id: string): void {
    expanded = expanded.includes(id) ? expanded.filter((entry) => entry !== id) : [...expanded, id];
  }
</script>

<div class="timeline-wrap">
  <MessageOutline {messages} active={activePrompt} jump={id => void jumpToMessage(id)}
    hasOlder={store.messagesBefore !== null} loading={store.loadingOlder} loadOlder={() => { if (viewport) { releaseNavigation(); viewport.scrollTop = 0; pinned = false; pullOlder(viewport); } }} />
  <!-- Input releases restored and navigation anchors; programmatic corrections keep them. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="timeline" bind:this={viewport} {onscroll} onwheel={releaseNavigation} ontouchstart={releaseNavigation} onpointerdown={releaseNavigation} onkeydown={releaseNavigation} data-testid="timeline">
    <div class="column">
      <!-- paging: the one line the top of the list shows while a page is in flight. -->
      {#if store.loadingOlder}
        <p class="loading-older" data-testid="loading-older">{strings.chat.loadingOlder}</p>
      {/if}
      {#if view.above > 0}
        <div class="spacer" data-testid="timeline-above" style="height: {view.above}px"></div>
      {/if}
      {#each rendered as message (message.id)}
        {@const letter = letterRows.get(message.id)}
        {@const turn = store.openThread?.turns.find(turn => turn.id === message.turnId)}
        <article
          use:track={message.id}
          class="message {message.role}"
          data-testid="message"
          data-role={letter ? 'agent-letter' : message.role}
        >
          {#if message.id === teamRowId}
            <DelegationActivity {store} agents={team} />
          {:else if workflowRows.has(message.id)}
            <WorkflowActivity {store} run={workflowRows.get(message.id)!} />
          {:else if letter && letterSelf(letter)}
            <ForwardedAgentMessage {letter} self={letterSelf(letter)!} />
          {:else if message.role === 'user'}
            <UserMessage {store} {message} {turn} {progress} {expanded} ontoggle={toggleImage} />
          {:else}
            <AssistantMessage {store} {threadId} {message} {progress} {signedOut} />
          {/if}
          {#if turn && lastInTurn.get(turn.id) === message.id && filesByTurn.has(turn.id)}
            <TurnFiles {store} files={filesByTurn.get(turn.id)!} />
          {/if}
          {#if turn && lastInTurn.get(turn.id) === message.id}
            <TurnSummary
              {turn}
              waiting={store.openThread?.status === 'waiting' && turn.status === 'running'}
              background={store.openThread?.turns.at(-1)?.id === turn.id ? store.openThread?.background ?? [] : []}
              stop={() => void store.stop()}
            />
          {/if}
        </article>
      {/each}
      {#if view.below > 0}
        <div class="spacer" data-testid="timeline-below" style="height: {view.below}px"></div>
      {/if}
    </div>
  </div>

  {#if behind}
    <button type="button" class="small jump" onclick={jump} data-testid="jump-to-latest">
      <ArrowDown size={14} strokeWidth={2} />
      {strings.chat.jumpToLatest}
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
    /* A fixed reading margin keeps the last answer above the compact activity
       overlay without moving the viewport when tasks appear or update. */
    padding: 20px 20px 132px var(--outline-room);
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
    bottom: 12px;
    transform: translateX(-50%);
    padding: 0 10px 0 8px;
    border-radius: 999px;
    background: var(--color-surface-2);
    box-shadow: var(--shadow-e2);
    font-size: var(--text-sm);
    animation: rise var(--dur-2) var(--ease-out-quint);
  }
</style>
