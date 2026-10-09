<!--
  The companion: a box with a lid and two eyes. No mouth and no cheeks: it
  says what it feels with its eyes (their lids, their size, where they look),
  its lid and how it moves. The only colour is the light on the lid, which
  tells the mood. It knows its mood and a few flags, not Boite. Colours come
  from the theme (`app.css`).
-->
<script module lang="ts">
  /** Where it looks, each axis from -1 (left, up) to 1 (right, down). */
  export interface Gaze {
    x: number;
    y: number;
  }
</script>

<script lang="ts">
  import type { Mood } from '../../lib/companion/mood';
  import { strings } from '../../lib/strings';

  interface Props {
    mood: Mood;
    /** Music is playing: headphones, notes, and a sway while resting. */
    music?: boolean;
    /** Many threads at work: it works faster. */
    busy?: boolean;
    /** The pointer is on it: it opens its eyes wide. */
    hover?: boolean;
    /** Bump for a bounce (a click). */
    boing?: number;
    size?: number;
    /** Idle gestures now and then (a glance, a stretch, a yawn); off for captures. */
    lively?: boolean;
    /** Where the pointer is, seen from the companion; null looks ahead. */
    gaze?: Gaze | null;
    /** Night, or nobody at the computer: it sleeps while nothing happens. */
    asleep?: boolean;
    /** The user is typing: it watches. */
    typing?: boolean;
    /** A reminder is due: it rings. */
    alarm?: boolean;
  }

  let { mood, music = false, busy = false, hover = false, boing = 0, size = 56, lively = true, gaze = null, asleep = false, typing = false, alarm = false }: Props = $props();

  type Act = 'look' | 'blink' | 'peek' | 'stretch' | 'yawn';
  const ACT_MS: Record<Act, number> = { look: 2400, blink: 700, peek: 1200, stretch: 1400, yawn: 2400 };
  let act = $state<Act | null>(null);
  let bouncing = $state(false);

  // A gesture now and then while it rests awake: never while it works, calls or sleeps.
  const restless = $derived(lively && mood === 'idle' && !alarm && !hover && !asleep && !typing);
  $effect(() => {
    if (!restless) return;
    const pool: Act[] = music ? ['look', 'blink', 'peek'] : ['look', 'look', 'blink', 'peek', 'stretch', 'yawn'];
    let next: ReturnType<typeof setTimeout> | undefined;
    let end: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      next = setTimeout(() => {
        const chosen = pool[Math.floor(Math.random() * pool.length)]!;
        act = chosen;
        end = setTimeout(() => {
          act = null;
          schedule();
        }, ACT_MS[chosen]);
      }, 9000 + Math.random() * 16000);
    };
    schedule();
    return () => {
      clearTimeout(next);
      clearTimeout(end);
      act = null;
    };
  });

  $effect(() => {
    if (boing === 0) return;
    bouncing = true;
    const timer = setTimeout(() => (bouncing = false), 650);
    return () => clearTimeout(timer);
  });

  type Face = 'awake' | 'sleep' | 'yawn' | 'groove' | 'typing' | 'working' | 'calling' | 'happy' | 'worried' | 'alarm';
  const face: Face = $derived(
    alarm ? 'alarm' : mood !== 'idle' ? mood : hover ? 'awake' : asleep ? 'sleep' : act === 'yawn' ? 'yawn' : typing ? 'typing' : music ? 'groove' : 'awake'
  );
  // The light on the lid: the mood's colour.
  const tone = $derived(face === 'alarm' ? 'calling' : mood);
  const notes = $derived(music && face !== 'sleep' && face !== 'calling' && face !== 'alarm' && face !== 'worried');
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  const look = $derived(face === 'typing' ? { x: 0, y: 1 } : face === 'sleep' || face === 'yawn' || !gaze ? { x: 0, y: 0 } : { x: clamp(gaze.x), y: clamp(gaze.y) });
</script>

