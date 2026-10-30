<script lang="ts">
  import { Activity, Bot, FishingHook, MessageCircleQuestionMark, Settings2 } from '@lucide/svelte';
  import { showDockedQuestion } from '../lib/question-dock.svelte';
  import { replyOf, repliesOf, sendAnswer, writeAnswer } from '../lib/question-reply.svelte';
  import type { Account, MemoryEvent, Message } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { count, formatTokens, providerName } from '../lib/format';
  import { isNamedModel } from '../lib/model-order';
  import { planOf } from '../lib/plan';
  import PlanCard from './PlanCard.svelte';
  import Deferred, { parts } from './Deferred.svelte';
  import { openQuestionPage } from '../lib/question-page';
  import SettingRequestCard from './SettingRequestCardLoader.svelte';
  import AgentSettingCard from './AgentSettingCardLoader.svelte';
  import Prose from './Prose.svelte';
  import ChatFile from './ChatFile.svelte';
  import InlineView from './InlineView.svelte';
  import ToolGroup from './ToolGroup.svelte';
  import { activityShown, runKey, type ActivityPart } from '../lib/tool-groups';
  import { MessageRuns } from '../lib/memory-timeline';
  import { chatPrefs } from '../lib/chat-prefs.svelte';
  import { shownText as shownTextOf } from '../lib/timeline-rows';
  import MemoryRow from './MemoryRow.svelte';
  import KeepaliveMarker from './KeepaliveMarker.svelte';
  import ErrorCard from './ErrorCard.svelte';
  import WindowCard from './WindowCardLoader.svelte';
  import { keepaliveRun } from '../lib/message-order';
  import { AgentsView, agentOfThread } from '../lib/agents.svelte';

  /**
   * An assistant or system message in the timeline: the model that wrote it,
   * then every part it carries, its calls and reasoning folded into activity runs.
   * `signedOut` is the thread's account when it is signed out, so an error can
   * carry the way back in. `from` and `to` name the parts to draw when the
   * timeline cut a long message in several rows (lib/timeline-rows.ts).
   * `views` are the pages its turn published, for its answer to place.
   */
  let {
    store,
    threadId,
    message,
    from = 0,
    to,
    signedOut,
    showModel,
    latestInTurn = true,
    memoryEvents = [],
    views
  }: {
    store: Store;
    threadId: string;
    message: Message;
    from?: number;
    to?: number;
    signedOut: Account | null;
    showModel: boolean;
    latestInTurn?: boolean;
    memoryEvents?: MemoryEvent[];
    views?: readonly Message[];
  } = $props();

  function lastTextIndex(message: Message): number {
    return message.parts.findLastIndex(part => part.type === 'text');
  }

  const execution = $derived(store.openThread?.turns.find((turn) => turn.id === message.turnId)?.execution);
  /** The persistent agent whose own thread this is: its answers carry its name. */
  const agentName = $derived(store.openThread?.id === threadId && store.openThread.agentSessionId ? agentOfThread(AgentsView.of(store).snapshot, threadId)?.name ?? null : null);
  /** Boite's ping of the prompt cache: one line in place of its message (`quietKeepalives`). */
  const ping = $derived(execution?.operation === 'keepalive' ? store.openThread?.turns.find((turn) => turn.id === message.turnId) : undefined);
  const compacting = $derived(execution?.operation === 'compact' ||
    store.openThread?.progress?.turnId === message.turnId && store.openThread.progress.phase === 'compacting');
  const caretAt = $derived(message.state === 'streaming' ? lastTextIndex(message) : -1);
  const end = $derived(to ?? message.parts.length);
  // A run over the same parts stays the same object, so a new part does not redraw the groups above it.
  const runList = new MessageRuns();
  const runs = $derived(ping ? [] : runList.build(message.parts, memoryEvents, from, end, chatPrefs.groupChanges));
  const toolRunning = $derived(message.parts.some(part => part.type === 'tool' && part.status === 'running') ||
    latestInTurn && store.openThread?.messages.some(current => current.turnId === message.turnId && current.role === 'assistant' && current.parts.some(part => part.type === 'tool' && part.status === 'running')));
  const isBackground = (toolId: string) => store.openThread?.background?.some((task) => task.toolId === toolId) ?? false;
  // A proposed plan is read from its call's input: a page that cut it is completed at once.
  $effect(() => {
    for (let at = from; at < end; at += 1) {
      const part = message.parts[at];
      if (part?.type === 'tool' && part.inputDeferred && part.name === 'ExitPlanMode') void store.loadToolOutput(threadId, message.id, part.toolId).catch(() => {});
    }
  });
