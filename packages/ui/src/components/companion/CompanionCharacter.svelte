<!--
  The companion: a small box with a lid, feet and a face. It knows its mood
  and a few flags, not Boite. Colours come from the theme (`app.css`).
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
  const blush = $derived(face === 'awake' || face === 'groove' || face === 'happy' || face === 'calling');
  const notes = $derived(music && (mood === 'idle' || mood === 'working' || mood === 'happy'));
</script>

<svg
  class="char s-{mood}"
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
    <rect class="foot" x="27" y="84" width="13" height="11" rx="4" />
    <rect class="foot" x="60" y="84" width="13" height="11" rx="4" />
    <rect class="body" x="16" y="36" width="68" height="52" rx="13" />
    <rect class="shade" x="21" y="40.5" width="58" height="4" rx="2" />

    {#if blush}
      <g class="cheeks"><ellipse cx="26.5" cy="67" rx="5" ry="3" /><ellipse cx="73.5" cy="67" rx="5" ry="3" /></g>
    {/if}

    {#key face}
      <g class="layer">
        {#if face === 'sleep'}
          <path class="ink" d="M31 58 q6 5 12 0 M57 58 q6 5 12 0" />
          <text class="z zz" x="82" y="18">z</text>
        {:else if face === 'awake'}
          <g class="eyes">
            <g class="blink"><ellipse class="eye" cx="37" cy="58" rx="5" ry="6.5" /><circle class="glint" cx="38.8" cy="55.6" r="1.7" /></g>
            <g class="blink"><ellipse class="eye" cx="63" cy="58" rx="5" ry="6.5" /><circle class="glint" cx="64.8" cy="55.6" r="1.7" /></g>
          </g>
          <path class="ink thin" d="M45 70 q5 4.5 10 0" />
        {:else if face === 'groove'}
          <path class="ink" d="M31 60 q6 -7 12 0 M57 60 q6 -7 12 0" />
          <path class="ink thin" d="M44 69 q6 6 12 0" />
        {:else if face === 'yawn'}
          <path class="ink" d="M31 57 h12 M57 57 h12" />
          <ellipse class="eye" cx="50" cy="71" rx="4.5" ry="5.5" />
        {:else if face === 'working'}
          <g class="follow eyes">
            <g class="blink"><ellipse class="eye" cx="37" cy="59" rx="4.5" ry="5" /><circle class="glint" cx="38.5" cy="57.2" r="1.4" /></g>
            <g class="blink"><ellipse class="eye" cx="63" cy="59" rx="4.5" ry="5" /><circle class="glint" cx="64.5" cy="57.2" r="1.4" /></g>
          </g>
          <path class="ink thin" d="M46 71 h8" />
        {:else if face === 'calling'}
          <g class="peek eyes"><ellipse class="eye" cx="37" cy="57" rx="6" ry="7.5" /><ellipse class="eye" cx="63" cy="57" rx="6" ry="7.5" /><circle class="glint" cx="39.2" cy="54.2" r="2.2" /><circle class="glint" cx="65.2" cy="54.2" r="2.2" /></g>
          <ellipse class="eye" cx="50" cy="72.5" rx="3" ry="3.5" />
          <path class="t-stroke shout" d="M95 28 v12 M95 47 v0.5" />
        {:else if face === 'happy'}
          <path class="ink" d="M31 60 q6 -7 12 0 M57 60 q6 -7 12 0" />
          <path class="eye" d="M42 66 q8 11 16 0 z" />
          <path class="t-stroke spark" d="M8 24 l-5 -4 M50 7 v-5 M92 24 l5 -4" />
        {:else if face === 'worried'}
          <path class="ink thin" d="M31 52 l11 -4 M69 52 l-11 -4" />
          <ellipse class="eye" cx="37" cy="60" rx="3.5" ry="4.5" /><ellipse class="eye" cx="63" cy="60" rx="3.5" ry="4.5" />
          <path class="ink thin" d="M41 73 l4.5 -2.5 l4.5 2.5 l4.5 -2.5 l4.5 2.5" />
          <path class="t-stroke" d="M93 30 v9 M93 45 v0.5" />
        {/if}
      </g>
    {/key}

    <g class="lid"><rect class="lidbox" x="11" y="24" width="78" height="16" rx="7" /><rect class="led" x="42" y="29.5" width="16" height="5" rx="2.5" /></g>

    {#if busy && mood === 'working'}
      <rect class="t-fill drip" x="89" y="36" width="5" height="7" rx="2.5" />
    {/if}

    {#if music}
      <g class="phones">
        <path class="band under" d="M8 62 V50 C8 6 92 6 92 50 V62" />
        <path class="band" d="M8 62 V50 C8 6 92 6 92 50 V62" />
        <rect class="cup" x="2" y="48" width="11" height="22" rx="4" /><rect class="cup" x="87" y="48" width="11" height="22" rx="4" />
      </g>
    {/if}
  </g>

  {#if notes}
    <g class="notes" transform="translate(92 6)">
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

  .body, .lidbox { fill: var(--color-surface); stroke: var(--fg); stroke-width: 4.5; stroke-linejoin: round; }
  /* The lid's shadow on the box, the depth that makes it read as a box. */
  .shade { fill: var(--fg); opacity: .16; }
  .foot { fill: var(--fg); }
  .led { fill: var(--tone); }
  .eye { fill: var(--fg); }
  .glint { fill: var(--color-surface); }
  .cheeks { fill: var(--color-danger); opacity: .55; animation: fade-in var(--dur-3) var(--ease-out-quint); }
  :global([data-theme='light']) .cheeks { opacity: .4; }
  .ink { fill: none; stroke: var(--fg); stroke-width: 4.5; stroke-linecap: round; stroke-linejoin: round; }
  .ink.thin { stroke-width: 3.5; }
  .t-stroke { fill: none; stroke: var(--tone); stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }
  .t-fill { fill: var(--tone); }
  .z { fill: var(--fg); font: 600 13px var(--font-sans, sans-serif); }
  /* Two-tone headphones like the box (stroke and a surface rim): readable on light and dark. */
  .band { fill: none; stroke: var(--fg); stroke-width: 5; stroke-linecap: round; }
  .band.under { stroke: var(--color-surface); stroke-width: 10; }
  .cup { fill: var(--fg); stroke: var(--color-surface); stroke-width: 3; paint-order: stroke; }
  .note rect { fill: var(--fg); }
  .note path { fill: none; stroke: var(--fg); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  /* What sticks out of the box is drawn over the wallpaper: a rim keeps it readable. */
  .notes, .z, .spark, .drip, .t-stroke, .foot { filter: drop-shadow(0 0 1.2px var(--color-surface)) drop-shadow(0 0 1.2px var(--color-surface)); }
  .body, .lidbox { filter: drop-shadow(0 1.5px 2px rgb(0 0 0 / .35)); }

  .rig { transform-box: fill-box; transform-origin: 50% 100%; }
  .lid { transform-box: fill-box; transform-origin: 0% 100%; }
  .led { transition: fill var(--dur-2) var(--ease-out-quint); }
  .layer { animation: fade-in var(--dur-2) var(--ease-out-quint); }
  .eyes { transform-box: fill-box; transform-origin: 50% 50%; transition: scale var(--dur-2) var(--ease-out-quint); }
  .hover .eyes { scale: 1.1; }

  /* Body */
  .s-idle .rig { animation: breathe 4s ease-in-out infinite; }
  .s-idle.groove .rig { animation: groove .5s ease-in-out infinite alternate; }
  .s-working .rig { animation: hum 1.4s ease-in-out infinite; }
  .s-happy .rig { animation: hop 1.2s ease-in-out infinite; }
  .s-worried .rig { animation: shiver .3s linear infinite; }
  .boing .rig { animation: boing .65s ease-out; }

  /* Lid */
  .s-calling .lid { animation: flap 1.3s ease-in-out infinite; }
  .s-happy .lid { animation: tip 1.2s ease-in-out infinite; }
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
  .shout { animation: beacon .7s ease-in-out infinite alternate; }
  .zz { animation: zz 3s ease-in-out infinite; }
  .spark { animation: spark 1.2s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 50%; }
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
  @keyframes flap { 0%, 100% { transform: rotate(0); } 35% { transform: rotate(-24deg); } 60% { transform: rotate(-12deg); } 80% { transform: rotate(-20deg); } }
  @keyframes tip { 0%, 25%, 70%, 100% { transform: rotate(0); } 40% { transform: rotate(-10deg); } }
  @keyframes yawn-lid { 0%, 100% { transform: rotate(0); } 30%, 70% { transform: rotate(-14deg); } }
  @keyframes pop { 0%, 100% { transform: rotate(0); } 30% { transform: rotate(-28deg); } 60% { transform: rotate(-8deg); } }
  @keyframes slide { from { transform: translateX(-24px); } to { transform: translateX(24px); } }
  @keyframes follow { from { transform: translateX(-3px); } to { transform: translateX(3px); } }
  @keyframes beacon { from { opacity: 1; } to { opacity: .3; } }
  @keyframes blink { 0%, 90%, 100% { scale: 1 1; } 94% { scale: 1 .1; } }
  @keyframes peek { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(2px); } }
  @keyframes zz { 0% { transform: translate(0, 0); opacity: 0; } 25% { opacity: .9; } 100% { transform: translate(6px, -10px); opacity: 0; } }
  @keyframes spark { 0%, 20% { opacity: 0; transform: scale(.5); } 40% { opacity: 1; transform: scale(1); } 75%, 100% { opacity: 0; transform: scale(1.1); } }
  @keyframes drip { 0% { transform: translateY(0); opacity: 0; } 20% { opacity: 1; } 100% { transform: translateY(12px); opacity: 0; } }
  @keyframes float { 0% { transform: translate(0, 6px); opacity: 0; } 25% { opacity: 1; } 100% { transform: translate(8px, -14px); opacity: 0; } }

  @media (prefers-reduced-motion: reduce) {
    .char, .char * { animation: none !important; transition: none !important; }
    .note { opacity: 1; }
  }
</style>
