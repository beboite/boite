<script lang="ts">
  import { ChevronRight, CircleCheck, UsersRound } from '@lucide/svelte';
  import type { DelegatedAgent } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { teamProgress } from '../lib/delegation-progress';
  import AgentElapsed from './AgentElapsed.svelte';
  import ProviderLogo from './ProviderLogo.svelte';

  let { store, agents }: { store: Store; agents: DelegatedAgent[] } = $props();
  const progress = $derived(teamProgress(agents));
  function open() {
    void store.selectDelegatedAgent(null);
    store.panel.open('agents');
  }
</script>

<button type="button" class="activity" class:live={progress.active} onclick={open} data-testid="delegation-activity" title={strings.delegation.showTeam}>
  <span class="avatars" aria-hidden="true">
    {#each agents.slice(0, 3) as agent (agent.thread.id)}
      <span class="avatar"><ProviderLogo providerId={agent.thread.providerId} size={14} /></span>
    {/each}
  </span>
  <span class="content">
    <span class="title">{agents.length === 1 ? strings.delegation.startedOne : fill(strings.delegation.startedMany, { count: String(agents.length) })}</span>
    <span class="progress" data-testid="delegation-progress">
      {#if progress.completed === agents.length}<CircleCheck size={13} />{:else}<UsersRound size={13} />{/if}
      {fill(strings.delegation.completed, { done: String(progress.completed), total: String(agents.length) })}
      {#if progress.failed}<span class="failed">· {fill(strings.delegation.failed, { count: String(progress.failed) })}</span>{/if}
      {#if progress.stopped}<span>· {fill(strings.delegation.stopped, { count: String(progress.stopped) })}</span>{/if}
    </span>
  </span>
  <span class="timing">{#if progress.startedAt !== null}<AgentElapsed startedAt={progress.startedAt} finishedAt={progress.finishedAt} active={progress.active} />{/if}</span>
  <ChevronRight size={15} />
</button>

<style>
  .activity { width: 100%; min-height: var(--row); height: auto; display: flex; align-items: center; gap: 10px; padding: 9px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: var(--shadow-e1); text-align: left; color: var(--color-muted-foreground); }
  .activity:hover, .activity:focus-visible { background: var(--color-hover); color: var(--color-foreground); }
  .avatars { display: flex; flex: none; padding-right: 3px; }
  .avatar { display: grid; place-items: center; width: var(--control-sm); height: var(--control-sm); border-radius: 50%; border: 1px solid var(--color-edge); background: var(--color-surface-2); }
  .avatar + .avatar { margin-left: -7px; }
  .content { flex: 1; min-width: 0; }
  .title { display: block; color: var(--color-foreground); font-size: var(--text-sm); font-weight: 500; }
  .progress { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: var(--text-xs); }
  .live .progress :global(svg) { color: var(--color-live); }
  .failed { color: var(--color-danger); }
  .timing { flex: none; font-size: var(--text-xs); }
</style>
