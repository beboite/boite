<script lang="ts">
  import type { Message } from '@boite/contracts';
  import { time } from '../lib/format';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import PermissionCard from './PermissionCard.svelte';
  import ToolCard from './ToolCard.svelte';

  let {
    store,
    threadId,
    messages
  }: { store: Store; threadId: string; messages: Message[] } = $props();

  const roleLabels = {
    user: strings.chat.you,
    assistant: strings.chat.assistant,
    system: strings.chat.system
  };

  let viewport = $state<HTMLDivElement | undefined>(undefined);
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

  $effect(() => {
    growth(messages);
    const box = viewport;
    if (!box) return;
    const opened = shown !== threadId;
    shown = threadId;
    if (opened || box.scrollHeight - box.scrollTop - box.clientHeight < 240) {
      box.scrollTop = box.scrollHeight;
    }
  });
</script>

<div class="timeline" bind:this={viewport} data-testid="timeline">
  {#if messages.length === 0}
    <p class="empty">{strings.thread.empty}</p>
  {/if}

  {#each messages as message (message.id)}
    <article class="message {message.role}" data-testid="message" data-role={message.role}>
      <div class="meta">
        <span>{roleLabels[message.role]}</span>
        <span class="mono">{time(message.createdAt)}</span>
        {#if message.state === 'streaming'}
          <span class="streaming">{strings.chat.streaming}</span>
        {/if}
      </div>

      <div class="bubble">
        {#each message.parts as part, index (index)}
          {#if part.type === 'text'}
            {#if part.text.length > 0}
              <p class="text" data-testid="text-part">{part.text}</p>
            {/if}
          {:else if part.type === 'tool'}
            <ToolCard
              name={part.name}
              input={part.input}
              output={part.output}
              status={part.status}
            />
          {:else if part.type === 'permission'}
            <PermissionCard
              toolName={part.toolName}
              decision={part.decision}
              request={store.permissionRequests[part.requestId] ?? null}
              answer={(decision) => void store.answer(part.requestId, decision)}
            />
          {:else}
            <p class="error">{strings.errors.prefix}: {part.message}</p>
          {/if}
        {/each}
      </div>
    </article>
  {/each}
</div>

<style>
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 16px;
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .message {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: min(760px, 88%);
  }

  .message.user {
    align-self: flex-end;
    align-items: flex-end;
  }

  .meta {
    display: flex;
    gap: 6px;
    font-size: 10px;
    color: var(--muted);
  }

  .streaming {
    color: var(--accent);
  }

  .bubble {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bubble-agent);
    padding: 6px 9px;
    width: 100%;
  }

  .message.user .bubble {
    background: var(--bubble-user);
  }

  .text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .text:not(:last-child) {
    margin-bottom: 4px;
  }

  .error {
    margin: 4px 0 0;
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    padding: 4px 6px;
    white-space: pre-wrap;
  }
</style>
