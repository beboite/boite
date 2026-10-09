<!--
  The companion: the outline of Boite's icon, with eyes. It knows its mood and
  a few flags, not Boite. Colours come from the theme (`app.css`).
-->
<script lang="ts">
  import type { Mood } from '../../lib/companion/mood';
  import { strings } from '../../lib/strings';

  interface Props {
    mood: Mood;
    /** Music is playing: headphones, notes, and a sway while resting. */
    music?: boolean;
    /** Many threads at work: it sweats. */
    busy?: boolean;
    /** The pointer is on it: it wakes up and looks at you. */
    hover?: boolean;
    /** Bump for a bounce (a click). */
    boing?: number;
    size?: number;
    /** Yawns while resting; off for captures. */
    yawns?: boolean;
  }

  let { mood, music = false, busy = false, hover = false, boing = 0, size = 56, yawns = true }: Props = $props();

  const wide = $derived(mood === 'working' || mood === 'calling');

  let yawning = $state(false);
  let bouncing = $state(false);

  // A yawn now and then when it is bored: resting, no music, no pointer.
  $effect(() => {
    if (!yawns || mood !== 'idle' || music || hover) return;
    let stop: ReturnType<typeof setTimeout> | undefined;
    const next = setTimeout(() => {
      yawning = true;
      stop = setTimeout(() => (yawning = false), 2200);
    }, 15000 + Math.random() * 20000);
    return () => {
      clearTimeout(next);
      clearTimeout(stop);
      yawning = false;
    };
  });

  $effect(() => {
    if (boing === 0) return;
    bouncing = true;
    const timer = setTimeout(() => (bouncing = false), 650);
    return () => clearTimeout(timer);
  });

  type Face = 'sleep' | 'awake' | 'groove' | 'yawn' | 'working' | 'calling' | 'happy' | 'worried';
  const face: Face = $derived(mood === 'idle' ? (yawning ? 'yawn' : hover ? 'awake' : music ? 'groove' : 'sleep') : mood);
  const open = $derived(mood === 'calling' || yawning || bouncing);
  const notes = $derived(music && (mood === 'idle' || mood === 'working' || mood === 'happy'));
</script>

<svg
  class="char s-{mood}"
  class:wide
  class:open
  class:music
  class:busy={busy && mood === 'working'}
  class:hover
  class:yawn={yawning}
  class:boing={bouncing}
  class:groove={face === 'groove'}
  viewBox="0 0 100 100"
  width={size}
  height={size}
  role="img"
  aria-label={strings.companion.moods[mood]}
