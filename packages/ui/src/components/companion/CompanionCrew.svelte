<!--
  The companion's head: its characters side by side, one per agent that
  stands as the companion (`lib/companion/crew.svelte.ts`), each in its
  agent's box, the leader on the side the window is anchored to, and the HUD
  beside them or under them (`children`). A click talks to that agent; a
  press that moves carries the window. The leader shows what goes on in Boite
  (the mood, a reminder ringing, the requests waiting); the others show their
  own conversation.
-->
<script module lang="ts">
  import type { Robot } from '../../lib/robots';
  import type { Talk } from '../../lib/companion/talk.svelte';

  /** One character of the row; `id` is empty for the companion without an agent. */
  export interface CrewMember {
    id: string;
    name: string | null;
    skin: Robot | null;
    talk: Talk;
  }

  /** What every character shows alike. */
  export interface CrewLook {
    music: boolean;
    hover: boolean;
    asleep: boolean;
    typing: boolean;
    calm: boolean;
    rest: boolean;
    game: boolean;
    coffee: boolean;
    startled: boolean;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Mood } from '../../lib/companion/mood';
  import type { CompanionLayout } from '../../lib/companion/shell';
  import { fill, strings } from '../../lib/strings';
  import CompanionCharacter, { type Gaze } from './CompanionCharacter.svelte';
  import CompanionConfetti from './CompanionConfetti.svelte';

  interface Props {
    members: CrewMember[];
    /** The member the panel talks to. */
    active: string;
    open: boolean;
    layout: CompanionLayout;
    look: CrewLook;
    /** What goes on in Boite, which the leader shows. */
    mood: Mood;
    busy: boolean;
    alarm: boolean;
    blocking: number;
    cheering: boolean;
    burst: number;
    /** Bumped per member for a bounce. */
    boings: Record<string, number>;
    pointer: { x: number; y: number } | null;
    dragging: boolean;
    onpick: (id: string) => void;
    onpress: (event: PointerEvent) => void;
    onmove: (event: PointerEvent) => void;
    onrelease: () => void;
    onenter: () => void;
    onleave: () => void;
    children: Snippet;
  }

  let { members, active, open, layout, look, mood, busy, alarm, blocking, cheering, burst, boings, pointer, dragging, onpick, onpress, onmove, onrelease, onenter, onleave, children }: Props = $props();

  /** The distance at which the eyes reach the side and the bottom of their sockets. */
  const GAZE_REACH = { x: 240, y: 180 };

  let buttons = $state<Record<string, HTMLButtonElement | null>>({});
  const crowd = $derived(members.length > 2);
  const several = $derived(members.length > 1);

  /** Where the pointer is, seen from one character's eyes. */
  function gazeOf(id: string): Gaze | null {
    const element = buttons[id];
    if (!pointer || !element || dragging) return null;
    const box = element.getBoundingClientRect();
    const clamp = (value: number) => Math.max(-1, Math.min(1, value));
    return { x: clamp((pointer.x - box.x - box.width / 2) / GAZE_REACH.x), y: clamp((pointer.y - box.y - box.height / 2) / GAZE_REACH.y) };
  }

  function labelOf(member: CrewMember): string {
    if (open && member.id === active) return strings.companion.close;
    return member.name ? fill(strings.companion.talkTo, { name: member.name }) : strings.companion.open;
  }
</script>

