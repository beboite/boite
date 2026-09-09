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
    const message = list[index];
    if (!message) return ESTIMATE;
    return heights.get(message.id) ?? ESTIMATE;
  }

  /**
   * The slice of messages that meets the viewport, the overscan added, and the
   * two heights the spacers carry for everything left out. While pinned the
   * window hangs off the end of the list instead of off `scrollTop`, so the
   * bottom is right on the first frame rather than after a measurement.
   */
  const view = $derived.by(() => {
    void measured;
    const list = messages;
    if (!windowed) {
      return { start: 0, end: list.length, first: 0, above: 0, below: 0 };
    }

    let first: number;
    let last: number;
    if (pinned) {
      last = list.length;
      first = list.length;
      let filled = 0;
      while (first > 0 && filled < viewHeight) {
        first -= 1;
        filled += slotAt(list, first);
      }
    } else {
      let offset = 0;
      first = 0;
      while (first < list.length && offset + slotAt(list, first) <= scrollTop) {
        offset += slotAt(list, first);
        first += 1;
      }
      last = first;
      let bottom = offset;
      while (last < list.length && bottom < scrollTop + viewHeight) {
        bottom += slotAt(list, last);
        last += 1;
      }
    }

    const start = Math.max(0, first - OVERSCAN);
    const end = Math.min(list.length, last + OVERSCAN);
    let above = 0;
    for (let i = 0; i < start; i += 1) above += slotAt(list, i);
    let below = 0;
    for (let i = end; i < list.length; i += 1) below += slotAt(list, i);
    return { start, end, first, above, below };
  });

  const rendered = $derived(messages.slice(view.start, view.end));

  function indexOf(id: string): number {
    return messages.findIndex((message) => message.id === id);
  }

  /**
   * A rendered message's real height replaces its estimate. One that sits above
   * what the user is reading would push the text down as it lands, so the same
   * delta goes back into `scrollTop` and the viewport does not move.
   */
  function onMeasured(entries: ResizeObserverEntry[]): void {
    const box = viewport;
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
      if (indexOf(id) < view.first) shift += next - previous;
    }
    if (!moved) return;
    measured += 1;
    if (box && shift !== 0 && !pinned) box.scrollTop += shift;
  }

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

  /** Reads everything that grows, so the effect below runs on every delta. */
  function growth(list: Message[]): number {
    const last = list.at(-1);
    const text = (last?.parts ?? []).reduce((total, part) => {
      if (part.type === 'text' || part.type === 'thinking') return total + part.text.length;
      // A tool input grows the card too while the model types it, and its
      // documents land after it.
      if (part.type === 'tool') {
        return total + 1 + (part.inputText?.length ?? 0) + (part.documents?.length ?? 0);
      }
      return total + 1;
    }, 0);
    return list.length + text;
  }

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
  }

  function jump() {
    const box = viewport;
    if (!box) return;
    pinned = true;
    behind = false;
    box.scrollTop = box.scrollHeight;
    scrollTop = box.scrollTop;
  }

  $effect(() => {
    growth(messages);
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
    <button type="button" class="jump" onclick={jump} data-testid="jump-to-latest">
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
    border-bottom-right-radius: 4px;
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
    height: 26px;
    padding: 0 10px 0 8px;
    border-radius: 999px;
    background: var(--color-surface-2);
    box-shadow: var(--shadow-e2);
    font-size: var(--text-sm);
    animation: rise var(--dur-2) var(--ease-out-quint);
  }
</style>