<svg
  class="char f-{face} t-{tone} {act ? `a-${act}` : ''}"
  class:music
  class:busy={busy && mood === 'working'}
  class:hover={hover && face === 'awake'}
  class:boing={bouncing}
  style="--gx: {look.x.toFixed(2)}; --gy: {look.y.toFixed(2)}"
  viewBox="0 0 100 100"
  width={size}
  height={size}
  role="img"
  aria-label={alarm ? strings.companion.moods.calling : strings.companion.moods[mood]}
>
  <g class="rig">
    <rect class="body" x="15" y="38" width="70" height="50" rx="9" />

    <g class="eyes">
      <g class="scan">
        {#each [39, 61] as cx, index (cx)}
          <g class="eye" class:right={index === 1}>
            <g class="blink">
              <!-- The eye shuts from the top by `--shut`; lids the colour of the box slant or round it. -->
              <rect class="pupil" x={cx - 4.5} y="54" width="9" height="14" rx="4.5" />
              <rect class="upper" x={cx - 9} y="44" width="18" height="8" />
              <ellipse class="lower" {cx} cy="76.5" rx="10" ry="7" />
            </g>
          </g>
        {/each}
      </g>
    </g>
    <!-- The outline over the lids, so that a lid sliding out of the face never cuts it. -->
    <rect class="rim" x="15" y="38" width="70" height="50" rx="9" />

    <g class="shell lid">
      <rect class="lidbox" x="10" y="26" width="80" height="13" rx="5" />
      <rect class="led" x="43" y="30.25" width="14" height="4.5" rx="2.25" />
    </g>

    {#if music}
      <g class="phones">
        <path class="band under" d="M10 60 V50 C10 10 90 10 90 50 V60" />
        <path class="band" d="M10 60 V50 C10 10 90 10 90 50 V60" />
        <rect class="cup" x="5" y="50" width="10" height="20" rx="3.5" /><rect class="cup" x="85" y="50" width="10" height="20" rx="3.5" />
      </g>
    {/if}
  </g>

  {#if face === 'sleep'}
    <text class="mark z" x="80" y="20">z</text>
  {:else if face === 'calling' || face === 'alarm'}
    <path class="mark stroke shout" d="M95 26 v11 M95 43 v0.5" />
  {:else if face === 'happy'}
    <path class="mark stroke spark" d="M9 22 l-5 -4 M50 9 v-6 M91 22 l5 -4" />
  {:else if face === 'worried'}
    <path class="mark stroke" d="M95 30 v8 M95 44 v0.5" />
  {/if}

  {#if notes}
    <g class="notes" transform="translate(90 4)">
      <g class="note n1"><rect x="0" y="9" width="7" height="5.5" rx="2.75" /><path d="M6.5 11.5 V0 l5 2.5" /></g>
      <g class="note n2" transform="translate(9 12)"><rect x="0" y="7" width="6" height="4.5" rx="2.25" /><path d="M5.5 9 V0 l4 2" /></g>
    </g>
  {/if}
</svg>

<style>
  .char {
    overflow: visible;
    display: block;
    --fg: var(--color-foreground);
    --tone: var(--color-muted-foreground);
    /* The face: how far the eyes are shut, how far each lid has slid in, how the upper one tilts, how wide the eyes open. */
    --shut: 0px;
    --top: 0px;
    --low: 0px;
    --tilt: 0deg;
    --open: 1;
  }
  .t-working { --tone: var(--color-live); }
  .t-calling { --tone: var(--color-accent); }
  .t-happy { --tone: var(--color-success); }
  .t-worried { --tone: var(--color-danger); }

  .f-sleep { --shut: 12px; }
  .f-yawn { --shut: 11px; }
  .f-groove { --shut: 5.5px; --low: 3px; }
  .f-typing { --shut: 3.5px; }
  .f-working { --top: 6.5px; --tilt: 12deg; }
  .f-calling, .f-alarm { --open: 1.18; }
  .f-happy { --low: 9px; }
  .f-worried { --top: 6px; --tilt: -16deg; }
  .hover { --open: 1.1; }

  .body { fill: var(--color-surface); filter: drop-shadow(0 1.5px 2px rgb(0 0 0 / .35)); }
  .rim { fill: none; }
  .rim, .lidbox { stroke: var(--fg); stroke-width: 4; stroke-linejoin: round; }
  .lidbox { fill: var(--color-surface); }
  .shell { filter: drop-shadow(0 1.5px 2px rgb(0 0 0 / .35)); }
  .led { fill: var(--tone); transition: fill var(--dur-2) var(--ease-out-quint); }
  .pupil { fill: var(--fg); }
  .upper, .lower { fill: var(--color-surface); }
  .stroke { fill: none; stroke: var(--tone); stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }
  .z { fill: var(--fg); font: 600 13px var(--font-sans, sans-serif); }
  /* Two-tone headphones like the box (stroke and a surface rim): readable on light and dark. */
  .band { fill: none; stroke: var(--fg); stroke-width: 4.5; stroke-linecap: round; }
  .band.under { stroke: var(--color-surface); stroke-width: 9; }
  .cup { fill: var(--fg); stroke: var(--color-surface); stroke-width: 3; paint-order: stroke; }
  .note rect { fill: var(--fg); }
  .note path { fill: none; stroke: var(--fg); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  /* What sticks out of the box is drawn over the wallpaper: a rim keeps it readable. */
  .mark, .notes { filter: drop-shadow(0 0 1.2px var(--color-surface)) drop-shadow(0 0 1.2px var(--color-surface)); }

  /* The eyes morph from face to face: every part slides, nothing swaps. */
  .rig { transform-box: fill-box; transform-origin: 50% 100%; }
  .lid { transform-box: fill-box; transform-origin: 0% 100%; }
  .eyes { translate: calc(var(--gx) * 4px) calc(var(--gy) * 2.5px); transition: translate .35s var(--ease-out-quint); }
  .pupil, .blink, .upper { transform-box: fill-box; transform-origin: 50% 50%; }
  .pupil {
    y: calc(54px + var(--shut));
    height: calc(14px - var(--shut));
    scale: var(--open);
    transition: y var(--dur-2) var(--ease-out-quint), height var(--dur-2) var(--ease-out-quint), scale var(--dur-2) var(--ease-out-quint);
  }
  .upper { translate: 0 calc(var(--shut) + var(--top)); rotate: var(--tilt); transition: translate var(--dur-2) var(--ease-out-quint), rotate var(--dur-2) var(--ease-out-quint); }
  .right .upper { rotate: calc(var(--tilt) * -1); }
  .lower { translate: 0 calc(var(--low) * -1); transition: translate var(--dur-2) var(--ease-out-quint); }

  /* Body */
  .f-awake .rig, .f-typing .rig { animation: breathe 4s ease-in-out infinite; }
  .f-sleep .rig { animation: breathe 6s ease-in-out infinite; }
  .f-groove .rig { animation: groove .5s ease-in-out infinite alternate; }
  .f-typing .rig { animation: nod 1.6s ease-in-out infinite; }
  .t-working .rig { animation: hum 1.4s ease-in-out infinite; }
  .f-happy .rig { animation: hop 1.2s ease-in-out infinite; }
  .f-worried .rig { animation: shiver .3s linear infinite; }
  .f-alarm .rig { animation: ring .9s ease-in-out infinite; }
  .a-stretch .rig { animation: stretch 1.4s ease-in-out; }
  .boing .rig { animation: boing .65s ease-out; }

  /* Lid */
  .f-calling .lid, .f-alarm .lid { animation: flap 1.3s ease-in-out infinite; }
  .f-happy .lid { animation: tip 1.2s ease-in-out infinite; }
  .f-yawn .lid { animation: yawn-lid 2.4s ease-in-out; }
  .a-peek .lid { animation: peek 1.2s ease-in-out; }
  .boing .lid { animation: pop .65s ease-out; }

  /* Eyes and light */
  .blink { animation: blink 5s ease-in-out infinite; }
  .a-blink .blink { animation: twice .7s ease-in-out; }
  .f-sleep .blink, .f-yawn .blink, .f-happy .blink { animation: none; }
  .a-look .scan { animation: glance 2.4s ease-in-out; }
  .f-working .scan { animation: scan 1.4s ease-in-out infinite alternate; }
  .busy .scan, .busy .led { animation-duration: .7s; }
  .t-working .led { animation: slide 1.4s ease-in-out infinite alternate; }
  .t-calling .led, .t-worried .led { animation: beacon .7s ease-in-out infinite alternate; }
  .shout { animation: beacon .7s ease-in-out infinite alternate; }
  .z { animation: zz 3s ease-in-out infinite; }
  .spark { animation: spark 1.2s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 50%; }
  .note { animation: float 2s ease-out infinite; opacity: 0; }
  .note.n2 { animation-delay: 1s; }
  .phones { animation: fade-in var(--dur-3) var(--ease-out-quint); }

  @keyframes fade-in { from { opacity: 0; } }
  @keyframes breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.012, 1.03); } }
  @keyframes groove { from { transform: rotate(-4deg) translateY(0); } to { transform: rotate(4deg) translateY(-1.5px); } }
  @keyframes nod { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(1.2px); } }
  @keyframes hum { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }
  @keyframes hop {
    0%, 100% { transform: translateY(0) scale(1, 1); }
    30% { transform: translateY(-8px) scale(.98, 1.03); }
    52% { transform: translateY(0) scale(1.04, .96); }
    68% { transform: translateY(0) scale(1, 1); }
  }
  @keyframes shiver { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-1px); } 75% { transform: translateX(1px); } }
  @keyframes ring { 0%, 40%, 100% { transform: rotate(0); } 8% { transform: rotate(-7deg); } 16% { transform: rotate(6deg); } 24% { transform: rotate(-4deg); } 32% { transform: rotate(2deg); } }
  @keyframes stretch { 0%, 100% { transform: scale(1, 1); } 40%, 60% { transform: scale(.96, 1.08); } }
  @keyframes boing { 0% { transform: scale(1, 1); } 25% { transform: scale(1.08, .88); } 55% { transform: scale(.95, 1.08); } 80% { transform: scale(1.02, .98); } 100% { transform: scale(1, 1); } }
  @keyframes flap { 0%, 100% { transform: rotate(0); } 35% { transform: rotate(-22deg); } 60% { transform: rotate(-10deg); } 80% { transform: rotate(-18deg); } }
  @keyframes tip { 0%, 25%, 70%, 100% { transform: rotate(0); } 40% { transform: rotate(-10deg); } }
  @keyframes yawn-lid { 0%, 100% { transform: rotate(0); } 30%, 70% { transform: rotate(-14deg); } }
  @keyframes peek { 0%, 100% { transform: rotate(0); } 25%, 60% { transform: rotate(-9deg); } }
  @keyframes pop { 0%, 100% { transform: rotate(0); } 30% { transform: rotate(-26deg); } 60% { transform: rotate(-8deg); } }
  @keyframes blink { 0%, 93%, 100% { scale: 1 1; } 96% { scale: 1 .08; } }
  @keyframes twice { 0%, 40%, 100% { scale: 1 1; } 20%, 60% { scale: 1 .08; } 80% { scale: 1 1; } }
  @keyframes glance { 0%, 100% { translate: 0 0; } 20%, 40% { translate: -4px 0; } 60%, 80% { translate: 4px -1px; } }
  @keyframes scan { from { translate: -3px 0; } to { translate: 3px 0; } }
  @keyframes slide { from { transform: translateX(-22px); } to { transform: translateX(22px); } }
  @keyframes beacon { from { opacity: 1; } to { opacity: .3; } }
  @keyframes zz { 0% { transform: translate(0, 0); opacity: 0; } 25% { opacity: .9; } 100% { transform: translate(6px, -10px); opacity: 0; } }
  @keyframes spark { 0%, 20% { opacity: 0; transform: scale(.5); } 40% { opacity: 1; transform: scale(1); } 75%, 100% { opacity: 0; transform: scale(1.1); } }
  @keyframes float { 0% { transform: translate(0, 6px); opacity: 0; } 25% { opacity: 1; } 100% { transform: translate(8px, -14px); opacity: 0; } }

  @media (prefers-reduced-motion: reduce) {
    .char, .char * { animation: none !important; transition: none !important; }
    .note { opacity: 1; }
  }
</style>