<div class="head" class:crowd data-align={layout.align} data-edge={layout.edge}>
  <div class="row">
    {#each members as member, index (member.id)}
      {@const leader = index === 0}
      <button
        bind:this={buttons[member.id]}
        class="character"
        class:dragging
        class:picked={open && several && member.id === active}
        data-hit
        data-testid="companion-character"
        aria-label={labelOf(member)}
        title={several ? (member.name ?? undefined) : undefined}
        aria-expanded={open && member.id === active}
        onclick={() => onpick(member.id)}
        onpointerdown={onpress}
        onpointermove={onmove}
        onpointerup={onrelease}
        onpointerenter={onenter}
        onpointerleave={onleave}
      >
        <CompanionCharacter
          mood={member.talk.thinking ? 'working' : leader ? mood : 'idle'}
          busy={leader && busy}
          alarm={leader && alarm}
          cheer={leader && cheering}
          boing={boings[member.id] ?? 0}
          gaze={gazeOf(member.id)}
          skin={member.skin}
          size={64}
          {...look}
        />
        {#if leader && cheering}<CompanionConfetti {burst} />{/if}
        {#if leader && blocking > 0}<span class="badge" aria-hidden="true">{blocking}</span>{/if}
      </button>
    {/each}
  </div>
  <div class="hud">
    {@render children()}
  </div>
</div>

<style>
  /* The characters and their HUD: under them in the centre, where the sides
     leave too little room, beside them towards the middle of the screen
     otherwise, and under them again once three stand side by side. The leader
     stays first, so its centre does not move. */
  .head {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: 100%;
  }
  .head[data-edge='bottom'] {
    flex-direction: column-reverse;
  }
  .head[data-align='left']:not(.crowd),
  .head[data-align='right']:not(.crowd) {
    flex-direction: row;
    align-items: flex-start;
    gap: 14px;
  }
  .head[data-align='right']:not(.crowd) {
    flex-direction: row-reverse;
  }
  .head[data-edge='bottom'][data-align='left']:not(.crowd),
  .head[data-edge='bottom'][data-align='right']:not(.crowd) {
    align-items: flex-end;
  }
  .head.crowd[data-align='left'] {
    align-items: flex-start;
  }
  .head.crowd[data-align='right'] {
    align-items: flex-end;
  }

  .row {
    display: flex;
    align-items: flex-end;
    gap: 12px;
  }
  .head[data-align='right'] .row {
    flex-direction: row-reverse;
  }

  /* The HUD: the activity pill and the pomodoro side by side under the
     characters, one over the other beside them. */
  .hud {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
  }
  .head[data-align='left']:not(.crowd) .hud,
  .head[data-align='right']:not(.crowd) .hud {
    flex-direction: column;
    align-items: flex-start;
  }
  .head[data-align='right']:not(.crowd) .hud {
    align-items: flex-end;
  }
  .head[data-edge='bottom'][data-align='left']:not(.crowd) .hud,
  .head[data-edge='bottom'][data-align='right']:not(.crowd) .hud {
    flex-direction: column-reverse;
  }
  /* Some air between the characters and their HUD, so the pill does not touch them. */
  .hud:has(> :global(*)) {
    margin-top: 10px;
  }
  /* At the bottom edge the HUD sits over the characters, whose lids need more. */
  .head[data-edge='bottom'] .hud:has(> :global(*)) {
    margin-top: 0;
    margin-bottom: 14px;
  }
  /* Beside the characters, the pill sits level with their middle. */
  .head[data-align='left']:not(.crowd) .hud,
  .head[data-align='right']:not(.crowd) .hud {
    margin-top: 11px;
    margin-bottom: 0;
  }
  .head[data-edge='bottom'][data-align='left']:not(.crowd) .hud,
  .head[data-edge='bottom'][data-align='right']:not(.crowd) .hud {
    margin-top: 0;
    margin-bottom: 11px;
  }

  .character {
    position: relative;
    flex: none;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    touch-action: none;
    /* Air between the characters and what they show, on the side they show it. */
    margin-bottom: 10px;
  }
  .head[data-edge='bottom'] .character {
    margin-top: 10px;
    margin-bottom: 0;
  }
  .character.dragging {
    cursor: grabbing;
  }
  .character:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    border-radius: var(--radius-md);
  }
  /* The one the panel talks to, when several stand. */
  .character.picked::after {
    content: '';
    position: absolute;
    left: 50%;
    bottom: -8px;
    width: 18px;
    height: 3px;
    border-radius: var(--radius-full);
    background: var(--color-accent);
    transform: translateX(-50%);
  }
  .head[data-edge='bottom'] .character.picked::after {
    top: -8px;
    bottom: auto;
  }
  .badge {
    position: absolute;
    top: 0;
    right: -4px;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: var(--radius-full);
    background: var(--color-danger);
    color: var(--color-accent-ink);
    font-size: var(--text-xs);
    font-weight: 600;
    line-height: 18px;
    text-align: center;
  }
</style>
