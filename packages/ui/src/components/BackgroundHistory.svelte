<script lang="ts">
  import type { BackgroundTaskObservation } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { exactTime } from '../lib/format';
  let { tasks }: { tasks: BackgroundTaskObservation[] } = $props();
  let recent = $derived([...tasks].reverse());
  const label = (task: BackgroundTaskObservation) => task.reason === 'core-restarted' ? strings.chat.backgroundRestarted
    : task.reason === 'session-ended' ? strings.chat.backgroundSessionEnded : strings.chat.backgroundState[task.state];
</script>

{#if recent.length}
  <details class="history" data-testid="background-history">
    <summary>{fill(strings.chat.backgroundHistory, { count: String(recent.length) })}</summary>
    <ul>
      {#each recent as task (`${task.providerId}:${task.sessionGeneration}:${task.parentTurnId}:${task.id}`)}
        <li data-state={task.state}>
          <div class="description">{task.description || task.kind}</div>
          <div class="status"><span>{label(task)}</span><time datetime={new Date(task.observedAt).toISOString()}>{exactTime(task.observedAt)}</time></div>
        </li>
      {/each}
    </ul>
  </details>
{/if}

<style>
  .history { flex: none; width: min(calc(100% - 40px), var(--content)); margin: 0 auto 8px; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  summary { cursor: pointer; min-height: 32px; padding: 8px 0; }
  ul { max-height: 220px; overflow: auto; margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  li { padding: 8px 10px; }
  li + li { border-top: 1px solid var(--color-border); }
  .description { color: var(--color-foreground); overflow-wrap: anywhere; }
  .status { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; }
  time { margin-left: auto; }
  [data-state='running'] .description { color: var(--color-accent); }
  [data-state='error'] .description { color: var(--color-danger); }
  @media (max-width: 720px) { .history { width: calc(100% - 20px); } }
</style>
