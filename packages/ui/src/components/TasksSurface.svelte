<script lang="ts">
  import { ChevronRight, Circle, CircleCheck, CircleDot, GitPullRequest, Plus, Repeat, Target, X } from '@lucide/svelte';
  import type { Todo } from '@boite/contracts';
  import { watchStatus } from '../lib/pull-request-watch';
  import InfoTip from './InfoTip.svelte';
  import GoalChecklist from './GoalChecklistLoader.svelte';
  import { time } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();
  const sectionId = $props.id();

  let draft = $state('');
  let open = $state({ activity: true, reviews: true, watches: true, tasks: true, todos: true });
  /** A long objective shows three lines until pressed, so the checklist under it stays in view. */
  let wholeObjective = $state(false);

  let thread = $derived(store.openThread);
  let activity = $derived(thread?.activity ?? null);
  let tasks = $derived(activity?.tasks ?? []);
  let watches = $derived(thread?.pullRequestWatches ?? []);
  /** A `/goal2`'s checklist, from the first list its tracker writes, as the goal bar's button that leads here. Dropped items count for nothing. */
  let checklist = $derived(activity?.goal?.checklist && (activity.goal.checklist.items.length > 0 || activity.goal.checklist.phase !== 'idle' || activity.goal.checklist.error) ? activity.goal.checklist : null);
  let listed = $derived(checklist?.items.filter((item) => item.status !== 'cancelled') ?? []);
  let ticked = $derived(listed.filter((item) => item.status === 'done').length);
  /** The section says what it holds: a goal, a loop, or both. */
  let activityLabel = $derived(activity?.goal && !activity.loop ? strings.activity.goal : activity?.loop && !activity.goal ? strings.activity.loop : strings.tasks.goalSection);
  /** A `/goal2`'s reviews, newest first, with what each reviewer found: the bar keeps only their dots. */
  let verdicts = $derived([...(activity?.goal?.review?.verdicts ?? [])].reverse());
  let todos = $derived(thread?.projectId ? (store.todos[thread.projectId] ?? []) : []);

  // The project's list is the same for every thread of it, so it is read once
  // when the surface shows and again whenever the thread changes project.
  $effect(() => {
    const id = thread?.projectId ? thread.id : null;
    if (id) void store.loadTodos(id);
  });

  async function add(): Promise<void> {
    const id = thread?.id;
    const text = draft.trim();
    if (!id || text.length === 0) return;
    draft = '';
    await store.addTodo(id, text);
  }

  function move(todo: Todo, status: Todo['status']): void {
    const id = thread?.id;
    if (!id) return;
    void store.updateTodo(id, todo.id, { status });
  }
</script>

