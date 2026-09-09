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
  import { ArrowDown } from '@lucide/svelte';
  import type { Message } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import PermissionCard from './PermissionCard.svelte';
  import QuestionCard from './QuestionCard.svelte';
  import Prose from './Prose.svelte';
  import ThinkingPart from './ThinkingPart.svelte';
  import ToolCard from './ToolCard.svelte';

  let {
    store,
    threadId,
    messages
  }: { store: Store; threadId: string; messages: Message[] } = $props();

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
  let pinned = $state(true);
  let behind = $state(false);
  let shown = '';

  /** Measured slot heights by message id. What is not in here is worth ESTIMATE. */
  const heights = new Map<string, number>();
  /** Bumped by every measurement that moved a height, so the window recomputes on real numbers. */
  let measured = $state(0);
  /** Ids that already played the rise, so a message re-entering the window stays still. */
  const risen = new Set<string>();
  /** One observer for the viewport's height and for every rendered message. */
  let boxes: ResizeObserver | undefined;

  let scrollTop = $state(0);
  let viewHeight = $state(0);

  const windowed = $derived(messages.length > WINDOW_FROM);

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
    if (head !== sumsHead || list.length < sumsCount) {
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
    const list = messages;
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

  const rendered = $derived(messages.slice(view.start, view.end));

  /** Where a message sits now, off the map the totals keep; a miss falls back to a scan. */
  function indexOf(id: string): number {
    const at = positions.get(id);
    if (at !== undefined && messages[at]?.id === id) return at;
    return messages.findIndex((message) => message.id === id);
  }

  /**
   * A rendered message's real height replaces its estimate. One that sits above
   * what the user is reading would push the text down as it lands, so the same
   * delta goes back into `scrollTop` and the viewport does not move.
   */
  function onMeasured(entries: ResizeObserverEntry[]): void {
    const box = viewport;
    const lastId = messages.at(-1)?.id;
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
      const last = messages.at(-1);
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
    viewHeight = box.clientHeight;
    scrollTop = box.scrollTop;
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(onMeasured);
    boxes = observer;
    observer.observe(box);
    for (const node of box.querySelectorAll<HTMLElement>('[data-mid]')) observer.observe(node);
    return () => {
      observer.disconnect();
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
    pinned = atBottom(box);
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
    void store.loadOlder().then((added) => {
      if (added === 0) return;
      requestAnimationFrame(() => {
        // What the page put in front is the running total of its own messages,
        // which is a read rather than a measurement of a list that has just
        // been laid out, and it is right whether they landed in the window or
        // in the spacer above it.
        const total = totals(messages);
        const grew = total[Math.min(added, messages.length)] ?? 0;
        if (grew <= 0) return;
        box.scrollTop = topBefore + grew;
        scrollTop = box.scrollTop;
      });
    });
  }
  // -- end paging ------------------------------------------------------------

  function jump() {
    const box = viewport;
    if (!box) return;
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
    void messages.length;
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

  /**
   * The caret rides the last part when that part is text, empty or not, so it
   * blinks at the end of what is being written. A text part further up is
   * finished: the model has moved on to a card, and the block caret takes over.
   */
  function lastTextIndex(message: Message): number {
    const last = message.parts.length - 1;
    return message.parts[last]?.type === 'text' ? last : -1;
  }

  /** The pulse goes on the reasoning only while it is the last thing written. */
  function lastThinkingIndex(message: Message): number {
    const last = message.parts.length - 1;
    return message.parts[last]?.type === 'thinking' ? last : -1;
  }
</script>

<div class="timeline-wrap">
  <div class="timeline" bind:this={viewport} {onscroll} data-testid="timeline">
    <div class="column">
      <!-- paging: the one line the top of the list shows while a page is in flight. -->
      {#if store.loadingOlder}
        <p class="loading-older" data-testid="loading-older">{strings.chat.loadingOlder}</p>
      {/if}
      {#if view.above > 0}
        <div class="spacer" data-testid="timeline-above" style="height: {view.above}px"></div>
      {/if}
      {#each rendered as message (message.id)}
        <article
          use:track={message.id}
          class="message {message.role}"
          data-testid="message"
          data-role={message.role}
        >
          {#if message.role === 'user'}
            <div class="bubble">
              {#each message.parts as part, index (index)}
                {#if part.type === 'text'}
                  <p class="user-text" data-testid="text-part">{part.text}</p>
                {/if}
              {/each}
            </div>
          {:else}
            {@const caretAt = message.state === 'streaming' ? lastTextIndex(message) : -1}
            {@const thinkingAt = message.state === 'streaming' ? lastThinkingIndex(message) : -1}
            <div class="parts">
              {#each message.parts as part, index (index)}
                <div class="part" data-kind={part.type}>
                  {#if part.type === 'text'}
                    {#if part.text.length > 0 || index === caretAt}
                      <Prose text={part.text} live={index === caretAt} />
                    {/if}
                  {:else if part.type === 'thinking'}
                    <ThinkingPart text={part.text} live={index === thinkingAt} />
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
                  {:else}
                    <div class="error" data-testid="error-part">
                      <span class="section-label">{strings.chat.error}</span>
                      <p>{part.message}</p>
                    </div>
                  {/if}
                </div>
              {/each}
              {#if message.state === 'streaming' && caretAt === -1 && thinkingAt === -1}
                <span class="caret block" aria-label={strings.chat.streaming}></span>
              {/if}
            </div>
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
    padding: 20px 20px 8px;
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
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    border-bottom-right-radius: var(--radius-sm);
    box-shadow: var(--shadow-e1);
  }

  .user-text {
    white-space: pre-wrap;
    word-break: break-word;
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

  .caret {
    display: inline-block;
    width: 7px;
    height: 14px;
    margin-left: 2px;
    vertical-align: -2px;
    background: var(--color-foreground);
    border-radius: 1px;
    animation: blink 1s steps(2, start) infinite;
  }

  .caret.block {
    margin: 2px 0;
  }

  .error {
    padding: 8px 12px;
    border: 1px solid var(--color-border);
    border-left: 3px solid var(--color-danger);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }

  .error p {
    margin-top: 4px;
    white-space: pre-wrap;
    word-break: break-word;
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
