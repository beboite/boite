<script module lang="ts">
  /**
   * What the window has cost since the page loaded: one count per recompute of
   * the slice, one per slot height read. The bench test in `MessageList.test.ts`
   * reads them to prove both stay flat while a message streams; nothing else
   * does, and neither is reactive.
   */
  export const windowStats = { recomputes: 0, slots: 0 };
</script>

<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { ArrowDown, Check, CircleAlert, FileText } from '@lucide/svelte';
  import type { AgentLetter, Message } from '@boite/contracts';
  import { bytes } from '../lib/format';
  import { decodedBytes } from '../lib/attachments';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { formatTokens } from '../lib/tokens';
  import PermissionCard from './PermissionCard.svelte';
  import QuestionCard from './QuestionCard.svelte';
  import Prose from './Prose.svelte';
  import ThinkingPart from './ThinkingPart.svelte';
  import TurnSummary from './TurnSummary.svelte';
  import TurnFiles from './TurnFiles.svelte';
  import { turnFiles, type TurnFile } from '../lib/turn-files';
  import { promptCommand, promptText } from '../lib/message-display';
  import ToolCard from './ToolCard.svelte';
  import MessageOutline from './MessageOutline.svelte';
  import ForwardedAgentMessage from './ForwardedAgentMessage.svelte';
  import { visibleAnswer } from '../lib/message-display';
  import { isNamedModel } from '../lib/model-order';

  let {
    store,
    threadId,
    messages
  }: { store: Store; threadId: string; messages: Message[] } = $props();
  const coordination = $derived(store.coordination?.self.threadId === threadId ? store.coordination : null);
  const letters = $derived(coordination?.messages ?? []);
  /** The thread's account is signed out: an error then carries the way back in. */
  const signedOut = $derived.by(() => {
    const thread = store.openThread;
    if (!thread || thread.id !== threadId) return null;
    const account = store.accountOf(thread.accountId);
    return account?.status === 'unauthenticated' ? account : null;
  });
  const letterRows = $derived.by(() => new Map(letters.map(letter => [`coordination:${letter.id}`, letter])));
  const timeline = $derived.by(() => {
    if (letters.length === 0) return messages;
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
    return [...visible, ...forwarded].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  });
  const timelineOrder = $derived(timeline.map(message => message.id).join('\0'));
  const savedReading = untrack(() => store.readingPositions?.get(threadId));

  function coordinationPlaceholder(message: Message, ids: Set<string>): boolean {
    if (message.role !== 'system') return false;
    return message.parts.some(part => part.type === 'text' && part.text.startsWith('Boite agent coordination.') && [...ids].some(id => part.text.includes(`"id":"${id}"`)));
  }

  /** Under this many messages the list renders whole: a window would cost more than it saves. */
  const WINDOW_FROM = 60;
  /** Messages kept rendered above and below the viewport, so a scroll finds them already there. */
  const OVERSCAN = 8;
  /** What a message's slot is worth before it has been measured. */
  const ESTIMATE = 80;
  /** The column's flex gap, which belongs to the slot a message takes. */
  const GAP = 24;
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

  function slotAt(list: Message[], index: number): number {
    windowStats.slots += 1;
    const message = list[index];
    if (!message) return ESTIMATE;
    return heights.get(message.id) ?? ESTIMATE;
  }

  // -- the running totals ------------------------------------------------------
  // `sums[i]` is the height of everything above message `i`. A spacer is then
  // one subtraction and the slice one bisection, instead of the walk over every
  // message the window used to do on each recompute, streaming deltas included.

  let sums: number[] = [0];
  /** What `sums` was built on: how many messages there were, and the id at the head. */
  let sumsCount = 0;
  let sumsHead = '';
  let sumsTail = '';
  let sumsOrder = '';
  /** The lowest index a measurement invalidated. Repaired from there on the next read. */
  let dirty = 0;
  /** Where each message sits, so a measurement finds its index without scanning. */
  const positions = new Map<string, number>();

  function rebuild(list: Message[]): void {
    sums = new Array<number>(list.length + 1);
    sums[0] = 0;
    positions.clear();
    for (let i = 0; i < list.length; i += 1) {
      const message = list[i];
      if (message) positions.set(message.id, i);
      sums[i + 1] = (sums[i] ?? 0) + slotAt(list, i);
    }
    sumsCount = list.length;
    sumsHead = list[0]?.id ?? '';
    sumsTail = list.at(-1)?.id ?? '';
    sumsOrder = timelineOrder;
    dirty = list.length;
  }

  /**
   * The totals for this list. A page prepended above the window moves every
   * index and starts the array again; messages arriving at the bottom extend
   * it; a height that moved repairs the totals from its own index down, never
   * from the top.
   */
  function totals(list: Message[]): number[] {
    const head = list[0]?.id ?? '';
    if (head !== sumsHead || list.length < sumsCount || (list.length === sumsCount && timelineOrder !== sumsOrder) || (list.length > sumsCount && list[sumsCount - 1]?.id !== sumsTail)) {
      rebuild(list);
      return sums;
    }
    if (list.length > sumsCount) {
      sums.length = list.length + 1;
      if (sumsCount < dirty) dirty = sumsCount;
      for (let i = sumsCount; i < list.length; i += 1) {
        const message = list[i];
        if (message) positions.set(message.id, i);
      }
      sumsCount = list.length;
    }
    for (let i = dirty; i < list.length; i += 1) sums[i + 1] = (sums[i] ?? 0) + slotAt(list, i);
    dirty = list.length;
    sumsTail = list.at(-1)?.id ?? '';
    sumsOrder = timelineOrder;
    return sums;
  }

  /** The last message whose top is at or above `at`. The totals only ever grow. */
  function atOrBefore(total: number[], count: number, at: number): number {
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((total[mid] ?? 0) <= at) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  /** The first message at or after `from` whose top reaches `at`, or the end of the list. */
  function reaches(total: number[], count: number, from: number, at: number): number {
    let low = from;
    let high = count;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((total[mid] ?? 0) >= at) high = mid;
      else low = mid + 1;
    }
    return low;
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

  /** Where a message sits now, off the map the totals keep; a miss falls back to a scan. */
  function indexOf(id: string): number {
    const at = positions.get(id);
    if (at !== undefined && timeline[at]?.id === id) return at;
    return timeline.findIndex((message) => message.id === id);
  }

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
      const at = indexOf(id);
      if (at < 0) continue;
      // Everything from here down is worth a different number now.
      if (at < dirty) dirty = at;
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

  function lastTextIndex(message: Message): number {
    const last = message.parts.length - 1;
    return message.parts[last]?.type === 'text' ? last : -1;
  }

  // One reasoning disclosure per turn. New reasoning replaces its previous text.
  const thoughts = $derived.by(() => {
    const result = new Map<string, { host: string; text: string; live: boolean }>();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const [index, part] of message.parts.entries()) {
        if (part.type !== 'thinking') continue;
        const previous = result.get(message.turnId);
        result.set(message.turnId, { host: previous?.host ?? message.id, text: part.text || previous?.text || '', live: message.state === 'streaming' && index === message.parts.length - 1 });
      }
    }
    return result;
  });
  const responded = $derived(new Set(messages.filter(m => m.role === 'assistant' && m.parts.some(p => p.type === 'text' || p.type === 'thinking' ? p.text.length > 0 : true)).map(m => m.turnId)));
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

  type ImagePart = Extract<Message['parts'][number], { type: 'image' }>;

  /** The pictures a prompt was sent with; an assistant message never has one. */
  function imagesOf(message: Message): ImagePart[] {
    return message.parts.filter((part): part is ImagePart => part.type === 'image');
  }

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
          {#if letter && coordination}
            <ForwardedAgentMessage {letter} self={coordination.self} />
          {:else if message.role === 'user'}
            {@const images = imagesOf(message)}
            <div class="bubble">
              {#each message.parts as part, index (index)}
                {#if part.type === 'text'}
                  {@const prompt = promptText(part)}
                  {@const command = promptCommand(prompt)}
                  <p class="user-text" data-testid="text-part">{#if command}<span class="command">{command}</span>{prompt.slice(command.length)}{:else}{prompt}{/if}</p>
                {:else if part.type === 'file'}
                  <a class="file-attachment" data-testid="file-part" href="data:application/octet-stream;base64,{part.data}" download={part.name ?? strings.composer.attachAlt}>
                    <FileText size={20} strokeWidth={1.5} />
                    <span><span>{part.name ?? strings.composer.attachAlt}</span><small>{bytes(decodedBytes(part.data))}</small></span>
                  </a>
                {/if}
              {/each}
              {#if images.length > 0}
                <div class="images">
                  {#each images as image, at (at)}
                    {@const id = `${message.id}:${at}`}
                    <button
                      type="button"
                      class="shot"
                      class:full={expanded.includes(id)}
                      title={image.alt ?? strings.chat.imagePart}
                      onclick={() => toggleImage(id)}
                    >
                      <img
                        data-testid="image-part"
                        src="data:{image.mimeType};base64,{image.data}"
                        alt={image.alt ?? ''}
                      />
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
            <div class="receipts" data-testid="message-receipts">
              <span class:received={!!turn} title={strings.chat.accepted} aria-label={strings.chat.accepted}><Check size={12} /></span>
              <span class:received={responded.has(message.turnId)} title={strings.chat.responseStarted} aria-label={strings.chat.responseStarted}><Check size={12} /></span>
            </div>
          {:else}
            {@const execution = store.openThread?.turns.find((turn) => turn.id === message.turnId)?.execution}
            {#if message.role === 'assistant' && execution}
              {@const model = store.modelsOf(execution.providerId, execution.accountId).find((model) => model.id === execution.model)}
              <div class="model-attribution" data-testid="message-model">
                {execution.model && isNamedModel(model ?? { id: execution.model, name: execution.model }) ? model?.name ?? execution.model : store.providerOf(execution.providerId)?.name}
              </div>
            {/if}
            {#if message.role === 'system'}
              <div class="system-attribution" data-testid="message-system">{strings.chat.system}</div>
            {/if}
            {@const caretAt = message.state === 'streaming' ? lastTextIndex(message) : -1}
            {@const thought = thoughts.get(message.turnId)}
            {#if thought?.host === message.id}<ThinkingPart text={thought.text} live={thought.live} />{/if}
            <div class="parts">
              {#each message.parts as part, index (index)}
                {#if part.type !== 'thinking'}
                <div class="part" data-kind={part.type}>
                  {#if part.type === 'text'}
                    {@const shownText = message.role === 'system' ? promptText(part) : visibleAnswer(part.text)}
                    {#if shownText.length > 0 || index === caretAt}
                      <Prose text={shownText} live={index === caretAt} />
                    {/if}

                  {:else if part.type === 'tool'}
                    <ToolCard
                      name={part.name}
                      input={part.input}
                      inputText={part.inputText}
                      output={part.output}
                      status={part.status}
                      documents={part.documents ?? []}
                    />
                  {:else if part.type === 'permission'}
                    <PermissionCard
                      toolName={part.toolName}
                      decision={part.decision}
                      request={store.permissionRequests[part.requestId] ?? null}
                      answer={(decision) => void store.answer(part.requestId, decision)}
                    />
                  {:else if part.type === 'question'}
                    <QuestionCard
                      text={part.text}
                      options={part.options}
                      allowText={part.allowText}
                      multiple={part.multiple}
                      answer={part.answer ?? null}
                      pending={store.pendingQuestions.some((q) => q.id === part.questionId)}
                      submit={(optionIds, text) =>
                        void store.answerQuestion(message.threadId, part.questionId, optionIds, text)}
                    />
                  {:else if part.type === 'compaction'}
                    <div class="compaction" data-testid="compaction-part" data-trigger={part.trigger}>
                      <span class="rule"></span>
                      <span class="label">
                        {part.preTokens === null ? strings.chat.compactionUnknown : part.postTokens === null
                          ? strings.chat.compactionNoPost.replace('{pre}', formatTokens(part.preTokens))
                          : strings.chat.compaction
                              .replace('{pre}', formatTokens(part.preTokens))
                              .replace('{post}', formatTokens(part.postTokens))}
                        {#if part.trigger === 'manual'}({strings.chat.compactionManual}){/if}
                      </span>
                      <span class="rule"></span>
                    </div>
                  {:else if part.type === 'error'}
                    <div class="error" data-testid="error-part">
                      <span class="section-label error-head"><CircleAlert size={13} strokeWidth={2} />{strings.chat.error}</span>
                      <p>{part.message}</p>
                      {#if signedOut && store.owner}
                        <button type="button" class="quiet small reconnect" data-testid="error-reconnect" onclick={() => store.openConnect(signedOut.providerId, signedOut.id)}>{strings.connect.reconnect}</button>
                      {/if}
                    </div>
                  {/if}
                </div>
                {/if}
              {/each}
            </div>
          {/if}
          {#if turn && lastInTurn.get(turn.id) === message.id && filesByTurn.has(turn.id)}
            <TurnFiles {store} files={filesByTurn.get(turn.id)!} />
          {/if}
          {#if turn && lastInTurn.get(turn.id) === message.id}
            <TurnSummary {turn} waiting={store.openThread?.status === 'waiting' && turn.status === 'running'} />
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
  /* On the same 4 px rest as the parts it names. */
  .model-attribution { color: var(--color-muted-foreground); font-size: var(--text-xs); margin-bottom: 4px; padding-left: 4px; }
  .system-attribution { width: fit-content; margin-bottom: 6px; padding: 2px 7px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); color: var(--color-muted-foreground); background: var(--color-surface-2); font-size: var(--text-xs); font-weight: 600; }
  .receipts { display: flex; gap: 1px; margin: 4px 2px 0; color: var(--color-muted-foreground); }
  .receipts span { display: flex; opacity: .45; }
  .receipts .received { color: var(--color-accent); opacity: 1; }
  .command { color: var(--color-accent); font-weight: 600; }
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
    padding: 20px 20px 132px 38px;
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

  .bubble {
    max-width: 75%;
    padding: 10px 14px;
    background: var(--color-accent-soft);
    border: 1px solid color-mix(in oklch, var(--color-accent) 35%, transparent);
    border-radius: var(--radius-lg);
    border-bottom-right-radius: var(--radius-sm);
    box-shadow: var(--shadow-e1);
  }

  .user-text {
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* The images sent with the prompt, in a row that wraps under the text. */
  .file-attachment { display: flex; align-items: center; gap: 10px; margin-top: 8px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-md); color: inherit; text-decoration: none; max-width: 280px; }
  .file-attachment:hover { background: var(--color-surface); }
  .file-attachment > span { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .file-attachment > span > span { overflow-wrap: anywhere; font-size: var(--text-sm); }
  .file-attachment small { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }

  .user-text + .images {
    margin-top: 8px;
  }

  .shot {
    height: auto;
    width: auto;
    max-width: 100%;
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    overflow: hidden;
    cursor: zoom-in;
  }

  .shot:hover:not(:disabled) {
    background: var(--color-surface);
    border-color: var(--color-edge);
  }

  .shot img {
    display: block;
    max-width: 100%;
    max-height: 240px;
    object-fit: contain;
  }

  /* Clicked once, the picture is worth its own size instead of a thumbnail. */
  .shot.full {
    cursor: zoom-out;
  }

  .shot.full img {
    max-height: none;
  }

  /* A 4 px rest on the left so an answer does not kiss the column's edge. */
  .parts {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 4px;
    max-width: 100%;
  }

  .part {
    min-width: 0;
  }

  /* Consecutive cards stack as one block at the flex gap; text on either side
     of a card, or two text blocks in a row, get the full 12 px instead. */
  .part[data-kind='text'] + .part,
  .part[data-kind='thinking'] + .part,
  .part[data-kind='error'] + .part,
  .part + .part[data-kind='text'],
  .part + .part[data-kind='thinking'],
  .part + .part[data-kind='error'] {
    margin-top: 10px;
  }

  /* An answer is read at its own measure; cards keep the whole column. */
  .part[data-kind='text'] {
    max-width: var(--prose);
  }

  .error {
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }

  .error-head {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .error-head :global(svg) { color: var(--color-danger); }

  .error .reconnect { margin-top: 8px; }

  .error p {
    margin-top: 4px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* A compaction is a divider between what the agent still holds and what it let go. */
  .compaction {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 6px 0;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .compaction .rule {
    flex: 1;
    height: 1px;
    background: var(--color-border);
  }

  .compaction .label {
    flex: none;
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
