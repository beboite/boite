<script lang="ts">
  import { CircleAlert, FishingHook, MessageCircleQuestionMark } from '@lucide/svelte';
  import { showDockedQuestion } from '../lib/question-dock.svelte';
  import type { Account, MemoryEvent, Message } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { formatTokens } from '../lib/tokens';
  import { promptText, visibleAnswer } from '../lib/message-display';
  import { isNamedModel } from '../lib/model-order';
  import type { TurnProgress } from '../lib/turn-progress.svelte';
  import { planOf } from '../lib/plan';
  import PermissionCard from './PermissionCard.svelte';
  import PlanCard from './PlanCard.svelte';
  import QuestionCard from './QuestionCard.svelte';
  import Prose from './Prose.svelte';
  import ChatFile from './ChatFile.svelte';
  import ThinkingPart from './ThinkingPart.svelte';
  import ToolGroup from './ToolGroup.svelte';
  import { runKey, type ToolPart } from '../lib/tool-groups';
  import { memoryPartRuns } from '../lib/memory-timeline';
  import MemoryRow from './MemoryRow.svelte';

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
    signedOut,
    showModel,
    memoryEvents = []
  }: {
    store: Store;
    threadId: string;
    message: Message;
    progress: TurnProgress;
    signedOut: Account | null;
    showModel: boolean;
    memoryEvents?: MemoryEvent[];
  } = $props();

  function lastTextIndex(message: Message): number {
    return message.parts.findLastIndex(part => part.type === 'text');
  }

  const execution = $derived(store.openThread?.turns.find((turn) => turn.id === message.turnId)?.execution);
  const caretAt = $derived(message.state === 'streaming' ? lastTextIndex(message) : -1);
  const thought = $derived(progress.thought(message.turnId));
  const runs = $derived(memoryPartRuns(message.parts, memoryEvents));
  const isBackground = (toolId: string) => store.openThread?.background?.some((task) => task.toolId === toolId) ?? false;
</script>

{#if showModel && message.role === 'assistant' && execution}
  {@const model = store.modelsOf(execution.providerId, execution.accountId).find((model) => model.id === execution.model)}
  <div class="model-attribution" data-testid="message-model">
    {execution.model && isNamedModel(model ?? { id: execution.model, name: execution.model }) ? model?.name ?? execution.model : store.providerOf(execution.providerId)?.name}
  </div>
{/if}
{#if message.role === 'system'}
  <div class="system-attribution" data-testid="message-system">{strings.chat.system}</div>
{/if}
{#if thought?.host === message.id && (thought.live || thought.text.trim().length > 0)}<ThinkingPart text={thought.text} live={thought.live} />{/if}
<div class="parts">
  {#each runs as run (run.kind === 'memory' ? run.key : runKey(run))}
    {#if run.kind === 'memory'}
      <MemoryRow event={run.events[0]!} events={run.events} onconfigure={store.owner ? () => store.showSettings('resources', 'limits') : undefined} />
    {:else if run.kind === 'tools'}
      <div class="part" data-kind="tool">
        <ToolGroup parts={run.indices.map((at) => message.parts[at]).filter((part): part is ToolPart => part?.type === 'tool')} {isBackground} />
      </div>
    {:else if message.parts[run.index]}
    {@const index = run.index}
    {@const part = message.parts[run.index]!}
    <div class="part" data-kind={part.type}>
      {#if part.type === 'text'}
        {@const shownText = message.role === 'system' ? promptText(part) : visibleAnswer(part.text)}
        {#if shownText.length > 0 || index === caretAt}
          <Prose text={shownText} live={index === caretAt && part.complete !== true} {store} {threadId} />
        {/if}

      {:else if part.type === 'file'}
        <ChatFile file={part} />
      {:else if part.type === 'tool' && planOf(part.name, part.input) !== null}
        <PlanCard {store} {threadId} plan={planOf(part.name, part.input) ?? ''} />
      {:else if part.type === 'permission'}
        <PermissionCard
          toolName={part.toolName}
          decision={part.decision}
          request={store.permissionRequests[part.requestId] ?? null}
          answer={(decision) => void store.answer(part.requestId, decision)}
        />
      {:else if part.type === 'question' && part.async === true && (part.answer ?? null) === null && store.pendingQuestions.some((q) => q.id === part.questionId)}
        <!-- Waiting in the dock above the composer: here only a line that brings it up. -->
        <button type="button" class="ghost docked-question" data-testid="question-docked" title={strings.chat.questionOpen} onclick={() => showDockedQuestion(part.questionId)}>
          <MessageCircleQuestionMark size={15} strokeWidth={1.75} />
          <span class="docked-text">{part.text}</span>
          <span class="docked-hint">{strings.chat.questionDocked}</span>
        </button>
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
          skip={() => store.skipQuestion(message.threadId, part.questionId)}
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
      {:else if part.type === 'hook'}
        <!-- The user's own hook ended the turn: a line of the timeline, not an error. -->
        {@const label = part.outcome === 'blocked' ? strings.chat.hookBlocked : strings.chat.hookStopped}
        <p class="hook" data-testid="hook-part" data-outcome={part.outcome}>
          <FishingHook size={14} strokeWidth={1.75} />
          <span class="text">{part.message.trim() ? fill(strings.chat.hookSays, { label, message: part.message.trim() }) : label}</span>
          <span class="event">{part.event}</span>
        </p>
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
  .model-attribution { color: var(--color-muted-foreground); font-size: var(--text-xs); margin-bottom: 8px; padding-left: var(--activity-padding); }
  .system-attribution { width: fit-content; margin-bottom: 6px; padding: 2px 7px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); color: var(--color-muted-foreground); background: var(--color-surface-2); font-size: var(--text-xs); font-weight: 600; }

  /* A 4 px rest on the left so an answer does not kiss the column's edge. */
  .parts {
    display: flex;
    flex-direction: column;
    gap: var(--chat-part-gap);
    padding-left: var(--activity-padding);
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
  .part + .part[data-kind='error'],
  .part + .part[data-kind='hook'] {
    margin-top: calc(var(--chat-block-gap) - var(--chat-part-gap));
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

  /* A question waiting in the dock: one line like a tool call, the live colour on its mark. */
  .docked-question { display: flex; align-items: center; gap: var(--activity-gap); width: 100%; min-height: var(--control); height: auto; padding: var(--activity-padding); border-radius: var(--radius-sm); font-size: var(--text-sm); color: var(--color-muted-foreground); justify-content: flex-start; text-align: left; }
  .docked-question:hover:not(:disabled) { background: var(--color-surface-2); color: var(--color-foreground); }
  .docked-question :global(svg) { flex: none; width: var(--activity-glyph); color: var(--color-live); }
  .docked-text { flex: 0 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--color-foreground); }
  .docked-hint { flex: 0 10 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--text-xs); color: var(--color-subtle); }

  /* One muted line, the words wrapping under their own start, the event name last and quieter. */
  .hook {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 2px 8px;
    margin: 0;
    padding: 2px 0;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--color-muted-foreground);
  }

  .hook :global(svg) {
    flex: none;
    align-self: flex-start;
    margin-top: 3px;
  }

  .hook .text {
    flex: 1 1 16em;
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .hook .event {
    flex: none;
    font-size: var(--text-xs);
    color: var(--color-subtle);
  }
</style>
