<script lang="ts">
  import { Check, ChevronDown, ListTodo, Pause, Play, Repeat, Target, X } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/i18n.svelte';

  let { store }: { store: Store } = $props();
  let activity = $derived(store.openThread?.activity);
  let expanded = $state(false);
  let saving = $state(false);
  let visible = $derived(Boolean(activity?.goal && !activity.goal.dismissed || activity?.loop || activity?.tasks.length && !activity.tasksDismissed));
  // Keep completed content mounted during the fade out, without occupying chat space.
  let tasks = $derived(activity?.tasksDismissed && visible ? [] : activity?.tasks ?? []);
  let goal = $derived(activity?.goal?.dismissed && visible ? null : activity?.goal);
  let loop = $derived(activity?.loop);
  let done = $derived(tasks.filter((task) => task.status === 'completed').length);
  let current = $derived(tasks.find((task) => task.status === 'in_progress')?.text ??
    (done === tasks.length ? strings.activity.allTasksDone : strings.activity.waitingTasks));
  let history = $derived([...(loop?.history ?? [])].reverse());
  const detailsId = $props.id();

  function interval(ms: number) {
    if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
    if (ms % 60_000 === 0) return `${ms / 60_000}m`;
    return `${ms / 1000}s`;
  }

  function iteration(count: number, total?: number | null) {
    return total ? fill(strings.activity.iterationOf, { count: String(count), total: String(total) })
      : fill(strings.activity.iteration, { count: String(count) });
  }

  async function control(kind: 'goal' | 'loop', action: 'pause' | 'resume' | 'remove' | 'complete') {
    const thread = store.openThread;
    if (!thread || !store.client || saving) return;
    saving = true;
    try {
      const value = await store.client.call('threads.activity.control', { threadId: thread.id, kind, action });
      if (store.openThread?.id === thread.id) store.openThread.activity = value;
    } catch (error) {
      store.error = error instanceof Error ? error.message : String(error);
    } finally { saving = false; }
  }
</script>

