<script lang="ts">
  import { Target, Users } from '@lucide/svelte';
  import type { AgentProfile } from '@boite/contracts';
  import { avatarText, robotOf, tintOf } from '../../lib/robots';
  import RobotFace from './RobotFace.svelte';

  /**
   * An agent's picture: its robot, or the emoji or letters it chose instead,
   * on a disc. A group stacks two of its members, a mission shows a target.
   * The robot's face says whether it works or waits; the dot says it too, for
   * a picture too small to read a face, and for text avatars.
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
  const robot = $derived(kind === 'profile' ? robotOf(id, avatar) : null);
  const face = $derived(status === 'running' ? 'working' : status === 'waiting' ? 'waiting' : 'idle');
</script>

{#snippet picture(member: Pick<AgentProfile, 'id' | 'name' | 'avatar'>, state: 'idle' | 'working' | 'waiting' | 'still')}
  {@const own = robotOf(member.id, member.avatar)}
  {#if own}<RobotFace robot={own} {state} />{:else}{avatarText(member.name, member.avatar)}{/if}
{/snippet}

<span class="agent-avatar" class:robot={!!robot} data-kind={kind} style:--size="{size}px" style:--tint={kind === 'mission' ? null : tintOf(id)} aria-hidden="true">
  {#if grouped && members.length >= 2}
    {#each members.slice(0, 2) as member, slot (member.id)}
      <span class="agent-avatar-stack" class:robot={!!robotOf(member.id, member.avatar)} data-slot={slot} style:--tint={tintOf(member.id)}>{@render picture(member, 'still')}</span>
    {/each}
  {:else if grouped}
    <Users size={Math.round(size * 0.45)} strokeWidth={1.75} />
  {:else if kind === 'mission'}
    <Target size={Math.round(size * 0.45)} strokeWidth={1.75} />
  {:else if robot}
    <RobotFace {robot} state={size < 24 ? 'still' : face} />
  {:else}
    {avatarText(name, avatar)}
  {/if}
  {#if status === 'running' || status === 'waiting'}<i data-status={status}></i>{/if}
</span>

<style>
  /* Initials on a disc tinted by the id, a robot cropped to the same disc, two members stacked for a group. */
  .agent-avatar { --size: 40px; --tint: var(--series-other); position: relative; width: var(--size); height: var(--size); flex: none; display: grid; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--tint) 28%, var(--color-surface-2)); color: color-mix(in srgb, var(--tint) 40%, var(--color-foreground)); font-size: calc(var(--size) * 0.38); font-weight: 600; line-height: 1; user-select: none; }
  .agent-avatar.robot, .agent-avatar:has(.agent-avatar-stack) { background: none; }
  .agent-avatar :global(svg.robot) { border-radius: 50%; overflow: hidden; }
  .agent-avatar[data-kind='mission'] { border-radius: var(--radius-md); background: var(--color-surface-3); color: var(--color-muted-foreground); }
  .agent-avatar-stack { position: absolute; width: 62%; height: 62%; display: grid; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--tint) 28%, var(--color-surface-2)); color: color-mix(in srgb, var(--tint) 40%, var(--color-foreground)); font-size: calc(var(--size) * 0.26); box-shadow: 0 0 0 2px var(--ring, var(--color-surface)); }
  .agent-avatar-stack.robot { background: none; }
  .agent-avatar-stack[data-slot='0'] { top: 0; left: 0; }
  .agent-avatar-stack[data-slot='1'] { right: 0; bottom: 0; }
  /* The dot only while it works or waits, at most a third of a small picture. */
  .agent-avatar i { position: absolute; right: -1px; bottom: -1px; width: clamp(7px, calc(var(--size) * 0.28), 11px); height: clamp(7px, calc(var(--size) * 0.28), 11px); border-radius: 50%; box-shadow: 0 0 0 2px var(--ring, var(--color-surface)); }
  .agent-avatar i[data-status='running'] { background: var(--color-accent); }
  .agent-avatar i[data-status='waiting'] { background: var(--color-live); }
</style>
