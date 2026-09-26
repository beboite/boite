<script lang="ts">
  import { Target, Users } from '@lucide/svelte';
  import type { AgentProfile } from '@boite/contracts';
  import { avatarText, tintOf } from '../../lib/agents.svelte';

  /**
   * A messenger's avatar: an agent's initials on a disc tinted by its id, two
   * members stacked for a group, a target for a mission. The dot says it is
   * working (accent) or waiting on the user (live), and nothing otherwise.
   */
  let { kind, id, name, avatar = '', members = [], status = 'idle', size = 40 }: {
    kind: 'profile' | 'group' | 'team' | 'mission';
    id: string;
    name: string;
    avatar?: string;
    members?: Pick<AgentProfile, 'id' | 'name' | 'avatar'>[];
    status?: string;
    size?: number;
  } = $props();

  const grouped = $derived(kind === 'group' || kind === 'team');
</script>

<span class="agent-avatar" data-kind={kind} style:--size="{size}px" style:--tint={kind === 'mission' ? null : tintOf(id)} aria-hidden="true">
  {#if grouped && members.length >= 2}
    {#each members.slice(0, 2) as member, slot (member.id)}
      <span class="agent-avatar-stack" data-slot={slot} style:--tint={tintOf(member.id)}>{avatarText(member.name, member.avatar)}</span>
    {/each}
  {:else if grouped}
    <Users size={Math.round(size * 0.45)} strokeWidth={1.75} />
  {:else if kind === 'mission'}
    <Target size={Math.round(size * 0.45)} strokeWidth={1.75} />
  {:else}
    {avatarText(name, avatar)}
  {/if}
  {#if status === 'running' || status === 'waiting'}<i data-status={status}></i>{/if}
</span>
