<script lang="ts">
  import { ArrowUp } from '@lucide/svelte';
  import type { AgentScope, QuestionRequest } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { fill, strings } from '../../lib/strings';
  import AgentSettingCard from '../AgentSettingCardLoader.svelte';
  import SettingRequestCard from '../SettingRequestCardLoader.svelte';
  import AgentAvatar from './AgentAvatar.svelte';
  import { openQuestionPage } from '../../lib/question-page';

  /**
   * The cards a persistent agent's hidden session threads wait on, drawn in its
   * conversation: nobody opens those threads, so a question or a settings card
   * asked there would stay out of sight. An agent setting card and a settings
   * card draw as they do in a thread; a plain question takes the compact look
   * of a decision the agent asked for.
   */
  let { view, scope }: { view: AgentsView; scope: AgentScope } = $props();
  const store = $derived(view.store);
  const sessions = $derived(new Map((view.snapshot?.sessions ?? [])
    .filter(s => s.threadId && s.scope.kind === scope.kind && s.scope.id === scope.id && (scope.kind !== 'agent' || s.agentId === scope.id))
    .map(s => [s.threadId, s.agentId])));
  const asked = $derived(sessions.size === 0 ? [] : store.pendingQuestions.filter(q => sessions.has(q.threadId)).sort((a, b) => a.createdAt - b.createdAt));
  /** Picks and typed answers, per question, while they are being written. */
  let picks = $state<Record<string, string[]>>({});
  let typed = $state<Record<string, string>>({});
  let sending = $state<Record<string, boolean>>({});

  const profileOf = (id: string | undefined) => view.snapshot?.profiles.find(a => a.id === id);

  async function send(question: QuestionRequest, optionIds: string[]): Promise<void> {
    const text = (typed[question.id] ?? '').trim();
    if (sending[question.id] || (optionIds.length === 0 && !text)) return;
    sending[question.id] = true;
    const sent = await store.answerQuestion(question.threadId, question.id, optionIds, text || undefined);
    if (!sent) sending[question.id] = false;
  }

  function pick(question: QuestionRequest, id: string): void {
    if (!question.multiple) { void send(question, [id]); return; }
    const now = picks[question.id] ?? [];
    picks[question.id] = now.includes(id) ? now.filter(entry => entry !== id) : [...now, id];
  }
</script>

{#each asked as question (question.id)}
  {#if question.agentSetting}
    <AgentSettingCard {store} threadId={question.threadId} questionId={question.id} text={question.text} setting={question.agentSetting} answer={null} pending
      respond={optionId => store.answerQuestion(question.threadId, question.id, [optionId])} />
  {:else if question.setting}
    <SettingRequestCard {store} text={question.text} setting={question.setting} answer={null} pending
      respond={optionId => store.answerQuestion(question.threadId, question.id, [optionId])} />
  {:else}
    {@const agentId = sessions.get(question.threadId)}
    {@const agent = profileOf(agentId)}
    {@const name = agent?.name ?? agentId ?? ''}
    {@const chosen = picks[question.id] ?? []}
    <article class="agent-ask" data-status="waiting" data-testid="agent-question" data-question={question.id}>
      <header>
        <AgentAvatar kind="profile" id={agentId ?? ''} {name} avatar={agent?.avatar} status="waiting" size={22} />
        <strong>{fill(strings.agents.asks, { name })}</strong>
      </header>
      <p class="agent-ask-question">{question.text}</p>
      <form class="agent-ask-answers" onsubmit={e => { e.preventDefault(); void send(question, chosen); }}>
        {#if question.open}
          <button type="button" class="chip" title={question.open.url} onclick={() => openQuestionPage(store, question.threadId, question.id)} data-testid="question-open">{strings.chat.questionOpenPage}</button>
        {/if}
        {#each question.options as option (option.id)}
          <button type="button" class="chip" class:on={chosen.includes(option.id)} aria-pressed={question.multiple ? chosen.includes(option.id) : undefined}
            title={option.description} disabled={sending[question.id]} onclick={() => pick(question, option.id)} data-testid="agent-question-option">{option.label}</button>
        {/each}
        {#if question.allowText || question.multiple}
          <span class="agent-ask-free">
            {#if question.allowText}<input bind:value={typed[question.id]} placeholder={strings.agents.answerPlaceholder} aria-label={strings.agents.answer} data-testid="agent-question-text" />{/if}
            <button class="primary icon" aria-label={strings.agentSettingRequest.send} title={strings.agentSettingRequest.send}
              disabled={sending[question.id] || (chosen.length === 0 && !(typed[question.id] ?? '').trim())} data-testid="agent-question-send"><ArrowUp size={14} strokeWidth={2.25} /></button>
          </span>
        {/if}
      </form>
    </article>
  {/if}
{/each}