</script>

{#if showModel && message.role === 'assistant' && execution}
  {@const model = store.modelsOf(execution.providerId, execution.accountId).find((model) => model.id === execution.model)}
  {@const engine = execution.model && isNamedModel(model ?? { id: execution.model, name: execution.model }) ? model?.name ?? execution.model : providerName(store, execution.providerId)}
  <!-- A persistent agent's answers are signed with its name; the model it ran on is the tooltip. -->
  <div class="model-attribution" data-testid="message-model" title={agentName ? engine : undefined}>{agentName ?? engine}</div>
{/if}
{#if ping}
  {#if from === 0}<KeepaliveMarker turn={ping} count={keepaliveRun(store.openThread?.turns ?? [], ping.id)} />{/if}
{/if}
<div class="parts">
  {#each runs as run (run.kind === 'memory' ? run.key : runKey(run))}
    {#if run.kind === 'memory'}
      <MemoryRow event={run.events[0]!} events={run.events} onconfigure={store.owner ? () => store.showSettings('resources', 'limits') : undefined} />
    {:else if run.kind === 'activity'}
      {@const activity = run.indices.map((at) => message.parts[at]).filter((part): part is ActivityPart => part?.type === 'tool' || part?.type === 'thinking' || part?.type === 'permission')}
      {@const lastAt = run.indices.at(-1) ?? -1}
      {@const tail = message.parts[lastAt]}
      {@const thinkingLive = message.state === 'streaming' && lastAt === message.parts.length - 1 && tail?.type === 'thinking' && tail.finishedAt == null}
      {#if activityShown(activity, thinkingLive)}
      <div class="part" data-kind={activity.every((part) => part.type === 'thinking') ? 'thinking' : 'tool'}>
        <ToolGroup parts={activity} {thinkingLive} {isBackground} {store} {threadId}
          loadOutput={toolId => store.loadToolOutput(threadId, message.id, toolId)}
          permissionRequest={requestId => store.permissionRequests[requestId] ?? null}
          answerPermission={(requestId, decision) => store.answer(requestId, decision)} />
      </div>
      {/if}
    {:else if message.parts[run.index]}
    {@const index = run.index}
    {@const part = message.parts[run.index]!}
    {@const shownText = part.type === 'text' ? shownTextOf(message, part) : ''}
    {#if part.type !== 'text' || shownText.trim().length > 0}
    <div class="part" data-kind={part.type}>
      {#if part.type === 'text'}
        {#if message.role === 'system'}
          <div class="system-event" data-testid="message-system" role="note" aria-label={strings.chat.system}>
            <Activity size={14} strokeWidth={1.75} aria-hidden="true" />
            <div class="system-copy"><Prose text={shownText} {store} {threadId} /></div>
          </div>
        {:else}
        <Prose text={shownText} live={index === caretAt && part.complete !== true} bubble={message.role === 'assistant'}
          typing={!compacting && latestInTurn && !toolRunning && message.role === 'assistant' && store.connection === 'ready' && store.openThread?.status === 'running' && index === message.parts.length - 1 && index === caretAt && part.complete !== true} {store} {threadId}
          views={message.role === 'assistant' ? views : undefined} />
        {/if}
        {#if part.omitted}<p class="omitted" data-testid="text-omitted">{fill(strings.chat.textOmitted, { count: count(part.omitted) })}</p>{/if}

      {:else if part.type === 'artifact' && part.view}
        <InlineView {part} {store} {threadId} messageId={message.id} partIndex={index} />
      {:else if part.type === 'file' || part.type === 'artifact'}
        <ChatFile file={part} {store} {threadId} messageId={message.id} partIndex={index} />
      {:else if part.type === 'tool' && planOf(part.name, part.input) !== null}
        <PlanCard {store} {threadId} plan={planOf(part.name, part.input) ?? ''} />
      {:else if part.type === 'question' && part.async === true && (part.answer ?? null) === null && store.pendingQuestions.some((q) => q.id === part.questionId)}
        <!-- Waiting in the dock above the composer: here only a line that brings it up. -->
        <button type="button" class="ghost docked-question" data-testid="question-docked" title={strings.chat.questionOpen} onclick={() => showDockedQuestion(part.questionId)}>
          {#if part.setting}<Settings2 size={15} strokeWidth={1.75} />{:else if part.agentSetting}<Bot size={15} strokeWidth={1.75} />{:else}<MessageCircleQuestionMark size={15} strokeWidth={1.75} />{/if}
          <span class="docked-text ui-label">{part.text}</span>
          <span class="docked-hint ui-label">{strings.chat.questionDocked}</span>
        </button>
      {:else if part.type === 'question' && part.agentSetting}
        <AgentSettingCard
          {store}
          threadId={message.threadId}
          questionId={part.questionId}
          text={part.text}
          setting={part.agentSetting}
          answer={part.answer ?? null}
          pending={store.pendingQuestions.some((q) => q.id === part.questionId)}
          respond={(optionId) => store.answerQuestion(message.threadId, part.questionId, [optionId])}
        />
      {:else if part.type === 'question' && part.setting}
        <SettingRequestCard
          {store}
          text={part.text}
          setting={part.setting}
          answer={part.answer ?? null}
          pending={store.pendingQuestions.some((q) => q.id === part.questionId)}
          respond={(optionId) => store.answerQuestion(message.threadId, part.questionId, [optionId])}
        />
      {:else if part.type === 'question'}
        {@const asked = store.pendingQuestions.find((q) => q.id === part.questionId)}
        {@const reply = replyOf(store, part.questionId)}
        <Deferred part={parts.QuestionCard}>{#snippet children(QuestionCard)}<QuestionCard
          text={part.text}
          options={part.options}
          allowText={part.allowText}
          multiple={part.multiple}
          async={part.async === true}
          answer={part.answer ?? null}
          pending={asked !== undefined}
          bind:picked={() => repliesOf(store).picks[part.questionId] ?? [], (ids) => (repliesOf(store).picks[part.questionId] = ids)}
          replying={reply.replying}
          drafted={reply.drafted}
          submit={() => asked !== undefined && sendAnswer(store, asked)}
          skip={() => store.skipQuestion(message.threadId, part.questionId)}
          onwrite={() => writeAnswer(store, part.questionId)}
          page={part.open?.url}
          onopen={() => openQuestionPage(store, message.threadId, part.questionId)}
        />{/snippet}</Deferred>
      {:else if part.type === 'secret_request'}
        <Deferred part={parts.SecretCard}>{#snippet children(SecretCard)}<SecretCard {store} threadId={message.threadId} {part} />{/snippet}</Deferred>
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
            {#if part.background}({strings.chat.compactionBackground}){/if}
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
      {:else if part.type === 'window_capture'}
        <WindowCard {part} />
      {:else if part.type === 'window_consent'}
        <WindowCard {store} threadId={message.threadId} agent={agentName ?? (execution ? providerName(store, execution.providerId) : strings.windows.consent.anAgent)} {part} />
      {:else if part.type === 'error'}
        {@const account = store.owner ? signedOut : null}
        <ErrorCard message={part.message} reconnect={account ? () => store.openConnect(account.providerId, account.id) : undefined} />
      {/if}
    </div>
    {/if}
    {/if}
  {/each}
</div>

<style>
  /* On the same 4 px rest as the parts it names. */
  .model-attribution { color: var(--color-muted-foreground); font-size: var(--text-xs); margin-bottom: 8px; padding-left: var(--activity-padding); opacity: 0; transition: opacity var(--dur-2); }
  /* Read on demand, as a message's time and buttons are. */
  :global(.message:hover) .model-attribution, :global(.message:focus-within) .model-attribution { opacity: 1; }
  @media (hover: none) { .model-attribution { opacity: 1; } }
  .system-event { display: flex; align-items: flex-start; gap: 8px; color: var(--color-muted-foreground); }
  .system-event > :global(svg) { flex: none; margin-top: 3px; color: var(--color-subtle); }
  .system-copy { min-width: 0; }
  .system-copy :global(.prose) { font-size: var(--text-sm); line-height: 1.6; }

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

  /* One that places pages gives each its column and keeps the measure on its text (Prose). */
  .part[data-kind='text']:has(> :global(.flow)) {
    max-width: none;
  }


  .omitted { margin-top: 4px; font-size: var(--text-xs); color: var(--color-muted-foreground); }

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
