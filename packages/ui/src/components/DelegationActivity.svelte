<script lang="ts">
  import { CircleCheck, UsersRound } from '@lucide/svelte';
  import type { DelegatedAgent } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { teamProgress } from '../lib/delegation-progress';
  import ActivityCard from './ActivityCard.svelte';
  import ProviderLogo from './ProviderLogo.svelte';

  let { store, agents }: { store: Store; agents: DelegatedAgent[] } = $props();
  const team = $derived(teamProgress(agents));
</script>

<ActivityCard live={team.active} heading={agents.length === 1 ? strings.delegation.startedOne : fill(strings.delegation.startedMany, { count: String(agents.length) })} timing={team} onclick={() => store.showTeam()} data-testid="delegation-activity" progressTestId="delegation-progress" title={strings.delegation.showTeam}>
  {#snippet mark()}
    <span class="avatars" aria-hidden="true">
      {#each agents.slice(0, 3) as agent (agent.thread.id)}
        <span class="avatar"><ProviderLogo providerId={agent.thread.providerId} size={14} /></span>
      {/each}
    </span>
  {/snippet}
  {#snippet progress()}
    {#if team.completed === agents.length}<CircleCheck size={13} />{:else}<UsersRound size={13} />{/if}
    <span class="ui-label">{fill(strings.delegation.completed, { done: String(team.completed), total: String(agents.length) })}</span>
    {#if team.failed}<span class="failed ui-label">· {fill(strings.delegation.failed, { count: String(team.failed) })}</span>{/if}
    {#if team.stopped}<span class="ui-label">· {fill(strings.delegation.stopped, { count: String(team.stopped) })}</span>{/if}
  {/snippet}
</ActivityCard>

<style>
  .avatars { display: flex; flex: none; padding-right: 3px; }
  .avatar { display: grid; place-items: center; width: var(--control-sm); height: var(--control-sm); border-radius: 50%; border: 1px solid var(--color-edge); background: var(--color-surface-2); }
  .avatar + .avatar { margin-left: -7px; }
  .failed { color: var(--color-danger); }
</style>
