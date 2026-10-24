<script lang="ts">
  import { Target, Users } from '@lucide/svelte';
  import type { AgentProfile } from '@boite/contracts';
  import { avatarText, robotColor, robotOf, tintOf } from '../../lib/robots';
  import { threadTone } from '../../lib/thread-state';
  import StatusMark from '../StatusMark.svelte';
  import Deferred, { parts } from '../Deferred.svelte';

  /**
   * An agent's picture: its robot, or the emoji or letters it chose instead,
   * on a disc. A group stacks two of its members, a mission shows a target.
   * The robot's face says whether it works or waits; the dot says it too, for
   * a picture too small to read a face, and for text avatars. `ring` draws a
   * thin ring in the robot's own colour around the disc, the one place that
   * colour reaches beyond the robot: it pulses while the agent works.
   */
  let { kind, id, name, avatar = '', members = [], status = 'idle', size = 40, ring = false }: {
    kind: 'profile' | 'group' | 'team' | 'mission';
    id: string;
    name: string;
    avatar?: string;
    members?: Pick<AgentProfile, 'id' | 'name' | 'avatar'>[];
    status?: string;
    size?: number;
    ring?: boolean;
  } = $props();

  const grouped = $derived(kind === 'group' || kind === 'team');
  const robot = $derived(kind === 'profile' ? robotOf(id, avatar) : null);
  const face = $derived(status === 'running' ? 'working' : status === 'waiting' ? 'waiting' : 'idle');
  /** The ring's colour: the robot's body, else the disc's tint. */
  const ringTint = $derived(robot ? robotColor(robot) : tintOf(id));
</script>

{#snippet picture(member: Pick<AgentProfile, 'id' | 'name' | 'avatar'>, state: 'idle' | 'working' | 'waiting' | 'still')}
  {@const own = robotOf(member.id, member.avatar)}
  {#if own}<Deferred part={parts.RobotFace} quiet>{#snippet children(RobotFace)}<RobotFace robot={own} {state} />{/snippet}</Deferred>{:else}<span class="ui-label">{avatarText(member.name, member.avatar)}</span>{/if}
{/snippet}

<span class="agent-avatar" class:robot={!!robot} data-kind={kind} data-ring={ring ? face : null} style:--size="{size}px" style:--tint={kind === 'mission' ? null : tintOf(id)} style:--ring-tint={ring ? ringTint : null} aria-hidden="true">
  {#if ring}
    <svg class="avatar-ring" aria-hidden="true"><circle cx="50%" cy="50%" r={size / 2 + 2.25} /></svg>
  {/if}
  {#if grouped && members.length >= 2}
    {#each members.slice(0, 2) as member, slot (member.id)}
      <span class="agent-avatar-stack" class:robot={!!robotOf(member.id, member.avatar)} data-slot={slot} style:--tint={tintOf(member.id)}>{@render picture(member, 'still')}</span>
    {/each}
  {:else if grouped}
    <Users size={Math.round(size * 0.45)} strokeWidth={1.75} />
  {:else if kind === 'mission'}
    <Target size={Math.round(size * 0.45)} strokeWidth={1.75} />
  {:else if robot}
    {@const own = robot}
    <Deferred part={parts.RobotFace} quiet>{#snippet children(RobotFace)}<RobotFace robot={own} state={size < 24 ? 'still' : face} />{/snippet}</Deferred>
  {:else}
    <span class="ui-label">{avatarText(name, avatar)}</span>
  {/if}
  {#if status === 'running' || status === 'waiting'}<StatusMark {...threadTone(status)} corner />{/if}
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
  /* The status mark only while it works or waits, at most a third of a small picture. */
  .agent-avatar { --mark-size: clamp(6px, calc(var(--size) * 0.24), 9px); }
  /* The ring: a hairline in the robot's colour just outside the disc, breathing while it works, still while it waits or rests. */
  /* Share the portrait's viewport so CSS border snapping cannot shift or thin the ring at fractional zoom. */
  .avatar-ring { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
  .avatar-ring circle { fill: none; stroke: color-mix(in srgb, var(--ring-tint) 55%, transparent); stroke-width: 1.5px; transition: stroke var(--dur-3) var(--ease-out-quint); }
  .agent-avatar[data-ring='working'] .avatar-ring { animation: pulse 1.6s var(--loop-ease-in-out-48) infinite var(--loops); }
  .agent-avatar[data-ring='working'] circle { stroke: var(--ring-tint); }
  .agent-avatar[data-ring='waiting'] circle { stroke: color-mix(in srgb, var(--ring-tint) 80%, transparent); }
  @media (prefers-reduced-motion: reduce) { .agent-avatar[data-ring='working'] .avatar-ring { animation: none; } }
  :global(html[data-motion='reduced']) .agent-avatar[data-ring='working'] .avatar-ring { animation: none; }
</style>