>
  <g class="rig">
    <rect class="box" />
    <rect class="bar" />
    <g class="lid"><rect class="lidbox" /><rect class="led" /></g>

    {#key face}
      <g class="layer">
        {#if face === 'sleep'}
          <path class="ink" d="M35 67 h9 M56 67 h9" />
          <text class="z zz" x="84" y="14">z</text>
        {:else if face === 'awake'}
          <g class="eyes"><rect class="eye blink" x="35" y="61" width="9" height="11" rx="2" /><rect class="eye blink" x="56" y="61" width="9" height="11" rx="2" /></g>
          <path class="ink thin" d="M46 79 h8" />
        {:else if face === 'groove'}
          <path class="ink" d="M35 68 l4.5 -4 l4.5 4 M56 68 l4.5 -4 l4.5 4" />
          <path class="ink thin" d="M45 77 q5 4 10 0" />
        {:else if face === 'yawn'}
          <path class="ink" d="M35 63 h9 M56 63 h9" />
          <rect class="eye" x="45" y="70" width="10" height="11" rx="4" />
        {:else if face === 'working'}
          <g class="follow eyes"><rect class="eye blink" x="25" y="62" width="8" height="10" rx="1.5" /><rect class="eye blink" x="40" y="62" width="8" height="10" rx="1.5" /></g>
          <g class="dots"><rect class="t-fill" x="62" y="66" width="5" height="5" rx="1" /><rect class="t-fill" x="71" y="66" width="5" height="5" rx="1" /><rect class="t-fill" x="80" y="66" width="5" height="5" rx="1" /></g>
        {:else if face === 'calling'}
          <g class="peek eyes"><rect class="eye" x="35" y="58" width="10" height="12" rx="2" /><rect class="eye" x="55" y="58" width="10" height="12" rx="2" /><rect class="eye" x="47" y="75" width="6" height="5" rx="1.5" /></g>
        {:else if face === 'happy'}
          <path class="ink" d="M35 69 l4.5 -5 l4.5 5 M56 69 l4.5 -5 l4.5 5" />
          <path class="ink" d="M44 77 l6 3.5 l6 -3.5" />
          <path class="t-stroke spark" d="M14 14 l-5 -5 M50 8 v-6 M86 14 l5 -5" />
        {:else if face === 'worried'}
          <path class="ink thin" d="M33 60 l9 -3 M67 60 l-9 -3" />
          <rect class="eye" x="36" y="64" width="6" height="7" rx="1.5" /><rect class="eye" x="58" y="64" width="6" height="7" rx="1.5" />
          <path class="ink thin" d="M42 80 l4 -2.5 l4 2.5 l4 -2.5 l4 2.5" />
          <path class="t-stroke" d="M92 18 v9 M92 33 v0.5" />
        {/if}
      </g>
    {/key}

    {#if busy && mood === 'working'}
      <rect class="t-fill drip" x="97" y="20" width="5" height="7" rx="2.5" />
    {/if}

    {#if music}
      {#key wide}
        <g class="phones">
          {#if wide}
            <path class="band under" d="M0 56 V46 C0 10 100 10 100 46 V56" />
            <path class="band" d="M0 56 V46 C0 10 100 10 100 46 V56" />
            <rect class="cup" x="-5" y="46" width="9" height="20" rx="3" /><rect class="cup" x="96" y="46" width="9" height="20" rx="3" />
          {:else}
            <path class="band under" d="M13 54 V40 C13 2 87 2 87 40 V54" />
            <path class="band" d="M13 54 V40 C13 2 87 2 87 40 V54" />
            <rect class="cup" x="8" y="42" width="9" height="20" rx="3" /><rect class="cup" x="83" y="42" width="9" height="20" rx="3" />
          {/if}
        </g>
      {/key}
    {/if}
  </g>

  {#if notes}
    <g class="notes" transform="translate({wide ? 102 : 92} {wide ? 14 : 8})">
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
    --tone: var(--color-foreground);
  }
  .char.s-working { --tone: var(--color-live); }
  .char.s-calling { --tone: var(--color-accent); }
  .char.s-happy { --tone: var(--color-success); }
  .char.s-worried { --tone: var(--color-danger); }

  .box, .lidbox { fill: var(--color-surface); stroke: var(--fg); stroke-width: 6; stroke-linejoin: round; }
  .bar { fill: var(--fg); }
  .led { fill: var(--tone); }
  .eye { fill: var(--fg); }
  .ink { fill: none; stroke: var(--fg); stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; }
  .ink.thin { stroke-width: 3.5; }
  .t-stroke { fill: none; stroke: var(--tone); stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round; }
  .t-fill { fill: var(--tone); }
  .z { fill: var(--fg); font: 600 12px var(--font-sans, sans-serif); }
  /* Two-tone headphones like the box (stroke and a surface rim): readable on light and dark. */
  .band { fill: none; stroke: var(--fg); stroke-width: 5; stroke-linecap: round; }
  .band.under { stroke: var(--color-surface); stroke-width: 10; }
  .cup { fill: var(--fg); stroke: var(--color-surface); stroke-width: 3; paint-order: stroke; }
  .note rect { fill: var(--fg); }
  .note path { fill: none; stroke: var(--fg); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  /* What sticks out of the box is drawn over the wallpaper: a rim keeps it readable. */
  .notes, .z, .spark, .drip, .t-stroke { filter: drop-shadow(0 0 1.2px var(--color-surface)) drop-shadow(0 0 1.2px var(--color-surface)); }

  /* Geometry: as tall as the icon, wider when something happens, the lid open when needed. */
  .box, .bar, .lidbox, .led {
    transition:
      x var(--dur-3) var(--ease-out-quint), y var(--dur-3) var(--ease-out-quint),
      width var(--dur-3) var(--ease-out-quint), height var(--dur-3) var(--ease-out-quint),
      opacity var(--dur-2) var(--ease-out-quint), fill var(--dur-2) var(--ease-out-quint);
  }
  .box { x: 18px; y: 16px; width: 64px; height: 72px; rx: 7px; }
  .bar { x: 18px; y: 41px; width: 64px; height: 6px; }
  .lidbox { x: 18px; y: 16px; width: 64px; height: 28px; rx: 7px; opacity: 0; }
  .led { x: 26px; y: 23px; width: 13px; height: 13px; rx: 2px; }

  .wide .box { x: 4px; y: 26px; width: 92px; height: 60px; }
  .wide .bar { x: 4px; y: 47px; width: 92px; }
  .wide .lidbox { x: 4px; y: 26px; width: 92px; height: 24px; }
  .wide .led { x: 12px; y: 31.5px; width: 12px; height: 12px; }

  .open .bar { opacity: 0; }
  .open .lidbox { opacity: 1; }
  .open:not(.wide) .box { y: 44px; height: 44px; }
  .wide.open .box { y: 50px; height: 36px; }

  .rig { transform-box: fill-box; transform-origin: 50% 100%; }
  .lid { transform-box: fill-box; transform-origin: 0% 100%; }
  .layer { animation: fade-in var(--dur-2) var(--ease-out-quint); }
  .eyes { transform-box: fill-box; transform-origin: 50% 50%; transition: scale var(--dur-2) var(--ease-out-quint); }
  .hover .eyes { scale: 1.12; }

  /* Body */
  .s-idle .rig { animation: breathe 4s ease-in-out infinite; }
  .s-idle.groove .rig { animation: groove .5s ease-in-out infinite alternate; }
  .s-working .rig { animation: hum 1.4s ease-in-out infinite; }
  .s-happy .rig { animation: hop 1.2s ease-in-out infinite; }
  .s-worried .rig { animation: shiver .3s linear infinite; }
  .boing .rig { animation: boing .65s ease-out; }

  /* Lid */
  .s-calling .lid { animation: flap 1.3s ease-in-out infinite; }
  .yawn .lid { animation: yawn-lid 2.2s ease-in-out; }
  .boing .lid { animation: pop .65s ease-out; }

  /* Light and details */
  .s-working .led { animation: slide 1.4s ease-in-out infinite alternate; }
  .busy .led { animation-duration: .7s; }
  .follow { animation: follow 1.4s ease-in-out infinite alternate; }
  .busy .follow { animation-duration: .7s; }
  .s-calling .led, .s-worried .led { animation: beacon .7s ease-in-out infinite alternate; }
  .blink { animation: blink 4s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 50%; }
  .peek { animation: peek 1.3s ease-in-out infinite; }
  .zz { animation: zz 3s ease-in-out infinite; }
  .spark { animation: spark 1.2s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 50%; }
  .dots rect { animation: dot 1.2s ease-in-out infinite; }
  .dots rect:nth-child(2) { animation-delay: .2s; }
  .dots rect:nth-child(3) { animation-delay: .4s; }
  .drip { animation: drip 1.1s ease-in infinite; }
  .note { animation: float 2s ease-out infinite; opacity: 0; }
  .note.n2 { animation-delay: 1s; }
  .phones { animation: fade-in var(--dur-3) var(--ease-out-quint); }

  @keyframes fade-in { from { opacity: 0; } }
  @keyframes breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.015, 1.035); } }
  @keyframes groove { from { transform: rotate(-4deg) translateY(0); } to { transform: rotate(4deg) translateY(-1.5px); } }
  @keyframes hum { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }
  @keyframes hop {
    0%, 100% { transform: translateY(0) scale(1, 1); }
    30% { transform: translateY(-9px) scale(.98, 1.03); }
    52% { transform: translateY(0) scale(1.05, .95); }
    68% { transform: translateY(0) scale(1, 1); }
  }
  @keyframes shiver { 0%, 100% { transform: translateX(0) rotate(-2deg); } 25% { transform: translateX(-1px) rotate(-2deg); } 75% { transform: translateX(1px) rotate(-2deg); } }
  @keyframes boing { 0% { transform: scale(1, 1); } 25% { transform: scale(1.08, .88); } 55% { transform: scale(.95, 1.08); } 80% { transform: scale(1.02, .98); } 100% { transform: scale(1, 1); } }
  @keyframes flap { 0%, 100% { transform: rotate(0); } 35% { transform: rotate(-26deg); } 60% { transform: rotate(-14deg); } 80% { transform: rotate(-22deg); } }
  @keyframes yawn-lid { 0%, 100% { transform: rotate(0); } 30%, 70% { transform: rotate(-16deg); } }
  @keyframes pop { 0%, 100% { transform: rotate(0); } 30% { transform: rotate(-30deg); } 60% { transform: rotate(-8deg); } }
  @keyframes slide { from { transform: translateX(0); } to { transform: translateX(64px); } }
  @keyframes follow { from { transform: translateX(-2px); } to { transform: translateX(4px); } }
  @keyframes beacon { from { opacity: 1; } to { opacity: .3; } }
  @keyframes blink { 0%, 90%, 100% { transform: scaleY(1); } 94% { transform: scaleY(.1); } }
  @keyframes peek { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(2px); } }
  @keyframes zz { 0% { transform: translate(0, 0); opacity: 0; } 25% { opacity: .9; } 100% { transform: translate(6px, -10px); opacity: 0; } }
  @keyframes spark { 0%, 20% { opacity: 0; transform: scale(.5); } 40% { opacity: 1; transform: scale(1); } 75%, 100% { opacity: 0; transform: scale(1.1); } }
  @keyframes dot { 0%, 100% { opacity: .25; } 40% { opacity: 1; } }
  @keyframes drip { 0% { transform: translateY(0); opacity: 0; } 20% { opacity: 1; } 100% { transform: translateY(12px); opacity: 0; } }
  @keyframes float { 0% { transform: translate(0, 6px); opacity: 0; } 25% { opacity: 1; } 100% { transform: translate(8px, -14px); opacity: 0; } }

  @media (prefers-reduced-motion: reduce) {
    .char, .char * { animation: none !important; transition: none !important; }
    .note { opacity: 1; }
  }
</style>
