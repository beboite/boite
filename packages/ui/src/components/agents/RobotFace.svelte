<script lang="ts">
  import { LOCO_DARK, robotColor, type Robot } from '../../lib/robots';

  /**
   * One robot, drawn in a 64 unit square that its holder crops to a disc. The
   * colors are app.css tokens: `--robot-<n>` gives the body, the background is
   * that color washed out, the trim that color darkened. `state` moves the
   * face: a blink at rest, a glance from side to side while it works, a hop
   * while it waits on the user. `still` draws it without motion, for pickers.
   */
  let { robot, state = 'idle' }: { robot: Robot; state?: 'idle' | 'working' | 'waiting' | 'still' } = $props();

  const INK = 'var(--robot-ink)';
  const tilt = $derived(robot.family === 'capsule' ? 'rotate(-11 32 36) translate(3 6)' : undefined);
  /** The retro head's box, which the screen, the ears and the antenna follow. */
  const head = $derived([
    { x: 11, y: 16, w: 42, h: 36, r: 11 },
    { x: 10, y: 13, w: 44, h: 42, r: 21 },
    { x: 14, y: 12, w: 36, h: 42, r: 11 },
    { x: 7, y: 19, w: 50, h: 32, r: 11 },
  ][robot.shape] ?? { x: 11, y: 16, w: 42, h: 36, r: 11 });
  const screen = $derived({ x: head.x + 5, y: head.y + 6, w: head.w - 10, h: Math.min(head.h - 15, 22) });
  const sy = $derived(screen.y + screen.h / 2);
  const lx = $derived(32 - screen.w / 4.2);
  const rx = $derived(32 + screen.w / 4.2);

  /*
   * LocoRoco, after the games' art: one flat blob with no outline or shine,
   * two small white eyes with brown pupils set off-centre near the top, a thin
   * smile or a round singing mouth, and a flick of the body's own colour.
   */
  const locoBody = [
    'M32 15 C46 15 55 25 55 38 C55 52 45 61 32 61 C18 61 9 52 9 38 C9 24 19 15 32 15Z',
    'M32 21 C48 21 58 29 58 40 C58 52 47 59 32 59 C17 59 6 52 6 40 C6 29 16 21 32 21Z',
    'M32 12 C44 12 52 25 52 39 C52 52 43 61 32 61 C21 61 12 52 12 39 C12 25 20 12 32 12Z',
    'M10 40 C9 26 19 17 31 17 C45 17 56 25 55 39 C55 53 46 60 32 60 C18 60 11 52 10 40Z',
  ];
  const locoTop = $derived([15, 21, 12, 17][robot.shape] ?? 15);
  /** The face sits right of centre, the way the games turn them. */
  const fx = 36;
  const fy = $derived(locoTop + 13);
  /** Where each expression's pupils look. */
  const look = $derived([{ x: 1.2, y: -1.2 }, { x: 0.2, y: -1.8 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: -1.7, y: 0.3 }][robot.eyes] ?? { x: 0, y: 0 });
  const dark = $derived(robot.family === 'loco' && robot.color === LOCO_DARK);
</script>