<div class="tasks-surface" data-testid="tasks-panel">
  <section>
    <button
      type="button"
      class="ghost head"
      aria-expanded={open.activity}
      aria-controls="{sectionId}-activity"
      data-testid="tasks-section-activity"
      title={open.activity ? strings.tasks.collapse : strings.tasks.expand}
      onclick={() => (open.activity = !open.activity)}
    >
      <ChevronRight size={13} strokeWidth={1.75} class={open.activity ? 'fold-caret open' : 'fold-caret'} />
      <span class="section-label ui-label">{activityLabel}</span>
    </button>
    <div class="disclosure-fold" id="{sectionId}-activity" class:open={open.activity} inert={!open.activity}>
      <div><div class="body">
        {#if activity?.goal}
          {@const goal = activity.goal}
          <div class="entry" data-testid="tasks-goal">
            <Target size={13} strokeWidth={1.75} />
            <div class="entry-copy">
              <button type="button" class="ghost objective" aria-expanded={wholeObjective} title={wholeObjective ? undefined : goal.objective} onclick={() => (wholeObjective = !wholeObjective)}>
                <span class="clamp" class:whole={wholeObjective}>{goal.objective}</span>
              </button>
              <span class="entry-meta">
                {#if goal.status === 'paused' && goal.blocked}
                  <span class="state blocked ui-label-box" title={strings.activity.blockedHint} data-testid="tasks-goal-blocked"><span class="ui-label">{strings.activity.blocked}</span></span>
                {:else}
                  <span class="state ui-label-box" class:live={goal.status === 'active'}><span class="ui-label">{strings.activity[goal.status]}</span></span>
                {/if}
                <span class="meta ui-label">{fill(strings.tasks.iterations, { count: String(goal.iterations) })}</span>
              </span>
            </div>
          </div>
          {#if checklist}
            <!-- A `/goal2`'s checklist: the goal above, cut into what the user asked for, where the goal bar's line leads. -->
            <div class="goal-checklist" data-testid="tasks-checklist">
              {#if listed.length > 0}
                <div class="progress-row" data-testid="tasks-checklist-progress">
                  <progress max={listed.length} value={ticked} aria-hidden="true"></progress>
                  <span class="meta ui-label">{fill(strings.activity.checklistCount, { done: String(ticked), total: String(listed.length) })}</span>
                </div>
              {/if}
              <GoalChecklist {store} {checklist} dense />
            </div>
          {/if}
        {/if}
        {#if activity?.loop}
          <div class="entry" data-testid="tasks-loop">
            <Repeat size={13} strokeWidth={1.75} />
            <div class="entry-copy">
              <span class="text ui-label" title={activity.loop.prompt}>{activity.loop.prompt}</span>
              <span class="entry-meta">
                <span class="state ui-label-box" class:live={activity.loop.status === 'active'}><span class="ui-label">{strings.activity[activity.loop.status]}</span></span>
                {#if activity.loop.nextRunAt}
                  <span class="meta ui-label">{fill(strings.tasks.nextRun, { time: time(activity.loop.nextRunAt) })}</span>
                {:else}
                  <span class="meta ui-label">{fill(strings.tasks.iterations, { count: String(activity.loop.iterations) })}</span>
                {/if}
              </span>
            </div>
          </div>
        {/if}
        {#if !activity?.goal && !activity?.loop}
          <p class="empty">{strings.tasks.noActivity}</p>
        {/if}
      </div></div>
    </div>
  </section>

  {#if verdicts.length > 0}
    <section data-testid="tasks-reviews">
      <button
        type="button"
        class="ghost head"
        aria-expanded={open.reviews}
        aria-controls="{sectionId}-reviews"
        data-testid="tasks-section-reviews"
        title={open.reviews ? strings.tasks.collapse : strings.tasks.expand}
        onclick={() => (open.reviews = !open.reviews)}
      >
        <ChevronRight size={13} strokeWidth={1.75} class={open.reviews ? 'fold-caret open' : 'fold-caret'} />
        <span class="section-label ui-label">{strings.activity.reviews}</span>
      </button>
      <div class="disclosure-fold" id="{sectionId}-reviews" class:open={open.reviews} inert={!open.reviews}>
        <div><div class="body">
          {#each verdicts as verdict (verdict.threadId)}
            <div class="review" data-testid="tasks-review" data-verdict={verdict.verdict}>
              <div class="review-head">
                <span class="ui-label">{fill(strings.activity.reviewRound, { round: String(verdict.round) })}</span>
                <span class="verdict-name ui-label">{strings.activity[verdict.verdict]}</span>
                <button type="button" class="ghost small open-review" onclick={() => void store.open(verdict.threadId)}>{strings.activity.openReview}</button>
              </div>
              {#if verdict.summary}<p class="review-summary">{verdict.summary}</p>{/if}
            </div>
          {/each}
        </div></div>
      </div>
    </section>
  {/if}

  {#if watches.length > 0}
    <section>
      <div class="head-row">
        <button
          type="button"
          class="ghost head"
          aria-expanded={open.watches}
          aria-controls="{sectionId}-watches"
          data-testid="tasks-section-watches"
          title={open.watches ? strings.tasks.collapse : strings.tasks.expand}
          onclick={() => (open.watches = !open.watches)}
        >
          <ChevronRight size={13} strokeWidth={1.75} class={open.watches ? 'fold-caret open' : 'fold-caret'} />
          <span class="section-label ui-label">{strings.tasks.watchSection}</span>
        </button>
        <InfoTip text={strings.tasks.watchHint} topic={strings.tasks.watchSection} testid="watch-info" />
      </div>
      <div class="disclosure-fold" id="{sectionId}-watches" class:open={open.watches} inert={!open.watches}>
        <div><div class="body">
          {#each watches as watch (watch.url)}
            <div class="line watch" data-testid="pr-watch" data-paused={watch.paused?.reason ?? null}>
              <GitPullRequest size={13} strokeWidth={1.75} />
              <a class="number ui-label" href={watch.url} target="_blank" rel="noopener noreferrer" title={watch.url}>#{watch.number}</a>
              <span class="text meta-text ui-label" class:paused={watch.paused !== null} title={watch.paused?.message ?? watch.repository}>{watchStatus(watch)}</span>
              <button
                type="button"
                class="ghost small icon"
                title={strings.tasks.stopWatch}
                aria-label={`${strings.tasks.stopWatch} #${watch.number}`}
                data-testid="pr-watch-stop"
                onclick={() => thread && void store.unwatchPullRequest(thread.id, watch.url)}
              >
                <X size={13} strokeWidth={1.75} />
              </button>
            </div>
          {/each}
        </div></div>
      </div>
    </section>
  {/if}

  {#if tasks.length > 0}
  <section>
    <button
      type="button"
      class="ghost head"
      aria-expanded={open.tasks}
      aria-controls="{sectionId}-tasks"
      data-testid="tasks-section-agent"
      title={open.tasks ? strings.tasks.collapse : strings.tasks.expand}
      onclick={() => (open.tasks = !open.tasks)}
    >
      <ChevronRight size={13} strokeWidth={1.75} class={open.tasks ? 'fold-caret open' : 'fold-caret'} />
      <span class="section-label ui-label">{strings.tasks.agentSection}</span>
      <span class="meta ui-label">
        {fill(strings.activity.taskCount, {
          done: String(tasks.filter((task) => task.status === 'completed').length),
          total: String(tasks.length)
        })}
      </span>
    </button>
    <div class="disclosure-fold" id="{sectionId}-tasks" class:open={open.tasks} inert={!open.tasks}>
      <div><div class="body">
        {#each tasks as task (task.id)}
          <div class="line" class:muted={task.status === 'completed'} data-testid="agent-task" data-status={task.status}>
            <span class="mark" data-status={task.status} title={strings.activity[task.status]}>
              {#if task.status === 'completed'}
                <CircleCheck size={13} strokeWidth={1.75} />
              {:else if task.status === 'in_progress'}
                <CircleDot size={13} strokeWidth={1.75} />
              {:else}
                <Circle size={13} strokeWidth={1.75} />
              {/if}
            </span>
            <span class="text ui-label" title={task.text}>{task.text}</span>
          </div>
        {/each}
      </div></div>
    </div>
  </section>
  {/if}

  <section>
    <button
      type="button"
      class="ghost head"
      aria-expanded={open.todos}
      aria-controls="{sectionId}-todos"
      data-testid="tasks-section-todos"
      title={open.todos ? strings.tasks.collapse : strings.tasks.expand}
      onclick={() => (open.todos = !open.todos)}
    >
      <ChevronRight size={13} strokeWidth={1.75} class={open.todos ? 'fold-caret open' : 'fold-caret'} />
      <span class="section-label ui-label">{strings.tasks.todoSection}</span>
    </button>
    <div class="disclosure-fold" id="{sectionId}-todos" class:open={open.todos} inert={!open.todos}>
      <div><div class="body">
        <form
          class="composer"
          onsubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <input
            bind:value={draft}
            placeholder={strings.tasks.addPlaceholder}
            aria-label={strings.tasks.addPlaceholder}
            data-testid="todo-input"
          />
          <button
            type="submit"
            class="icon add"
            title={strings.tasks.add}
            aria-label={strings.tasks.add}
            data-testid="todo-add"
            disabled={draft.trim().length === 0}
          >
            <Plus size={13} strokeWidth={1.75} />
          </button>
        </form>
        {#each todos as todo (todo.id)}
          <div class="line todo" class:muted={todo.status === 'done'} data-testid="todo-row" data-status={todo.status}>
            <span class="mark" data-status={todo.status}>
              {#if todo.status === 'done'}
                <CircleCheck size={13} strokeWidth={1.75} />
              {:else if todo.status === 'claimed'}
                <CircleDot size={13} strokeWidth={1.75} />
              {:else}
                <Circle size={13} strokeWidth={1.75} />
              {/if}
            </span>
            <span class="todo-copy"><span class="text">{todo.text}</span>
            {#if todo.status === 'claimed'}
              <span class="await" data-testid="todo-awaiting" title={strings.tasks.awaitingHint}>{strings.tasks.awaiting}</span>
            {/if}
            </span>
            {#if todo.status !== 'open'}
              <button
                type="button"
                class="ghost small icon"
                title={strings.tasks.markOpen}
                aria-label={strings.tasks.markOpen}
                data-testid="todo-open"
                onclick={() => move(todo, 'open')}
              >
                <Circle size={13} strokeWidth={1.75} />
              </button>
            {/if}
            {#if todo.status === 'open'}
              <button
                type="button"
                class="ghost small icon"
                title={strings.tasks.markClaimed}
                aria-label={strings.tasks.markClaimed}
                data-testid="todo-claim"
                onclick={() => move(todo, 'claimed')}
              >
                <CircleDot size={13} strokeWidth={1.75} />
              </button>
            {/if}
            {#if todo.status !== 'done'}
              <button
                type="button"
                class="ghost small icon"
                title={strings.tasks.markDone}
                aria-label={strings.tasks.markDone}
                data-testid="todo-done"
                onclick={() => move(todo, 'done')}
              >
                <CircleCheck size={13} strokeWidth={1.75} />
              </button>
            {:else}
              <!-- A done todo keeps the Done button's place, so the row's buttons stay in their columns. -->
              <span class="slot" aria-hidden="true"></span>
            {/if}
            <button
              type="button"
              class="ghost small icon"
              title={strings.tasks.removeTodo}
              aria-label={strings.tasks.removeTodo}
              data-testid="todo-remove"
              onclick={() => thread && void store.removeTodo(thread.id, todo.id)}
            >
              <X size={13} strokeWidth={1.75} />
            </button>
          </div>
        {:else}
          <p class="empty">{strings.tasks.noTodos}</p>
        {/each}
      </div></div>
    </div>
  </section>
</div>

<style>
  .tasks-surface {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    overflow-y: auto;
    padding-bottom: 12px;
  }

  section {
    flex: none;
    min-width: 0;
  }

  /* A review: its round and verdict on one line, what the reviewer found under it. */
  .review {
    padding: 6px 0;
    font-size: var(--text-sm);
  }

  .review + .review {
    border-top: 1px solid var(--color-border);
  }

  .review-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: var(--control-sm);
  }

  .verdict-name {
    flex: 1;
    font-weight: 600;
    color: var(--verdict, var(--color-muted-foreground));
  }

  [data-verdict='pass'] { --verdict: var(--color-success); }
  [data-verdict='partial'] { --verdict: var(--color-live); }
  [data-verdict='fail'], [data-verdict='missing'] { --verdict: var(--color-danger); }

  .open-review {
    flex: none;
    padding-inline: 6px;
    color: var(--color-accent);
  }

  .review-summary {
    margin: 4px 0 0;
    color: var(--color-muted-foreground);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }


  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: var(--row);
    padding: 0 12px;
    border-radius: 0;
    justify-content: flex-start;
  }

  .head-row {
    display: flex;
    align-items: center;
    padding-right: 12px;
  }

  .head-row .head {
    flex: 1;
    min-width: 0;
  }

  .number {
    flex: none;
    color: var(--color-foreground);
    font-variant-numeric: tabular-nums;
    text-decoration: none;
  }

  .number:hover {
    text-decoration: underline;
  }

  .meta-text {
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .meta-text.paused {
    color: var(--color-live);
  }

  .watch + .watch { border-top: 1px solid var(--color-border); }

  .head :global(.fold-caret) {
    color: inherit;
  }

  .body {
    padding: 0 12px 8px;
  }

  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: var(--row);
    min-width: 0;
    padding: 8px 0;
    flex-wrap: wrap;
    font-size: var(--text-sm);
    color: var(--color-foreground);
  }

  .line > :global(svg) {
    flex: none;
    color: var(--color-muted-foreground);
  }

  .line.muted .text {
    color: var(--color-muted-foreground);
    text-decoration: line-through;
  }

  .text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* A goal or a loop: its icon, then its words over one line of state. */
  .entry {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 0;
    font-size: var(--text-sm);
    color: var(--color-foreground);
  }

  .entry > :global(svg) {
    flex: none;
    height: 1.45em;
    color: var(--color-muted-foreground);
  }

  .entry-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
    line-height: 1.45;
  }

  .objective {
    display: block;
    width: 100%;
    height: auto;
    min-height: 0;
    padding: 0;
    border-radius: var(--radius-sm);
    font-weight: 400;
    color: inherit;
    text-align: left;
    line-height: inherit;
    white-space: normal;
  }

  .objective:active:not(:disabled) { transform: none; }

  .clamp {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  .clamp.whole {
    display: block;
  }

  .entry-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  /* The checklist under its goal: how far it got, in the goal bar's colours, then each request. */
  .goal-checklist {
    padding: 2px 0 2px;
  }

  .progress-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 20px;
  }

  progress {
    flex: 1;
    min-width: 0;
    appearance: none;
    height: 4px;
    border: none;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--color-surface-3);
  }

  progress::-webkit-progress-bar { background: var(--color-surface-3); }
  progress::-webkit-progress-value { background: var(--color-accent); transition: width var(--dur-3); }
  progress::-moz-progress-bar { background: var(--color-accent); }

  @media (prefers-reduced-motion: reduce) { progress::-webkit-progress-value { transition: none; } }

  .meta {
    font-size: var(--text-xs);
    flex: none;
    color: var(--color-muted-foreground);
    font-variant-numeric: tabular-nums;
  }

  .state {
    font-size: var(--text-xs);
    flex: none;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    color: var(--color-muted-foreground);
  }

  .state.live {
    color: var(--color-accent);
  }

  .state.blocked {
    color: var(--color-live);
    background: color-mix(in srgb, var(--color-live) 16%, transparent);
    font-weight: 600;
  }

  .mark {
    display: inline-flex;
    flex: none;
    color: var(--color-muted-foreground);
  }

  .mark[data-status='completed'],
  .mark[data-status='done'] {
    color: var(--color-success);
  }

  .mark[data-status='in_progress'],
  .mark[data-status='claimed'] {
    color: var(--color-live);
  }

  /* The wording a claimed card carries: the agent finished it, the user has not
     said so yet, and the row has to read as waiting rather than as done. */
  .await {
    /* Keep the pending status below the title, clear of the action buttons. */
    flex: none;
    display: block;
    margin-top: 3px;
    font-size: var(--text-xs);
    color: var(--color-live);
    white-space: nowrap;
  }

  .todo-copy { flex: 1; min-width: 0; }
  .todo + .todo { border-top: 1px solid var(--color-border); }
  .head:active:not(:disabled) { transform: none; }
  section + section { border-top: 1px solid var(--color-border); padding-top: 4px; }

  .composer {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0 6px;
  }

  .composer input {
    flex: 1;
    min-width: 0;
    height: var(--input);
    font-size: var(--text-sm);
  }

  /* As tall as its field: the small button looked disabled beside it. */
  .composer .add {
    flex: none;
    width: var(--input);
    height: var(--input);
  }

  .slot {
    flex: none;
    width: var(--control-sm);
  }

  .todo .ghost {
    opacity: 0;
    transition: opacity var(--dur-2) var(--ease-out-quint);
  }

  .todo:hover .ghost,
  .todo:focus-within .ghost {
    opacity: 1;
  }

  .empty {
    margin: 0;
    padding: 4px 0;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }

  /* A finger has no hover, so the row's actions are always there on a phone. */
  @media (hover: none), (max-width: 720px) {
    .todo .ghost {
      opacity: 1;
    }
  }

  @media (max-width: 720px) {
    .composer input { font-size: var(--text-md); }
  }
</style>
