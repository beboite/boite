<script lang="ts">
  import { CircleAlert } from '@lucide/svelte';
  import type { Account, Message } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { formatTokens } from '../lib/tokens';
  import { promptText, visibleAnswer } from '../lib/message-display';
  import { isNamedModel } from '../lib/model-order';
  import type { TurnProgress } from '../lib/turn-progress.svelte';
  import PermissionCard from './PermissionCard.svelte';
  import QuestionCard from './QuestionCard.svelte';
  import Prose from './Prose.svelte';
  import ChatFile from './ChatFile.svelte';
  import ThinkingPart from './ThinkingPart.svelte';
  import ToolCard from './ToolCard.svelte';

  /**
   * An assistant or system message in the timeline: the model that wrote it,
   * the turn's thinking where this message hosts it, then every part it carries.
   * `signedOut` is the thread's account when it is signed out, so an error can
   * carry the way back in.
   */
  let {
    store,
    threadId,
    message,
    progress,
    signedOut
  }: {
    store: Store;
    threadId: string;
    message: Message;
    progress: TurnProgress;
    signedOut: Account | null;
  } = $props();

  function lastTextIndex(message: Message): number {
    const last = message.parts.length - 1;
    return message.parts[last]?.type === 'text' ? last : -1;
  }

  const execution = $derived(store.openThread?.turns.find((turn) => turn.id === message.turnId)?.execution);
  const caretAt = $derived(message.state === 'streaming' ? lastTextIndex(message) : -1);
  const thought = $derived(progress.thought(message.turnId));
</script>

{#if message.role === 'assistant' && execution}
  {@const model = store.modelsOf(execution.providerId, execution.accountId).find((model) => model.id === execution.model)}
  <div class="model-attribution" data-testid="message-model">
    {execution.model && isNamedModel(model ?? { id: execution.model, name: execution.model }) ? model?.name ?? execution.model : store.providerOf(execution.providerId)?.name}
  </div>
{/if}
{#if message.role === 'system'}
  <div class="system-attribution" data-testid="message-system">{strings.chat.system}</div>
{/if}
{#if thought?.host === message.id}<ThinkingPart text={thought.text} live={thought.live} />{/if}
<div class="parts">
  {#each message.parts as part, index (index)}
    {#if part.type !== 'thinking'}
    <div class="part" data-kind={part.type}>
      {#if part.type === 'text'}
        {@const shownText = message.role === 'system' ? promptText(part) : visibleAnswer(part.text)}
        {#if shownText.length > 0 || index === caretAt}
          <Prose text={shownText} live={index === caretAt} {store} {threadId} />
        {/if}

      {:else if part.type === 'file'}
        <ChatFile file={part} />
      {:else if part.type === 'tool'}
        <ToolCard
          name={part.name}
          input={part.input}
          inputText={part.inputText}
          output={part.output}
          status={part.status}
          documents={part.documents ?? []}
          startedAt={part.startedAt ?? null}
          finishedAt={part.finishedAt ?? null}
          background={store.openThread?.background?.some((task) => task.toolId === part.toolId) ?? false}
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
          async={part.async === true}
          answer={part.answer ?? null}
          pending={store.pendingQuestions.some((q) => q.id === part.questionId)}
          submit={(optionIds, text) =>
            store.answerQuestion(message.threadId, part.questionId, optionIds, text)}
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

<style>
  /* On the same 4 px rest as the parts it names. */
  .model-attribution { color: var(--color-muted-foreground); font-size: var(--text-xs); margin-bottom: 4px; padding-left: 4px; }
  .system-attribution { width: fit-content; margin-bottom: 6px; padding: 2px 7px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); color: var(--color-muted-foreground); background: var(--color-surface-2); font-size: var(--text-xs); font-weight: 600; }

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
</style>
