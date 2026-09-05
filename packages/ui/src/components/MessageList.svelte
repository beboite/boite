<script lang="ts">
  import { ArrowDown } from '@lucide/svelte';
  import type { Message } from '@boite/contracts';
  import { renderMarkdown } from '../lib/markdown';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import PermissionCard from './PermissionCard.svelte';
  import ToolCard from './ToolCard.svelte';

  let {
    store,
    threadId,
    messages
  }: { store: Store; threadId: string; messages: Message[] } = $props();

  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let pinned = $state(true);
  let behind = $state(false);
  let shown = '';

  /** Reads everything that grows, so the effect below runs on every delta. */
  function growth(list: Message[]): number {
    const last = list.at(-1);
    const text = (last?.parts ?? []).reduce(
      (total, part) => total + (part.type === 'text' ? part.text.length : 1),
      0
    );
    return list.length + text;
  }

  function atBottom(box: HTMLDivElement): boolean {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }

  function onscroll() {
    const box = viewport;
    if (!box) return;
    pinned = atBottom(box);
    if (pinned) behind = false;
  }

  function jump() {
    const box = viewport;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    pinned = true;
    behind = false;
  }

  $effect(() => {
    growth(messages);
    const box = viewport;
    if (!box) return;
    const opened = shown !== threadId;
    shown = threadId;
    if (opened || pinned) {
      box.scrollTop = box.scrollHeight;
      pinned = true;
      behind = false;
    } else {
      behind = true;
    }
  });

  function lastTextIndex(message: Message): number {
    for (let index = message.parts.length - 1; index >= 0; index -= 1) {
      if (message.parts[index]?.type === 'text') return index;
    }
    return -1;
  }
</script>

<div class="timeline-wrap">
  <div class="timeline" bind:this={viewport} {onscroll} data-testid="timeline">
    <div class="column">
      {#each messages as message (message.id)}
        <article class="message {message.role}" data-testid="message" data-role={message.role}>
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
            <div class="parts">
              {#each message.parts as part, index (index)}
                {#if part.type === 'text'}
                  {#if part.text.length > 0 || index === caretAt}
                    <div class="prose" data-testid="text-part">
                      {@html renderMarkdown(part.text)}{#if index === caretAt}<span class="caret" aria-label={strings.chat.streaming}></span>{/if}
                    </div>
                  {/if}
                {:else if part.type === 'tool'}
                  <ToolCard name={part.name} input={part.input} output={part.output} status={part.status} />
                {:else if part.type === 'permission'}
                  <PermissionCard
                    toolName={part.toolName}
                    decision={part.decision}
                    request={store.permissionRequests[part.requestId] ?? null}
                    answer={(decision) => void store.answer(part.requestId, decision)}
                  />
                {:else}
                  <div class="error" data-testid="error-part">
                    <span class="section-label">{strings.chat.error}</span>
                    <p>{part.message}</p>
                  </div>
                {/if}
              {/each}
              {#if message.state === 'streaming' && caretAt === -1}
                <span class="caret block" aria-label={strings.chat.streaming}></span>
              {/if}
            </div>
          {/if}
        </article>
      {/each}
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
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: 18px;
    width: 100%;
    max-width: var(--content);
    margin: 0 auto;
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
    padding: 8px 12px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    border-bottom-right-radius: 4px;
  }

  .user-text {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .parts {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 100%;
  }

  .prose {
    word-break: break-word;
    line-height: 1.6;
  }

  .prose :global(p) {
    white-space: pre-wrap;
    margin: 0 0 8px;
  }

  .prose :global(p:last-child) {
    margin-bottom: 0;
  }

  .prose :global(h3),
  .prose :global(h4),
  .prose :global(h5),
  .prose :global(h6) {
    font-size: var(--text-md);
    margin: 12px 0 6px;
  }

  .prose :global(ul),
  .prose :global(ol) {
    margin: 0 0 8px;
    padding-left: 22px;
  }

  .prose :global(li) {
    margin: 2px 0;
  }

  .prose :global(code) {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
  }

  .prose :global(pre) {
    margin: 6px 0 10px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    overflow: auto;
  }

  .prose :global(pre code) {
    padding: 0;
    border: none;
    background: transparent;
    white-space: pre;
  }

  .prose :global(a) {
    text-decoration: underline;
    text-underline-offset: 2px;
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
