<script lang="ts">
  import { ChevronDown, Circle, CircleCheck, CircleDot, Plus, Repeat, Target, X } from '@lucide/svelte';
  import type { Todo } from '@boite/contracts';
  import { time } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  let draft = $state('');
  let open = $state({ activity: true, tasks: true, todos: true });

  let thread = $derived(store.openThread);
  let activity = $derived(thread?.activity ?? null);
  let tasks = $derived(activity?.tasks ?? []);
  let todos = $derived(thread ? (store.todos[thread.projectId] ?? []) : []);

  // The project's list is the same for every thread of it, so it is read once
  // when the surface shows and again whenever the thread changes project.
  $effect(() => {
    const id = thread?.id;
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
      data-testid="tasks-section-activity"
      title={open.activity ? strings.tasks.collapse : strings.tasks.expand}
      onclick={() => (open.activity = !open.activity)}
    >
      <ChevronDown size={13} strokeWidth={1.75} class={open.activity ? 'turned' : ''} />
      <span class="section-label">{strings.tasks.goalSection}</span>
    </button>
    {#if open.activity}
      <div class="body">
        {#if activity?.goal}
          <div class="line" data-testid="tasks-goal">
            <Target size={13} strokeWidth={1.75} />
            <span class="text" title={activity.goal.objective}>{activity.goal.objective}</span>
            <span class="meta">{fill(strings.tasks.iterations, { count: String(activity.goal.iterations) })}</span>
            <span class="state" class:live={activity.goal.status === 'active'}>{strings.activity[activity.goal.status]}</span>
          </div>
        {/if}
        {#if activity?.loop}
          <div class="line" data-testid="tasks-loop">
            <Repeat size={13} strokeWidth={1.75} />
            <span class="text" title={activity.loop.prompt}>{activity.loop.prompt}</span>
            {#if activity.loop.nextRunAt}
              <span class="meta">{fill(strings.tasks.nextRun, { time: time(activity.loop.nextRunAt) })}</span>
            {:else}
              <span class="meta">{fill(strings.tasks.iterations, { count: String(activity.loop.iterations) })}</span>
            {/if}
            <span class="state" class:live={activity.loop.status === 'active'}>{strings.activity[activity.loop.status]}</span>
          </div>
        {/if}
        {#if !activity?.goal && !activity?.loop}
          <p class="empty">{strings.tasks.noActivity}</p>
        {/if}
      </div>
    {/if}
  </section>

  <section>
    <button
      type="button"
      class="ghost head"
      aria-expanded={open.tasks}
      data-testid="tasks-section-agent"
      title={open.tasks ? strings.tasks.collapse : strings.tasks.expand}
      onclick={() => (open.tasks = !open.tasks)}
    >
      <ChevronDown size={13} strokeWidth={1.75} class={open.tasks ? 'turned' : ''} />
      <span class="section-label">{strings.tasks.agentSection}</span>
      {#if tasks.length > 0}
        <span class="meta">
          {fill(strings.activity.taskCount, {
            done: String(tasks.filter((task) => task.status === 'completed').length),
            total: String(tasks.length)
          })}
        </span>
      {/if}
    </button>
    {#if open.tasks}
      <div class="body">
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
            <span class="text" title={task.text}>{task.text}</span>
          </div>
        {:else}
          <p class="empty">{strings.tasks.noTasks}</p>
        {/each}
      </div>
    {/if}
  </section>

  <section>
    <button
      type="button"
      class="ghost head"
      aria-expanded={open.todos}
      data-testid="tasks-section-todos"
      title={open.todos ? strings.tasks.collapse : strings.tasks.expand}
      onclick={() => (open.todos = !open.todos)}
    >
      <ChevronDown size={13} strokeWidth={1.75} class={open.todos ? 'turned' : ''} />
      <span class="section-label">{strings.tasks.todoSection}</span>
    </button>
    {#if open.todos}
      <div class="body">
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
            class="small icon"
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
            <span class="text" title={todo.text}>{todo.text}</span>
            {#if todo.status === 'claimed'}
              <span class="await" data-testid="todo-awaiting" title={strings.tasks.awaitingHint}>{strings.tasks.awaiting}</span>
            {/if}
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
      </div>
    {/if}
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

  .head :global(svg) {
    flex: none;
    transition: transform var(--dur-2) var(--ease-out-quint);
    transform: rotate(-90deg);
  }

  .head :global(.turned) {
    transform: none;
  }

  .body {
    padding: 0 12px 8px;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: var(--control-sm);
    min-width: 0;
    padding: 2px 0;
    font-size: var(--text-xs);
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    flex: none;
    color: var(--color-muted-foreground);
    font-variant-numeric: tabular-nums;
  }

  .state {
    flex: none;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    color: var(--color-muted-foreground);
  }

  .state.live {
    color: var(--color-accent);
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
    /* Outside the text's ellipsis: the card's own name is what gets cut,
       never the words saying what the card is waiting for. */
    flex: none;
    margin-left: 6px;
    color: var(--color-live);
    white-space: nowrap;
  }

  .composer {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0 6px;
  }

  .composer input {
    flex: 1;
    min-width: 0;
    height: var(--control-sm);
    font-size: var(--text-xs);
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
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  /* A finger has no hover, so the row's actions are always there on a phone. */
  @media (hover: none) {
    .todo .ghost {
      opacity: 1;
    }
  }
</style>