<svg viewBox="0 0 64 64" class="robot" class:dark data-family={robot.family} data-state={state} style:--rb={robotColor(robot)} aria-hidden="true">
  <rect class={robot.family === 'capsule' ? 'base' : 'soft'} width="64" height="64" />
  <g class="whole">
    <g transform={tilt}>
      {#if robot.family === 'loco'}
        <!-- Behind the body: the flick, of the body's own colour. -->
        {#if robot.top === 0}
          <path d="M33 {locoTop + 3} C33 {locoTop - 3} 37 {locoTop - 6} 41 {locoTop - 6}" fill="none" class="stroke-base" stroke-width="3.2" stroke-linecap="round" />
          <ellipse cx="43" cy={locoTop - 7} rx="4.2" ry="2.8" class="base" transform="rotate(-25 43 {locoTop - 7})" />
        {:else if robot.top === 1}
          <path d="M27 {locoTop + 3} C26 {locoTop - 3} 22 {locoTop - 6} 18 {locoTop - 5} M39 {locoTop + 3} C40 {locoTop - 3} 44 {locoTop - 6} 48 {locoTop - 5}" fill="none" class="stroke-base" stroke-width="3" stroke-linecap="round" />
          <circle cx="17" cy={locoTop - 5} r="3" class="base" /><circle cx="49" cy={locoTop - 5} r="3" class="base" />
        {:else if robot.top === 2}
          <path d="M32 {locoTop + 3} C30 {locoTop - 5} 39 {locoTop - 9} 40 {locoTop - 3} C40.6 {locoTop + 1} 35 {locoTop + 1} 36 {locoTop - 3}" fill="none" class="stroke-base" stroke-width="3" stroke-linecap="round" />
        {:else if robot.top === 3}
          <path d="M33 {locoTop + 3} L33 {locoTop - 4}" class="stroke-leaf" stroke-width="2.2" stroke-linecap="round" />
          <path d="M33 {locoTop - 3} C28 {locoTop - 10} 22 {locoTop - 7} 23 {locoTop - 3} C26 {locoTop - 1} 30 {locoTop - 1} 33 {locoTop - 3}Z" class="leaf" />
          <path d="M33 {locoTop - 5} C37 {locoTop - 12} 44 {locoTop - 10} 43 {locoTop - 6} C40 {locoTop - 3} 36 {locoTop - 3} 33 {locoTop - 5}Z" class="leaf light" />
        {/if}
        <path d={locoBody[robot.shape] ?? locoBody[0]} class="base" />
        <g class="eyes">
          {#if robot.eyes === 3}
            <path d="M{fx - 9.5} {fy + 1} q3.5 -4.5 7 0 M{fx + 1.5} {fy} q3.5 -4.5 7 0" fill="none" class="loco-ink" stroke-width="2.3" stroke-linecap="round" />
          {:else}
            {@const big = robot.eyes === 2 ? 1.15 : 1}
            <circle cx={fx - 6} cy={fy} r={4 * big} class="white" /><circle cx={fx + 5} cy={fy - 1} r={4.5 * big} class="white" />
            <circle cx={fx - 6 + look.x} cy={fy + look.y} r={robot.eyes === 2 ? 1.6 : 2.1} class="pupil" /><circle cx={fx + 5 + look.x} cy={fy - 1 + look.y} r={robot.eyes === 2 ? 1.7 : 2.3} class="pupil" />
          {/if}
        </g>
        {#if robot.eyes === 0}<path d="M{fx - 8} {fy + 8} Q{fx - 1} {fy + 14} {fx + 6} {fy + 7}" fill="none" class="mouth" stroke-width="1.9" stroke-linecap="round" />
        {:else if robot.eyes === 1}<ellipse cx={fx - 1} cy={fy + 11} rx="3.6" ry="4.4" class="mouth-fill" /><ellipse cx={fx - 1} cy={fy + 12.4} rx="2.1" ry="2.2" class="tongue" />
        {:else if robot.eyes === 2}<circle cx={fx - 1} cy={fy + 10} r="2.2" class="mouth-fill" />
        {:else if robot.eyes === 3}<path d="M{fx - 9} {fy + 6} Q{fx - 1} {fy + 18} {fx + 7} {fy + 6} Z" class="mouth-fill" /><path d="M{fx - 5} {fy + 11.5} Q{fx - 1} {fy + 15} {fx + 3} {fy + 11.5} Z" class="tongue" />
        {:else}<path d="M{fx - 6} {fy + 9} Q{fx - 1} {fy + 11} {fx + 4} {fy + 7}" fill="none" class="mouth" stroke-width="1.9" stroke-linecap="round" />{/if}

      {:else if robot.family === 'bubble'}
        <!-- Behind the body: what grows out of its top. -->
        {#if robot.top === 1}
          <line x1="32" y1="18" x2="32" y2="8" class="stroke-deep" stroke-width="2.4" stroke-linecap="round" /><circle class="deep led" cx="32" cy="7" r="3.6" />
        {:else if robot.top === 2}
          <path d="M32 19 C32 13 32 11 32 9" class="stroke-leaf" stroke-width="2.2" fill="none" stroke-linecap="round" />
          <path d="M32 12 C26 5 20 8 21 12 C24 14 29 14 32 12Z" class="leaf" /><path d="M32 10 C37 3 44 5 43 9 C40 12 35 12 32 10Z" class="leaf light" />
        {:else if robot.top === 4}
          <path d="M9 40 C9 14 55 14 55 40" fill="none" class="stroke-ink" stroke-width="3.2" />
        {/if}
        <g class="base">
          {#if robot.shape === 0}<circle cx="32" cy="42" r="25" />
          {:else if robot.shape === 1}<path d="M32 13 C46 24 57 34 57 47 C57 61 45 72 32 72 C19 72 7 61 7 47 C7 34 18 24 32 13Z" />
          {:else if robot.shape === 2}<rect x="13" y="15" width="38" height="62" rx="19" />
          {:else}<rect x="9" y="18" width="46" height="56" rx="17" />{/if}
        </g>
        <ellipse class="shine" cx="22" cy="28" rx="7" ry="4.5" transform="rotate(-30 22 28)" />
        <ellipse class="blush" cx="17" cy="48" rx="3.6" ry="2.2" /><ellipse class="blush" cx="47" cy="48" rx="3.6" ry="2.2" />
        <g class="eyes">
          {#if robot.eyes === 0}<circle cx="24.5" cy="41" r="3.3" fill={INK} /><circle cx="39.5" cy="41" r="3.3" fill={INK} />
          {:else if robot.eyes === 1}<rect x="21.8" y="36" width="5.4" height="10" rx="2.7" fill={INK} /><rect x="36.8" y="36" width="5.4" height="10" rx="2.7" fill={INK} />
          {:else if robot.eyes === 2}
            <circle class="white" cx="24" cy="41" r="6" /><circle class="white" cx="40" cy="41" r="6" />
            <circle cx="25" cy="41.8" r="3.1" fill={INK} /><circle cx="41" cy="41.8" r="3.1" fill={INK} />
            <circle class="white" cx="26.2" cy="40.4" r="1" /><circle class="white" cx="42.2" cy="40.4" r="1" />
          {:else if robot.eyes === 3}<path d="M20.5 42.5 q4 -6 8 0 M35.5 42.5 q4 -6 8 0" fill="none" class="stroke-ink" stroke-width="2.6" stroke-linecap="round" />
          {:else}<path d="M20.5 41 q4 3.5 8 0 M35.5 41 q4 3.5 8 0" fill="none" class="stroke-ink" stroke-width="2.4" stroke-linecap="round" />{/if}
        </g>
        <!-- Over the body: what it wears. -->
        {#if robot.top === 3}
          <path d="M12 30 C12 14 52 14 52 30 Z" class="deep" /><rect x="10" y="27" width="44" height="6" rx="3" class="soft" /><circle cx="32" cy="13" r="4" class="soft" />
        {:else if robot.top === 4}
          <rect x="4" y="34" width="9" height="15" rx="4.5" fill={INK} /><rect x="51" y="34" width="9" height="15" rx="4.5" fill={INK} />
        {:else if robot.top === 5}
          <circle cx="24.5" cy="41" r="7.2" class="lens" /><circle cx="39.5" cy="41" r="7.2" class="lens" /><path d="M31.7 41 h0.6" class="stroke-ink" stroke-width="2" />
        {:else if robot.top === 6}
          <path d="M32 22 L22 16 Q19 22 22 28 Z M32 22 L42 16 Q45 22 42 28 Z" class="bow" /><circle cx="32" cy="22" r="3.2" class="bow knot" />
        {/if}

      {:else if robot.family === 'capsule'}
        {#if robot.top === 1}
          <line x1="32" y1="11" x2="35" y2="2" class="stroke-ink" stroke-width="2.4" stroke-linecap="round" /><circle class="deep led" cx="35.5" cy="2.5" r="3.6" />
        {:else if robot.top === 2}
          <rect x="2" y="28" width="8" height="14" rx="4" class="deep" /><rect x="54" y="28" width="8" height="14" rx="4" class="deep" />
        {:else if robot.top === 3}
          <path d="M26 12 C26 4 34 3 36 8 C38 3 45 6 41 13" class="deep" />
        {:else if robot.top === 4}
          <ellipse cx="32" cy="5" rx="14" ry="3.4" fill="none" class="stroke-halo" stroke-width="2.6" />
        {:else if robot.top === 5}
          <path d="M7 36 C7 6 57 6 57 36" fill="none" class="stroke-ink" stroke-width="3" />
          <rect x="1" y="30" width="9" height="15" rx="4.5" class="deep" /><rect x="54" y="30" width="9" height="15" rx="4.5" class="deep" />
        {/if}
        <g class="face">
          {#if robot.shape === 0}<circle cx="32" cy="36" r="26" />
          {:else if robot.shape === 1}<ellipse cx="32" cy="37" rx="23" ry="27" />
          {:else if robot.shape === 2}<rect x="7" y="12" width="50" height="50" rx="18" />
          {:else}<path d="M10 34 C10 14 54 12 56 32 C58 50 48 62 32 62 C16 62 10 52 10 34Z" />{/if}
        </g>
        <ellipse class="blush" cx="16" cy="43" rx="4.4" ry="2.6" /><ellipse class="blush" cx="48" cy="43" rx="4.4" ry="2.6" />
        <g class="eyes">
          {#if robot.eyes === 0}<rect x="21" y="26.5" width="6" height="13" rx="3" fill={INK} /><rect x="37" y="26.5" width="6" height="13" rx="3" fill={INK} />
          {:else if robot.eyes === 1}<circle cx="24" cy="33" r="3.6" fill={INK} /><circle cx="40" cy="33" r="3.6" fill={INK} />
          {:else if robot.eyes === 2}<rect x="21" y="26.5" width="6" height="13" rx="3" fill={INK} /><path d="M36.5 34 q3.5 -5 7 0" fill="none" class="stroke-ink" stroke-width="2.8" stroke-linecap="round" />
          {:else if robot.eyes === 3}<path d="M20.5 35 q3.5 -6 7 0 M36.5 35 q3.5 -6 7 0" fill="none" class="stroke-ink" stroke-width="2.8" stroke-linecap="round" />
          {:else}
            <path d="M24 27 l1.9 4.1 4.4 .5 -3.3 3 .9 4.4 -3.9 -2.2 -3.9 2.2 .9 -4.4 -3.3 -3 4.4 -.5Z" fill={INK} />
            <path d="M40 27 l1.9 4.1 4.4 .5 -3.3 3 .9 4.4 -3.9 -2.2 -3.9 2.2 .9 -4.4 -3.3 -3 4.4 -.5Z" fill={INK} />
          {/if}
        </g>

      {:else}
        <!-- Retro: a head with a dark screen, the eyes lit on it. -->
        {#if robot.top === 0}
          <line x1="32" y1={head.y} x2="32" y2={head.y - 8} class="stroke-deep" stroke-width="2.4" /><circle class="bulb led" cx="32" cy={head.y - 9} r="3.4" />
        {:else if robot.top === 1}
          <line x1="24" y1={head.y} x2="20" y2={head.y - 8} class="stroke-deep" stroke-width="2.2" /><line x1="40" y1={head.y} x2="44" y2={head.y - 8} class="stroke-deep" stroke-width="2.2" />
          <circle class="halo led" cx="19.5" cy={head.y - 9} r="2.8" /><circle class="halo led" cx="44.5" cy={head.y - 9} r="2.8" />
        {:else if robot.top === 2}
          <line x1="32" y1={head.y} x2="32" y2={head.y - 6} class="stroke-deep" stroke-width="2.4" />
          <ellipse cx="24.5" cy={head.y - 7} rx="7.5" ry="2.2" class="deep" /><ellipse cx="39.5" cy={head.y - 7} rx="7.5" ry="2.2" class="deep" /><circle cx="32" cy={head.y - 7} r="2.2" fill={INK} />
        {/if}
        <rect x="20" y={head.y + head.h - 2} width="24" height="30" rx="7" class="deep" />
        <rect x={head.x - 5} y={head.y + head.h / 2 - 6} width="7" height="12" rx="3" class="deep" />
        <rect x={head.x + head.w - 2} y={head.y + head.h / 2 - 6} width="7" height="12" rx="3" class="deep" />
        <rect x={head.x} y={head.y} width={head.w} height={head.h} rx={head.r} class="base" />
        <rect x={screen.x} y={screen.y} width={screen.w} height={screen.h} rx="6" class="screen" />
        {#if head.h - (screen.y - head.y) - screen.h > 8}<path d="M27 {screen.y + screen.h + 4.5} h10" class="stroke-deep" stroke-width="2" stroke-linecap="round" />{/if}
        <ellipse cx={head.x + 9} cy={head.y + 4} rx="5" ry="2" class="shine" />
        <g class="eyes lit">
          {#if robot.eyes === 0}<circle cx={lx} cy={sy} r="3.2" /><circle cx={rx} cy={sy} r="3.2" />
          {:else if robot.eyes === 1}<rect x={lx - 2.5} y={sy - 5} width="5" height="10" rx="2.5" /><rect x={rx - 2.5} y={sy - 5} width="5" height="10" rx="2.5" />
          {:else if robot.eyes === 2}<path d="M{lx - 3.5} {sy + 2} q3.5 -6 7 0 M{rx - 3.5} {sy + 2} q3.5 -6 7 0" fill="none" class="stroke-led" stroke-width="2.6" stroke-linecap="round" />
          {:else if robot.eyes === 3}<rect x={32 - screen.w / 3} y={sy - 3} width={screen.w / 1.5} height="6" rx="3" />
          {:else}
            <path d="M{lx} {sy + 3.5} l-4 -4 a2.3 2.3 0 0 1 4 -2.6 a2.3 2.3 0 0 1 4 2.6Z" class="heart" />
            <path d="M{rx} {sy + 3.5} l-4 -4 a2.3 2.3 0 0 1 4 -2.6 a2.3 2.3 0 0 1 4 2.6Z" class="heart" />
          {/if}
        </g>
      {/if}
    </g>
  </g>
</svg>

<style>
  .robot { display: block; width: 100%; height: 100%; }
  .base { fill: var(--rb); }
  .soft { fill: color-mix(in srgb, var(--rb) 30%, var(--robot-shine)); }
  .deep { fill: color-mix(in srgb, var(--rb) 72%, var(--robot-ink)); }
  .stroke-deep { stroke: color-mix(in srgb, var(--rb) 72%, var(--robot-ink)); }
  .stroke-ink { stroke: var(--robot-ink); }
  .stroke-leaf { stroke: color-mix(in srgb, var(--robot-leaf) 75%, var(--robot-ink)); }
  .stroke-halo { stroke: var(--robot-halo); }
  .stroke-led { stroke: var(--robot-led); }
  .face { fill: var(--robot-face); }
  .white { fill: var(--robot-shine); }
  .shine { fill: var(--robot-shine); opacity: 0.3; }
  .blush { fill: var(--robot-blush); opacity: 0.5; }
  .leaf { fill: var(--robot-leaf); }
  .leaf.light { fill: color-mix(in srgb, var(--robot-leaf) 70%, var(--robot-shine)); }
  .lens { fill: color-mix(in srgb, var(--robot-shine) 35%, transparent); stroke: var(--robot-ink); stroke-width: 2; }
  .bow { fill: var(--robot-blush); }
  .bow.knot { fill: color-mix(in srgb, var(--robot-blush) 80%, var(--robot-ink)); }
  .bulb { fill: var(--robot-bulb); }
  .halo { fill: var(--robot-halo); }
  .screen { fill: var(--robot-screen); }
  .lit { fill: var(--robot-led); }
  .heart { fill: var(--robot-blush); }
  [data-family='loco'] .soft { fill: color-mix(in srgb, var(--rb) 22%, var(--robot-shine)); }
  .stroke-base { stroke: var(--rb); }
  .pupil { fill: var(--loco-pupil); }
  .loco-ink { stroke: var(--loco-ink); }
  .mouth { stroke: var(--loco-ink); }
  .mouth-fill { fill: var(--loco-ink); }
  .tongue { fill: var(--robot-blush); }
  .dark .mouth, .dark .loco-ink { stroke: var(--robot-face); }
  .dark .mouth-fill { fill: var(--robot-face); }

  /* A blink at rest, a glance while working, a hop while it waits on the user. */
  .eyes { transform-box: fill-box; transform-origin: center; }
  [data-state='idle'] .eyes { animation: robot-blink 4.6s infinite; }
  [data-state='working'] .eyes { animation: robot-glance 2.4s ease-in-out infinite; }
  [data-state='working'] .led { animation: robot-pulse 1.2s ease-in-out infinite; }
  [data-state='waiting'] .whole { animation: robot-hop 1.8s ease-in-out infinite; }
  /* A LocoRoco at work squishes on the spot, the way they wobble in the games. */
  [data-family='loco'][data-state='working'] .whole { transform-origin: 32px 62px; animation: robot-squish 0.9s ease-in-out infinite; }
  @keyframes robot-squish { 0%, 100% { transform: scale(1, 1); } 40% { transform: scale(1.07, 0.93); } 70% { transform: scale(0.96, 1.04); } }
  @keyframes robot-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.12); } }
  @keyframes robot-glance { 0%, 20% { transform: translateX(0); } 30%, 50% { transform: translateX(-2.2px); } 60%, 80% { transform: translateX(2.2px); } 90%, 100% { transform: translateX(0); } }
  @keyframes robot-hop { 0%, 70%, 100% { transform: translateY(0); } 80% { transform: translateY(-3px); } 90% { transform: translateY(0.5px); } }
  @keyframes robot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) {
    .eyes, .led, .whole { animation: none !important; }
  }
  :global(html[data-motion='reduced']) .robot :is(.eyes, .led, .whole) { animation: none; }
</style>
