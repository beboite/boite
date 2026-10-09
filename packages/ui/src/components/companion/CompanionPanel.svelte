<!--
  The companion's panel: what waits for an answer (permissions, questions) and
  the threads at work. It talks to nothing: it hands actions to its parent.
-->
<script module lang="ts">
  import type { PermissionRequest, QuestionRequest } from '@boite/contracts';

  export type PanelAction =
    | { kind: 'allow'; request: PermissionRequest }
    | { kind: 'deny'; request: PermissionRequest }
    | { kind: 'answer'; question: QuestionRequest; optionIds: string[]; text?: string }
    | { kind: 'skip'; question: QuestionRequest };
</script>

<script lang="ts">
  import type { ThreadSummary } from '@boite/contracts';
  import { count, describePermission, threadLabel } from '../../lib/companion/describe';
  import { isWorking, type MoodState } from '../../lib/companion/mood';
  import { strings } from '../../lib/strings';

  interface Props {
    threads: ThreadSummary[];
    projects: Map<string, string>;
    permissions: PermissionRequest[];
    questions: QuestionRequest[];
    mood: MoodState;
    /** The threads of the companion's own agents: their replies are in the bubble, so they are not listed with the others at work. */
    own: readonly string[];
    onact(action: PanelAction): Promise<void>;
  }

  let { threads, projects, permissions, questions, mood, own, onact }: Props = $props();

  // Its own requests stay: an action the companion wants to take waits here for Allow.
  const asks = $derived(permissions);
  const blocking = $derived(questions.filter((question) => !question.async));
  const later = $derived(questions.filter((question) => question.async));
  const working = $derived(threads.filter((thread) => isWorking(thread.status) && !own.includes(thread.id)));
  const finished = $derived(threads.filter((thread) => mood.justFinished.includes(thread.id) && !own.includes(thread.id)));
  const nothing = $derived(asks.length + blocking.length + later.length + working.length + finished.length === 0);

  let pending = $state<string[]>([]);
  let failures = $state<Record<string, string>>({});
  let drafts = $state<Record<string, string>>({});
  let picked = $state<Record<string, string[]>>({});

  async function act(id: string, action: PanelAction) {
    if (pending.includes(id)) return;
    pending = [...pending, id];
    delete failures[id];
    try {
      await onact(action);
    } catch (error) {
      failures[id] = error instanceof Error ? error.message : String(error);
    } finally {
      pending = pending.filter((entry) => entry !== id);
    }
  }

  function toggle(question: QuestionRequest, optionId: string) {
    const current = picked[question.id] ?? [];
    picked[question.id] = current.includes(optionId) ? current.filter((entry) => entry !== optionId) : [...current, optionId];
  }

  function sendText(question: QuestionRequest) {
    const text = (drafts[question.id] ?? '').trim();
    if (text) void act(question.id, { kind: 'answer', question, optionIds: [], text });
  }
</script>

