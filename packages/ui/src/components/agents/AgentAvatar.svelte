<script lang="ts">
  import { Target, Users } from '@lucide/svelte';
  import type { AgentProfile } from '@boite/contracts';
  import type { AgentMood } from '../../lib/agents.svelte';
  import { avatarText, robotColor, robotOf, tintOf } from '../../lib/robots';
  import { threadTone } from '../../lib/thread-state';
  import StatusMark from '../StatusMark.svelte';
  import Deferred, { parts } from '../Deferred.svelte';
  import type { RobotState } from './RobotFace.svelte';

  /**
   * An agent's picture: its robot, or the emoji or letters it chose instead,
   * on a disc. A group stacks two of its members, a mission shows a target.
   *
   * `ring` draws a ring around the disc that says the agent's `mood`: an arc
   * of the accent turning while it works, the waiting colour pulsing while it
   * needs the user, danger after a failure, a full accent ring over answers not
   * read, a dashed one while it is queued or asleep, a hairline in the
   * robot's own colour at rest. The robot's face moves with it. Without a ring
   * the corner dot says whether it works or waits, for a picture too small to
   * read a face, and for text avatars.
   */
  let { kind, id, name, avatar = '', members = [], status = 'idle', mood, size = 40, ring = false }: {
    kind: 'profile' | 'group' | 'team' | 'mission';
    id: string;
    name: string;
    avatar?: string;
    members?: Pick<AgentProfile, 'id' | 'name' | 'avatar'>[];
    /** `running`, `waiting` or `idle`: what the corner dot and the face show without a mood. */
    status?: string;
    mood?: AgentMood;
    size?: number;
    ring?: boolean;
  } = $props();

  const grouped = $derived(kind === 'group' || kind === 'team');
  const robot = $derived(kind === 'profile' ? robotOf(id, avatar) : null);
  const standing = $derived<AgentMood>(mood ?? (status === 'running' ? 'working' : status === 'waiting' ? 'waiting' : 'idle'));
  const face = $derived<RobotState>(size < 24 ? 'still' : standing === 'working' || standing === 'waiting' || standing === 'error' || standing === 'asleep' ? standing : 'idle');
  /** The ring's resting colour: the robot's body, else the disc's tint. */
  const ringTint = $derived(robot ? robotColor(robot) : tintOf(id));
  const radius = $derived(size / 2 + 2.5);
</script>

{#snippet picture(member: Pick<AgentProfile, 'id' | 'name' | 'avatar'>, state: RobotState)}
  {@const own = robotOf(member.id, member.avatar)}
  {#if own}<Deferred part={parts.RobotFace} quiet>{#snippet children(RobotFace)}<RobotFace robot={own} {state} />{/snippet}</Deferred>{:else}<span class="ui-label">{avatarText(member.name, member.avatar)}</span>{/if}
{/snippet}

<span class="agent-avatar" class:robot={!!robot} data-kind={kind} data-ring={ring ? standing : null} style:--size="{size}px" style:--tint={kind === 'mission' ? null : tintOf(id)} style:--ring-tint={ring ? ringTint : null} aria-hidden="true">
  {#if ring}
    <svg class="avatar-ring" aria-hidden="true">
      <circle class="track" cx="50%" cy="50%" r={radius} pathLength="100" />
      {#if standing === 'working'}<circle class="arc" cx="50%" cy="50%" r={radius} pathLength="100" />{/if}
    </svg>
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
    <Deferred part={parts.RobotFace} quiet>{#snippet children(RobotFace)}<RobotFace robot={own} state={face} />{/snippet}</Deferred>
  {:else}
    <span class="ui-label">{avatarText(name, avatar)}</span>
  {/if}
  {#if !ring && (status === 'running' || status === 'waiting')}<StatusMark {...threadTone(status)} corner />{/if}
</span>

<style>
  /* Initials on a disc tinted by the id, a robot cropped to the same disc, two members stacked for a group. */
  .agent-avatar { --size: 40px; --tint: var(--series-other); position: relative; width: var(--size); height: var(--size); flex: none; display: grid; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--tint) 28%, var(--color-surface-2)); color: color-mix(in srgb, var(--tint) 40%, var(--color-foreground)); font-size: calc(var(--size) * 0.38); font-weight: 600; line-height: 1; user-select: none; }
  .agent-avatar.robot, .agent-avatar:has(.agent-avatar-stack) { background: none; }
  .agent-avatar :global(svg.robot) { border-radius: 50%; overflow: hidden; transition: opacity var(--dur-3) var(--ease-out-quint); }
  .agent-avatar[data-kind='mission'] { border-radius: var(--radius-md); background: var(--color-surface-3); color: var(--color-muted-foreground); }
  .agent-avatar-stack { position: absolute; width: 62%; height: 62%; display: grid; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--tint) 28%, var(--color-surface-2)); color: color-mix(in srgb, var(--tint) 40%, var(--color-foreground)); font-size: calc(var(--size) * 0.26); box-shadow: 0 0 0 2px var(--ring, var(--color-surface)); }
  .agent-avatar-stack.robot { background: none; }
  .agent-avatar-stack[data-slot='0'] { top: 0; left: 0; }
  .agent-avatar-stack[data-slot='1'] { right: 0; bottom: 0; }
  /* The status mark only while it works or waits, at most a third of a small picture. */
  .agent-avatar { --mark-size: clamp(6px, calc(var(--size) * 0.24), 9px); }

  /*
   * The ring, just outside the disc. It shares the portrait's viewport so CSS
   * border snapping cannot shift or thin it at fractional zoom. Hue says the
   * state; only rest wears the robot's own colour.
   */
  .avatar-ring { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
  /* Every track keeps the 1.5 px hairline: a whole-pixel width snaps off-centre at fractional zoom (tests/e2e/avatar-rings.test.ts). */
  .avatar-ring circle { fill: none; stroke-width: 1.5px; transition: stroke var(--dur-3) var(--ease-out-quint); }
  .track { stroke: color-mix(in srgb, var(--ring-tint) 50%, transparent); }
  [data-ring='working'] .track { stroke: color-mix(in srgb, var(--color-accent) 28%, transparent); }
  /* At work: an arc of the accent turns around the disc. */
  .avatar-ring .arc { stroke: var(--color-accent); stroke-linecap: round; stroke-width: 2.5px; stroke-dasharray: 30 70; transform-box: fill-box; transform-origin: center; animation: spin 1.2s steps(72) infinite var(--loops); }
  [data-ring='queued'] .track { stroke: var(--color-accent); stroke-dasharray: 4 6; opacity: 0.7; }
  /* Needs the user: the waiting colour, pulsing. */
  [data-ring='waiting'] .track { stroke: var(--color-live); animation: pulse 1.6s var(--loop-ease-in-out-48) infinite var(--loops); }
  [data-ring='error'] .track { stroke: var(--color-danger); }
  [data-ring='unread'] .track { stroke: var(--color-accent); }
  [data-ring='asleep'] .track { stroke: var(--color-edge); stroke-dasharray: 2 5; stroke-linecap: round; }
  [data-ring='asleep'] :global(svg.robot) { opacity: 0.7; }
  @media (prefers-reduced-motion: reduce) { .agent-avatar .avatar-ring :is(.arc, .track) { animation: none; } }
  :global(html[data-motion='reduced']) .agent-avatar .avatar-ring :is(.arc, .track) { animation: none; }
</style>
