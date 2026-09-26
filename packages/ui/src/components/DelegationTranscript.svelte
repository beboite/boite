<script lang="ts">
  import type { Message } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import { permissionSentence } from '../lib/tool-summary';
  import Prose from './Prose.svelte';

  let { messages }: { messages: Message[] } = $props();
</script>

<div class="transcript-list" data-testid="delegation-transcript">
  {#if messages.length === 0}
    <p class="empty">{strings.delegation.noTranscript}</p>
  {:else}
    {#each messages as message (message.id)}
      <article class={message.role} data-role={message.role}>
        {#each message.parts as part, index (index)}
          {#if part.type === 'text'}
            {#if message.role === 'user'}<p class="user-text">{part.displayText ?? part.text}</p>{:else}<Prose text={part.displayText ?? part.text} />{/if}
          {:else if part.type === 'thinking'}
            <details><summary>{strings.chat.thinking}</summary><p class="thinking">{part.text}</p></details>
          {:else if part.type === 'tool'}
            <p class="tool">{part.name} · {strings.chat.toolStatus[part.status]}</p>
          {:else if part.type === 'permission'}
            <p class="card">{permissionSentence(part.toolName, undefined)}</p>
          {:else if part.type === 'question'}
            <p class="card">{part.text}</p>
          {/if}
        {/each}
        {#if message.state === 'streaming'}<span class="caret" aria-label={strings.chat.streaming}></span>{/if}
      </article>
    {/each}
  {/if}
</div>

<style>
  .transcript-list { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 18px; }
  article { min-width: 0; }
  article.user { align-self: flex-end; max-width: 82%; padding: 8px 11px; border-radius: var(--radius-lg); background: var(--color-surface-2); }
  .user-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  details { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  details summary { cursor: pointer; }
  .thinking { margin: 6px 0 0; padding-left: 8px; border-left: 2px solid var(--color-border); white-space: pre-wrap; }
  .tool, .card { margin: 5px 0 0; padding: 6px 8px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .caret { display: inline-block; width: 2px; height: 1em; margin-left: 2px; vertical-align: text-bottom; background: var(--color-foreground); animation: blink 1s steps(1) infinite; }
  .empty { margin: auto; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  @keyframes blink { 50% { opacity: 0; } }

  /* An endless loop stops under reduced motion; the static mark keeps its colour. */
  @media (prefers-reduced-motion: reduce) { .caret { animation: none; } }
  :global(html[data-motion='reduced']) .caret { animation: none; }
</style>