{#snippet origin(threadId: string)}
  {@const label = threadLabel(threads, projects, threadId)}
  <p class="origin"><span class="title">{label.title}</span>{#if label.project}<span class="project">{label.project}</span>{/if}</p>
{/snippet}

{#snippet failure(id: string)}
  {#if failures[id]}<p class="failure" role="alert">{failures[id]}</p>{/if}
{/snippet}

{#snippet questionCard(question: QuestionRequest)}
  {@const busy = pending.includes(question.id)}
  <li class="item" class:busy>
    {@render origin(question.threadId)}
    <p class="ask">{question.text}</p>
    {#if question.async}<p class="hint">{strings.companion.asyncHint}</p>{/if}
    {#if question.options.length > 0}
      <div class="row">
        {#each question.options as option (option.id)}
          {#if question.multiple}
            <button class="small option" title={option.description} aria-pressed={(picked[question.id] ?? []).includes(option.id)} disabled={busy} onclick={() => toggle(question, option.id)}>{option.label}</button>
          {:else}
            <button class="small option" title={option.description} disabled={busy} onclick={() => act(question.id, { kind: 'answer', question, optionIds: [option.id] })}>{option.label}</button>
          {/if}
        {/each}
      </div>
    {/if}
    {#if question.allowText}
      <form class="free" onsubmit={(event) => { event.preventDefault(); sendText(question); }}>
        <input type="text" placeholder={strings.companion.answer} aria-label={strings.companion.answerLabel} disabled={busy}
          bind:value={() => drafts[question.id] ?? '', (value) => (drafts[question.id] = value)} />
        <button class="small primary" type="submit" disabled={busy || !(drafts[question.id] ?? '').trim()}>{strings.companion.send}</button>
      </form>
    {/if}
    <div class="row">
      {#if question.multiple}
        <button class="small primary" disabled={busy || (picked[question.id] ?? []).length === 0}
          onclick={() => act(question.id, { kind: 'answer', question, optionIds: picked[question.id] ?? [] })}>{strings.companion.confirm}</button>
      {/if}
      <button class="small ghost" disabled={busy} onclick={() => act(question.id, { kind: 'skip', question })}>{strings.companion.skip}</button>
    </div>
    {@render failure(question.id)}
  </li>
{/snippet}

<div class="panel" data-testid="companion-panel">
  <header>
    <h2>{strings.companion.moods[mood.mood]}</h2>
    {#if mood.blocking > 0}
      <span class="count">{count(mood.blocking, strings.companion.requestsOne, strings.companion.requestsMany)}</span>
    {:else if mood.working > 0}
      <span class="count">{count(mood.working, strings.companion.threadsOne, strings.companion.threadsMany)}</span>
    {/if}
  </header>

  <div class="scroll">
    {#if asks.length + blocking.length > 0}
      <ul class="list">
        {#each asks as request (request.id)}
          {@const said = describePermission(request)}
          {@const busy = pending.includes(request.id)}
          <li class="item" class:busy>
            {@render origin(request.threadId)}
            <p class="ask">{said.verb}{#if said.target}&nbsp;<code>{said.target}</code>{/if}</p>
            {#if request.description}<p class="hint">{request.description}</p>{/if}
            <div class="row">
              <button class="small primary" disabled={busy} onclick={() => act(request.id, { kind: 'allow', request })}>{strings.companion.allow}</button>
              <button class="small ghost" disabled={busy} onclick={() => act(request.id, { kind: 'deny', request })}>{strings.companion.deny}</button>
            </div>
            {@render failure(request.id)}
          </li>
        {/each}
        {#each blocking as question (question.id)}
          {@render questionCard(question)}
        {/each}
      </ul>
    {/if}

    {#if later.length > 0}
      <h3>{strings.companion.noRush}</h3>
      <ul class="list">
        {#each later as question (question.id)}
          {@render questionCard(question)}
        {/each}
      </ul>
    {/if}

    {#if working.length + finished.length > 0}
      <h3>{strings.companion.threads}</h3>
      <ul class="threads">
        {#each finished as thread (thread.id)}
          <li><span class="dot done"></span><span class="title">{thread.title || strings.companion.untitled}</span><span class="status">{strings.companion.status.done}</span></li>
        {/each}
        {#each working as thread (thread.id)}
          <li>
            <span class="dot {thread.status}"></span><span class="title">{thread.title || strings.companion.untitled}</span>
            <span class="status">{thread.status === 'queued' || thread.status === 'running' || thread.status === 'waiting' ? strings.companion.status[thread.status] : ''}</span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if nothing}
      <p class="none">{strings.companion.nothingWaiting}</p>
    {/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px 6px;
  }
  h2 {
    font-size: var(--text-sm);
    font-weight: 600;
  }
  h3 {
    margin: 10px 14px 4px;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--color-muted-foreground);
  }
  .count {
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .scroll {
    overflow-y: auto;
    padding-bottom: 8px;
    scrollbar-width: thin;
  }
  .list,
  .threads {
    list-style: none;
    margin: 0;
    padding: 0 8px;
  }
  .item {
    padding: 10px 6px;
    border-top: 1px solid var(--color-border);
    transition: opacity var(--dur-2) var(--ease-out-quint);
  }
  .item:first-child {
    border-top: none;
  }
  .item.busy {
    opacity: 0.55;
  }
  .origin {
    display: flex;
    gap: 6px;
    min-width: 0;
    margin-bottom: 4px;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .origin .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .origin .project {
    flex: none;
  }
  .origin .project::before {
    content: '·';
    margin-right: 6px;
  }
  .ask {
    font-size: var(--text-sm);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  code {
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .hint {
    margin-top: 4px;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .free {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .free input {
    flex: 1;
    min-width: 0;
  }
  .option[aria-pressed='true'] {
    border-color: var(--color-accent);
  }
  .failure {
    margin-top: 6px;
    font-size: var(--text-xs);
    color: var(--color-danger);
  }
  .threads li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px;
    font-size: var(--text-sm);
  }
  .threads .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .threads .status {
    flex: none;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 2px;
    background: var(--color-muted-foreground);
  }
  .dot.running {
    background: var(--color-live);
    animation: pulse 1.2s ease-in-out infinite alternate;
  }
  .dot.waiting {
    background: var(--color-accent);
  }
  .dot.done {
    background: var(--color-success);
  }
  .none {
    margin: 2px 14px 6px;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }
  @keyframes pulse {
    to {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.running {
      animation: none;
    }
  }
</style>
