<script lang="ts">
  import { Check, ChevronDown, ListTodo, Pause, Play, Repeat, Target, X } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';

  let { store }: { store: Store } = $props();
  let activity = $derived(store.openThread?.activity);
  let expanded = $state(false);
  let hover = $state(false);
  let saving = $state(false);
  let show = $derived(expanded || hover);
  let tasks = $derived(activity?.tasks ?? []);
  let done = $derived(tasks.filter((task) => task.status === 'completed').length);

  function interval(ms: number) {
    if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
    if (ms % 60_000 === 0) return `${ms / 60_000}m`;
    return `${ms / 1000}s`;
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

{#if activity && (activity.goal || activity.loop || tasks.length)}
  <section class="activity" data-testid="thread-activity" aria-label={strings.activity.tasks}
    onpointerenter={() => (hover = true)} onpointerleave={() => (hover = false)}>
    {#each ['goal', 'loop'] as kind (kind)}
      {@const entry = kind === 'goal' ? activity.goal : activity.loop}
      {#if entry}
        <div class="activity-row" class:finished={entry.status === 'complete'} data-testid="activity-{kind}">
          {#if kind === 'goal'}<Target size={15} />{:else}<Repeat size={15} />{/if}
          <span class="kind">{kind === 'goal' ? strings.activity.goal : strings.activity.loop}</span>
          <button type="button" class="ghost objective" aria-expanded={show} onclick={() => (expanded = !expanded)} title={'objective' in entry ? entry.objective : entry.prompt}>{'objective' in entry ? entry.objective : entry.prompt}</button>
          <span class="meta status" class:live={entry.status === 'active'}>{strings.activity[entry.status]}</span>
          {#if 'intervalMs' in entry}<span class="meta interval">{fill(strings.activity.every, { interval: interval(entry.intervalMs) })}</span>{/if}
          <div class="actions">
          <button type="button" class="activity-action toggle" disabled={saving || store.connection !== 'ready'}
            aria-label={entry.status === 'active' ? strings.activity.pause : strings.activity.resume}
            title={entry.status === 'active' ? strings.activity.pause : strings.activity.resume}
            onclick={() => void control(kind as 'goal' | 'loop', entry.status === 'active' ? 'pause' : 'resume')}>
            {#if entry.status === 'active'}<Pause size={16} />{:else}<Play size={16} />{/if}
            <span>{entry.status === 'active' ? strings.activity.pause : strings.activity.resume}</span>
          </button>
          {#if kind === 'goal' && entry.status !== 'complete'}
            <button type="button" class="activity-action icon" disabled={saving || store.connection !== 'ready'} aria-label={strings.activity.finish} title={strings.activity.finish} onclick={() => void control('goal', 'complete')}><Check size={16} /></button>
          {/if}
          <button type="button" class="activity-action icon" disabled={saving || store.connection !== 'ready'} aria-label={strings.activity.remove} title={strings.activity.remove} onclick={() => void control(kind as 'goal' | 'loop', 'remove')}><X size={16} /></button>
          </div>
        </div>
        <div class="task-disclosure" class:open={show} inert={!show}>
          <div class="task-clip">
            <p class="description">{'objective' in entry ? entry.objective : entry.prompt}</p>
            <p class="meta">{fill(strings.activity.iterations, { count: String(entry.iterations) })}{#if 'intervalMs' in entry} · {fill(strings.activity.every, { interval: interval(entry.intervalMs) })}{/if}</p>
          </div>
        </div>
        {#if entry.error}<p class="error">{entry.error}</p>{/if}
      {/if}
    {/each}
    {#if tasks.length}
      <button type="button" class="ghost tasks-toggle" aria-expanded={show} aria-controls="activity-tasks"
        data-testid="activity-tasks-toggle" onclick={() => (expanded = !expanded)}
        onkeydown={(event) => { if (event.key === 'Escape') { expanded = false; hover = false; event.stopPropagation(); } }}>
        <ListTodo size={15} />
        <span>{fill(strings.activity.taskCount, { done: String(done), total: String(tasks.length) })}</span>
        <span class="current">{tasks.find((task) => task.status === 'in_progress')?.text ?? ''}</span>
        <ChevronDown size={13} class={show ? 'turned' : ''} />
      </button>
      <div class="task-disclosure" class:open={show} inert={!show}>
        <div class="task-clip">
          <ul id="activity-tasks" data-testid="activity-tasks">
            {#each tasks as task (task.id)}
              <li class:done={task.status === 'completed'}>
                <span class="task-mark" title={strings.activity[task.status]} aria-label={strings.activity[task.status]}>{task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '•' : '○'}</span>
                <span>{task.text}</span>
              </li>
            {/each}
          </ul>
        </div>
      </div>
    {/if}
  </section>
{/if}

<style>
  .activity { width: 100%; max-width: var(--content); max-height: 45vh; overflow-y: auto; margin: 0 auto 8px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-e1); font-size: var(--text-sm); }
  .activity-row, .tasks-toggle { display: flex; align-items: center; gap: 8px; min-height: var(--control); min-width: 0; }
  .activity-row > :global(svg) { flex: none; color: var(--color-muted-foreground); }
  .kind { font-weight: 600; color: var(--color-accent); }
  .actions { display: flex; gap: 6px; flex: none; }
  .activity-action { min-height: var(--control-lg); flex: none; gap: 6px; border-radius: var(--radius-md); }
  .activity-action.icon { width: var(--control-lg); height: var(--control-lg); }
  .toggle { color: var(--color-accent); background: var(--color-accent-soft); border-color: transparent; }
  .status { padding: 3px 8px; border-radius: var(--radius-sm); background: var(--color-surface-2); }
  .status.live { color: var(--color-accent); }
  .finished .status { color: var(--color-success); }
  .objective, .current { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; text-align: left; }
  .objective { display: block; padding: 0; }
  .meta, .current { color: var(--color-muted-foreground); }
  .meta { font-size: var(--text-xs); flex: none; }
  .description { margin: 4px 0; overflow-wrap: anywhere; }
  p.meta { margin: 0 0 6px; }
  .tasks-toggle { width: 100%; padding: 0; }
  .tasks-toggle :global(svg:last-child) { transition: transform var(--dur-2); }
  .tasks-toggle :global(.turned) { transform: rotate(180deg); }
  .task-disclosure { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--dur-3) var(--ease-out-quint); }
  .task-disclosure.open { grid-template-rows: 1fr; }
  .task-clip { overflow: hidden; }
  ul { list-style: none; margin: 0; padding: 4px 0; max-height: 220px; overflow-y: auto; }
  li { display: flex; gap: 8px; padding: 5px 0; overflow-wrap: anywhere; }
  .task-mark { width: 15px; flex: none; text-align: center; }
  .done { color: var(--color-muted-foreground); }
  .done .task-mark { color: var(--color-success); }
  .error { color: var(--color-danger); margin: 4px 0; overflow-wrap: anywhere; }
  @media (max-width: 720px) {
    .interval { display: none; }
    .activity-row { flex-wrap: wrap; gap: 8px; }
    .objective { flex-basis: calc(100% - 80px); }
    .actions { margin-left: auto; }
    .activity-action { min-height: var(--control-touch); }
    .activity-action.icon { width: var(--control-touch); height: var(--control-touch); }
  }
</style>