{#if activity}
  <section class="activity" class:hidden={!visible} data-testid="thread-activity" aria-label={strings.activity.tasks} inert={!visible}>
    {#each ['goal', 'loop'] as kind (kind)}
      {@const entry = kind === 'goal' ? goal : loop}
      {#if entry}
        <div class="activity-row" class:finished={entry.status === 'complete'} data-testid="activity-{kind}">
          {#if kind === 'goal'}<Target size={16} />{:else}<Repeat size={16} />{/if}
          <span class="kind">{kind === 'goal' ? strings.activity.goal : strings.activity.loop}</span>
          <span class="objective" title={'objective' in entry ? entry.objective : entry.prompt}>
            {#if 'objective' in entry}{entry.objective}{:else}{iteration(entry.iterations, entry.maxIterations)}{/if}
          </span>
          <span class="meta status" class:live={entry.status === 'active'}>{strings.activity[entry.status]}</span>
          {#if entry.status !== 'complete'}
            <button type="button" class="activity-action icon" disabled={saving || store.connection !== 'ready'}
              aria-label={entry.status === 'active' ? strings.activity.pause : strings.activity.resume}
              title={entry.status === 'active' ? strings.activity.pause : strings.activity.resume}
              onclick={() => void control(kind as 'goal' | 'loop', entry.status === 'active' ? 'pause' : 'resume')}>
              {#if entry.status === 'active'}<Pause size={17} />{:else}<Play size={17} />{/if}
            </button>
          {/if}
          {#if kind === 'goal' && entry.status !== 'complete'}
            <button type="button" class="activity-action icon" disabled={saving || store.connection !== 'ready'} aria-label={strings.activity.finish} title={strings.activity.finish} onclick={() => void control('goal', 'complete')}><Check size={17} /></button>
          {/if}
          <button type="button" class="activity-action icon" disabled={saving || store.connection !== 'ready'} aria-label={strings.activity.remove} title={strings.activity.remove} onclick={() => void control(kind as 'goal' | 'loop', 'remove')}><X size={17} /></button>
        </div>
        {#if entry.error}<p class="error">{entry.error}</p>{/if}
      {/if}
    {/each}
    {#if tasks.length || loop}
      <button type="button" class="ghost tasks-toggle" aria-expanded={expanded} aria-controls={detailsId}
        data-testid="activity-tasks-toggle" onclick={() => (expanded = !expanded)}
        onkeydown={(event) => { if (event.key === 'Escape') { expanded = false; event.stopPropagation(); } }}>
        <ListTodo size={16} />
        <span class="current">{tasks.length ? current : strings.activity.history}</span>
        {#if tasks.length}<span class="count">{fill(strings.activity.taskCount, { done: String(done), total: String(tasks.length) })}</span>{/if}
        <ChevronDown size={16} class={expanded ? 'turned' : ''} />
      </button>
      {#if tasks.length}
        <progress max={tasks.length} value={done} aria-label={strings.activity.tasks}></progress>
      {/if}
      <div class="task-disclosure" class:open={expanded} inert={!expanded}>
        <div class="task-clip" id={detailsId}>
          {#if tasks.length}
            <ul data-testid="activity-tasks">
              {#each tasks as task (task.id)}
                <li class:done={task.status === 'completed'}>
                  <span class="task-mark" title={strings.activity[task.status]} aria-label={strings.activity[task.status]}>{task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '•' : '○'}</span>
                  <span>{task.text}</span>
                </li>
              {/each}
            </ul>
          {/if}
          {#if loop}
            {#if loop.intervalMs > 0}<p class="meta cadence">{fill(strings.activity.every, { interval: interval(loop.intervalMs) })}</p>{/if}
            <ol class="history" aria-label={strings.activity.history}>
              {#each history as run (run.turnId)}
                <li><div class="run-heading"><span>{iteration(run.iteration)}</span><span class="meta">{strings.activity[run.status]}</span></div>{#if run.summary}<p>{run.summary}</p>{/if}</li>
              {:else}<li class="meta">{strings.activity.noHistory}</li>{/each}
            </ol>
          {/if}
        </div>
      </div>
    {/if}
  </section>
{/if}

<style>
  .activity { position: absolute; bottom: calc(100% - 4px); inset-inline: 0; z-index: 5; width: min(calc(100% - 40px), var(--content)); margin-inline: auto; max-height: 45vh; overflow-y: auto; padding: 8px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-e1); font-size: var(--text-sm); transition: opacity var(--dur-3), transform var(--dur-3); }
  .activity.hidden { opacity: 0; transform: translateY(8px); pointer-events: none; }
  .activity-row, .tasks-toggle { display: flex; align-items: center; gap: 8px; min-height: var(--control); min-width: 0; }
  .activity-row > :global(svg) { flex: none; color: var(--color-muted-foreground); }
  .kind { font-weight: 600; color: var(--color-accent); }
  .activity-action { min-height: var(--control-lg); flex: none; gap: 6px; border-radius: var(--radius-md); }
  .activity-action.icon { width: var(--control-lg); height: var(--control-lg); }
  .status { padding: 3px 8px; border-radius: var(--radius-sm); background: var(--color-surface-2); }
  .status.live { color: var(--color-accent); }
  .finished .status { color: var(--color-success); }
  .objective, .current { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; text-align: left; }
  .meta, .count { color: var(--color-muted-foreground); font-size: var(--text-xs); flex: none; }
  .tasks-toggle { width: 100%; padding: 0; margin-top: 2px; }
  .tasks-toggle :global(svg) { flex: none; }
  .tasks-toggle :global(svg:last-child) { transition: transform var(--dur-2); }
  .tasks-toggle :global(.turned) { transform: rotate(180deg); }
  progress { display: block; appearance: none; width: 100%; height: 3px; margin-top: 5px; border: none; border-radius: var(--radius-sm); overflow: hidden; background: var(--color-surface-3); }
  progress::-webkit-progress-bar { background: var(--color-surface-3); }
  progress::-webkit-progress-value { background: var(--color-accent); transition: width var(--dur-3); }
  progress::-moz-progress-bar { background: var(--color-accent); }
  .task-disclosure { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--dur-3) var(--ease-out-quint); }
  .task-disclosure.open { grid-template-rows: 1fr; }
  .task-clip { overflow: hidden; min-height: 0; }
  ul, ol { list-style: none; margin: 0; padding: 6px 0; }
  li { display: flex; gap: 8px; padding: 5px 0; overflow-wrap: anywhere; }
  .task-mark { width: 15px; flex: none; text-align: center; }
  .done { color: var(--color-muted-foreground); }
  .done .task-mark { color: var(--color-success); }
  .history li { display: block; border-top: 1px solid var(--color-border); padding-block: 8px; }
  .run-heading { display: flex; justify-content: space-between; gap: 12px; }
  .history p { margin: 4px 0 0; white-space: pre-wrap; }
  .cadence { margin: 8px 0 0; }
  .error { color: var(--color-danger); margin: 4px 0; overflow-wrap: anywhere; }
  @media (max-width: 720px) { .activity { width: min(calc(100% - 20px), var(--content)); padding: 8px; } .activity-row { gap: 5px; } .activity-action.icon { width: var(--control-touch); height: var(--control-touch); } }
  @media (prefers-reduced-motion: reduce) { .activity, .task-disclosure, progress::-webkit-progress-value { transition: none; } }
</style>




