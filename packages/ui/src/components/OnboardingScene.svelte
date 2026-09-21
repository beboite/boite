<script lang="ts">
  import { Pause, RotateCcw } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  let { scene }: { scene: 'welcome' | 'agents' | 'voice' | 'panel' | 'usage' | 'reach' | 'quiet' | 'privacy' } = $props();
  let paused = $state(false);
  let replay = $state(0);
  const t = $derived(strings.onboarding.demo);
</script>

<figure data-testid="onboarding-scene" data-scene={scene} class:paused>
  {#key `${scene}-${replay}`}
    <svg class="wide" viewBox="0 0 560 264" role="img" aria-label={scene === 'voice' ? t.voiceHint : scene === 'usage' ? t.trayHint : scene === 'reach' ? t.reachHint : scene === 'panel' ? t.reviewed : scene === 'quiet' ? t.quietBody : t.continued}>
      {#if scene === 'welcome'}
        <path class="connector" d="M85 57v142m0-142h45M85 128h45M85 199h45" />
        <rect class="shield" x="58" y="106" width="54" height="44" rx="10" />
        <path class="accent-stroke" d="M72 116h26v24H72zm0 9h26m-20-4h4m-4 11h7" />
        {#each [{ name: t.task, agent: 'Claude' }, { name: t.secondTask, agent: 'Codex' }, { name: t.thirdTask, agent: 'Claude' }] as item, i (item.name)}
          <g class="slide" style:animation-delay={`${i * 180}ms`}>
            <rect class="window" x="132" y={29 + i * 71} width="366" height="56" rx="10" />
            <circle class={i === 1 ? 'meter' : 'accent'} cx="154" cy={49 + i * 71} r="4" />
            <text class="strong" x="168" y={53 + i * 71}>{item.name}</text>
            <text class="small muted" x="168" y={73 + i * 71}>{item.agent}</text>
            <text class="small muted" x="479" y={73 + i * 71} text-anchor="end">{i === 1 ? t.complete : t.working}</text>
          </g>
        {/each}
      {:else if scene === 'usage'}
        <rect class="window" x="125" y="18" width="310" height="174" rx="12" />
        <text class="strong" x="147" y="48">{t.usageLabel}</text>
        <text class="muted" x="147" y="79">{t.window}</text>
        <text class="strong" x="414" y="79" text-anchor="end">{t.used}</text>
        <rect class="track" x="147" y="95" width="266" height="8" rx="4" />
        <rect class="meter draw" x="147" y="95" width="64" height="8" rx="4" />
        <text class="muted" x="147" y="132">{t.reset}</text>
        <path class="line" d="M147 149H413" />
        <text class="small muted" x="147" y="173">{t.usageLabel} · 5 h · 24 %</text>
        <rect class="window" x="24" y="213" width="512" height="36" rx="8" />
        <rect class="track" x="40" y="225" width="92" height="10" rx="4" />
        <path class="line" d="m365 233 5-5 5 5 M390 225h14v14h-14z M390 230h14" />
        <rect class="accent-soft" x="383" y="219" width="29" height="25" rx="5" />
        <text class="muted" x="485" y="236" text-anchor="middle">14:32</text>
        <path class="cursor approach" d="m404 227 3 19 4-6 7-2z" />
        <path class="connector" d="M398 213V193" />
      {:else if scene === 'reach'}
        <rect class="window" x="26" y="30" width="310" height="186" rx="10" />
        <path class="line" d="M26 60H336 M160 216v19m-34 0h68" />
        <text class="small muted" x="43" y="50">{t.desktop}</text>
        <rect class="bubble" x="115" y="78" width="200" height="38" rx="8" />
        <text x="128" y="101">{t.task}</text>
        <path class="ink" d="M48 135h220m-220 15h175m-175 15h195" />
        <path class="connector" d="M337 127h51" />
        <circle class="signal" cx="349" cy="127" r="4" />
        <rect class="window" x="391" y="16" width="140" height="230" rx="19" />
        <rect class="track" x="443" y="24" width="36" height="5" rx="3" />
        <text class="small muted" x="461" y="54" text-anchor="middle">{t.phone}</text>
        <rect class="bubble appear" x="406" y="76" width="110" height="40" rx="8" />
        <path class="ink appear" d="M415 91h90m-90 10h70 M407 139h100m-100 13h78m-78 13h87" />
        <rect class="track" x="407" y="207" width="107" height="22" rx="6" />
        <text class="muted" x="180" y="256" text-anchor="middle">{t.synced}</text>
      {:else if scene === 'privacy'}
        <rect class="window" x="162" y="25" width="236" height="194" rx="16" />
        <path class="line" d="M162 62H398" />
        <circle class="accent" cx="185" cy="44" r="4" />
        <path class="ink" d="M202 44h94 M188 87h148m-148 18h112" />
        <path class="shield" d="m280 124 29 11v21c0 23-29 36-29 36s-29-13-29-36v-21z" />
        <path class="check draw" d="m266 155 10 10 18-21" />
        <path class="connector" d="M162 125h-38m274 0h38" />
        <circle class="track" cx="101" cy="125" r="18" />
        <circle class="track" cx="459" cy="125" r="18" />
      {:else if scene === 'quiet'}
        <rect class="window" x="35" y="24" width="490" height="216" rx="12" />
        <path class="line" d="M35 56H525" />
        <text class="small muted" x="53" y="46">{t.task}</text>
        <path class="ink" d="M65 91h190m-190 17h164m-164 17h180m-180 43h225m-225 17h186" />
        <rect class="bubble appear" x="275" y="171" width="231" height="52" rx="9" />
        <circle class="meter" cx="293" cy="196" r="5" />
        <text class="small" x="307" y="201">{t.notification}</text>
      {:else}
        <rect class="window" x="22" y="14" width="516" height="236" rx="12" />
        <path class="line" d="M22 48H538" />
        <circle class="accent" cx="42" cy="31" r="4" />
        <text class="small muted" x="57" y="36">{t.task}</text>
        {#if scene === 'panel'}
          <path class="line" d="M288 48V250" />
          <rect class="bubble" x="61" y="68" width="206" height="38" rx="8" />
          <text class="small" x="74" y="92">{t.request}</text>
          <path class="ink" d="M45 130h206m-206 16h178m-178 16h192" />
          <g class="slide">
            <text class="strong" x="307" y="76">{t.changes}</text>
            <text class="small muted" x="307" y="101">{t.file}</text>
            <rect class="removed" x="301" y="117" width="222" height="25" rx="4" />
            <rect class="added" x="301" y="146" width="222" height="54" rx="4" />
            <path class="ink" d="M313 130h8m9 0h120m-137 29h8m-4-4v8m13-4h158m-175 27h8m-4-4v8m13-4h136" />
          </g>
        {:else if scene === 'voice'}
          <path class="ink" d="M48 76h300m-300 17h220" />
          <g class="wave" transform="translate(160 117)">
            {#each [10, 23, 15, 34, 22, 38, 17, 29, 12, 25, 35, 18, 30, 16, 8] as height, i (i)}
              <rect class="accent sound" x={i * 16} y={-height / 2} width="4" height={height} rx="2" style:--beat={`${i * 70}ms`} />
            {/each}
          </g>
          <rect class="bubble" x="40" y="157" width="480" height="74" rx="10" />
          <text class="appear" x="56" y="186">{t.voiceWords}</text>
          <path class="accent-stroke" d="M488 197v9a5 5 0 0 1-10 0v-9a5 5 0 0 1 10 0zm-14 7v2a9 9 0 0 0 18 0v-2m-9 11v7m-5 0h10" />
        {:else}
          <rect class="bubble" x="184" y="64" width="332" height="35" rx="8" />
          <text x="198" y="87">{t.request}</text>
          <text class="small accent-text" x="43" y="122">Claude</text>
          <text x="43" y="145">{t.answer}</text>
          <g class="appear">
            <rect class="bubble" x="184" y="164" width="332" height="35" rx="8" />
            <text x="198" y="187">{t.followup}</text>
          </g>
          <rect class="track" x="40" y="211" width="480" height="26" rx="7" />
          <g class="first-agent"><text class="small" x="55" y="229">Claude</text></g>
          <g class="next-agent"><text class="small accent-text" x="55" y="229">Codex</text></g>
          <path class="line" d="m115 221 4 4 4-4" />
          <path class="cursor approach" d="m101 226 3 19 4-6 7-2z" />
          <g class="picker">
            <rect class="window" x="40" y="129" width="120" height="77" rx="8" />
            <text class="small" x="55" y="155">Claude</text>
            <rect class="accent-soft" x="46" y="167" width="108" height="29" rx="5" />
            <text class="small" x="55" y="187">Codex</text>
          </g>
        {/if}
      {/if}
    </svg>
    <svg class="compact" viewBox="0 0 340 264" role="img" aria-label={scene === 'usage' ? `${t.window}, ${t.used}, ${t.reset}` : scene === 'reach' ? t.synced : scene === 'voice' ? t.voiceHint : t.continued}>
      {#if scene === 'usage'}
        <rect class="window" x="16" y="15" width="308" height="171" rx="12" />
        <text class="strong" x="34" y="45">{t.usageLabel}</text>
        <text x="34" y="78">{t.window}</text><text class="strong" x="306" y="78" text-anchor="end">{t.used}</text>
        <rect class="track" x="34" y="95" width="272" height="8" rx="4" /><rect class="meter draw" x="34" y="95" width="65" height="8" rx="4" />
        <text class="muted" x="34" y="135">{t.reset}</text>
        <path class="connector" d="M251 186v32" />
        <rect class="window" x="6" y="217" width="328" height="35" rx="8" />
        <rect class="accent-soft" x="235" y="221" width="28" height="27" rx="4" />
        <path class="accent-stroke" d="M241 226h14v16h-14zm0 6h14" />
        <text class="muted" x="276" y="240">14:32</text><path class="cursor approach" d="m254 235 3 19 4-6 7-2z" />
      {:else if scene === 'welcome'}
        {#each [{ name: t.task, agent: 'Claude' }, { name: t.secondTask, agent: 'Codex' }, { name: t.thirdTask, agent: 'Claude' }] as item, i (item.name)}
          <g class="slide" style:animation-delay={`${i * 180}ms`}>
            <rect class="window" x="8" y={16 + i * 78} width="324" height="65" rx="10" />
            <circle class={i === 1 ? 'meter' : 'accent'} cx="27" cy={38 + i * 78} r="4" /><text class="strong" x="40" y={43 + i * 78}>{item.name}</text>
            <text class="muted" x="40" y={65 + i * 78}>{item.agent}</text><text class="small muted" x="314" y={65 + i * 78} text-anchor="end">{i === 1 ? t.complete : t.working}</text>
          </g>
        {/each}
      {:else if scene === 'privacy'}
        <rect class="window" x="66" y="26" width="208" height="195" rx="14" /><path class="ink" d="M86 52h110m-110 20h158m-158 20h130" />
        <path class="shield" d="m170 119 35 13v25c0 26-35 42-35 42s-35-16-35-42v-25z" /><path class="check draw" d="m153 156 12 12 24-29" />
      {:else if scene === 'reach'}
        <rect class="window" x="6" y="40" width="188" height="151" rx="10" /><text class="small muted" x="20" y="64">{t.desktop}</text>
        <rect class="bubble" x="22" y="84" width="155" height="33" rx="7" /><path class="ink" d="M34 100h130m-108 40h147m-147 15h115" />
        <path class="connector" d="M194 127h25" /><circle class="signal" cx="196" cy="127" r="3" />
        <rect class="window" x="219" y="19" width="115" height="217" rx="18" /><text class="small muted" x="276" y="49" text-anchor="middle">{t.phone}</text>
        <rect class="bubble appear" x="231" y="84" width="92" height="33" rx="7" /><path class="ink appear" d="M240 100h72m-9 40h-65m0 15h55" />
        <text class="muted" x="170" y="257" text-anchor="middle">{t.synced}</text>
      {:else if scene === 'quiet'}
        <rect class="window" x="8" y="24" width="324" height="211" rx="10" /><path class="ink" d="M27 52h180m-180 23h265m-265 16h238m-238 40h257" />
        <g class="appear"><rect class="bubble" x="25" y="167" width="291" height="48" rx="9" /><circle class="meter" cx="42" cy="191" r="4" /><text class="small" x="54" y="197">{t.notification}</text></g>
      {:else if scene === 'panel'}
        <rect class="window" x="8" y="12" width="324" height="239" rx="10" /><text class="strong" x="25" y="40">{t.changes}</text><text class="muted" x="25" y="67">{t.file}</text>
        <g class="slide"><rect class="removed" x="24" y="87" width="292" height="30" rx="4" /><rect class="added" x="24" y="126" width="292" height="81" rx="4" />
        <path class="ink" d="M36 103h8m10 0h180m-198 44h8m-4-5v10m14-5h235m-253 37h8m-4-5v10m14-5h213" /></g>
      {:else if scene === 'voice'}
        <rect class="window" x="8" y="12" width="324" height="239" rx="10" />
        <g transform="translate(60 89)">{#each [12,28,44,19,38,26,12,43,22,31,14] as h, i (i)}<rect class="accent sound" x={i*20} y={-h/2} width="4" height={h} rx="2" style:--beat={`${i*70}ms`} />{/each}</g>
        <rect class="bubble" x="23" y="137" width="294" height="94" rx="8" /><text class="appear small" x="35" y="167">{t.voiceWords}</text>
        <path class="accent-stroke" d="M286 191v9a5 5 0 0 1-10 0v-9a5 5 0 0 1 10 0zm-14 7v2a9 9 0 0 0 18 0v-2m-9 11v7m-5 0h10" />
      {:else}
        <rect class="window" x="8" y="12" width="324" height="239" rx="10" />
        <text class="small muted" x="25" y="38">{t.task}</text><path class="line" d="M8 49h324" />
        <rect class="bubble" x="66" y="64" width="250" height="33" rx="7" /><text class="small" x="77" y="85">{t.request}</text>
        <text class="small accent-text" x="25" y="124">Claude</text><text x="25" y="147">{t.answer}</text>
        <g class="appear"><rect class="bubble" x="66" y="163" width="250" height="33" rx="7" /><text class="small" x="77" y="184">{t.followup}</text></g>
        <rect class="track" x="23" y="211" width="294" height="27" rx="6" /><text class="first-agent" x="36" y="230">Claude</text><text class="next-agent accent-text" x="36" y="230">Codex</text>
      {/if}
    </svg>
  {/key}
  <figcaption><span>{strings.onboarding.demo.example}</span><button class="ghost icon" aria-label={paused ? t.play : t.pause} title={paused ? t.play : t.pause} onclick={() => { if (paused) replay++; paused = !paused; }}>{#if paused}<RotateCcw size={14} />{:else}<Pause size={14} />{/if}</button></figcaption>
</figure>

<style>
  figure { margin: 16px 0; container-type: inline-size; }
  svg { display: block; width: 100%; height: auto; overflow: visible; }
  text { fill: var(--color-foreground); font-family: var(--font-sans); font-size: 14px; }
  .small { font-size: 13px; } .strong { font-weight: 600; } .muted { fill: var(--color-muted-foreground); }
  .window { fill: var(--color-surface-2); stroke: var(--color-edge); }
  .track { fill: var(--color-surface-3); } .bubble { fill: var(--color-active); }
  .line { stroke: var(--color-edge); fill: none; stroke-width: 1.5; }
  .ink { stroke: var(--color-muted-foreground); fill: none; stroke-width: 3; stroke-linecap: round; opacity: .5; }
  .accent, .accent-text, .signal { fill: var(--color-accent); } .accent-soft { fill: var(--color-accent-soft); }
  .accent-stroke { fill: none; stroke: var(--color-accent); stroke-width: 2; }
  .meter { fill: var(--color-success); } .added { fill: color-mix(in srgb, var(--color-success) 12%, transparent); }
  .removed { fill: color-mix(in srgb, var(--color-danger) 12%, transparent); }
  .connector { stroke: var(--color-accent); stroke-width: 2; stroke-dasharray: 3 5; fill: none; }
  .cursor { fill: var(--color-foreground); stroke: var(--color-background); stroke-width: 1.5; }
  .shield { fill: var(--color-accent-soft); stroke: var(--color-accent); stroke-width: 2; }
  .check { fill: none; stroke: var(--color-accent); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
  .appear { animation: reveal calc(var(--dur-3) * 8) both; }
  .slide { animation: slide calc(var(--dur-3) * 5) both; }
  .draw { animation: reveal calc(var(--dur-3) * 6) both; }
  .approach { animation: point calc(var(--dur-3) * 8) both; }
  .first-agent { animation: leave calc(var(--dur-3) * 10) both; }
  .next-agent { animation: reveal calc(var(--dur-3) * 10) both; }
  .signal { animation: send calc(var(--dur-3) * 9) 2; }
  .picker { animation: picker calc(var(--dur-3) * 10) both; }
  .sound { transform-box: fill-box; transform-origin: center; animation: speak calc(var(--dur-3) * 3) 4 alternate; animation-delay: var(--beat); }
  .paused :global(*) { animation-play-state: paused !important; }
  figcaption { display: flex; align-items: center; justify-content: space-between; color: var(--color-subtle); font-size: var(--text-xs); padding: 0 4px; }
  @keyframes reveal { 0%, 35% { opacity: 0; } 100% { opacity: 1; } }
  @keyframes leave { 0%, 35% { opacity: 1; } 60%, 100% { opacity: 0; } }
  @keyframes slide { from { opacity: 0; transform: translateX(28px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes point { from { opacity: 0; transform: translate(35px, 12px); } 60%, 100% { opacity: 1; transform: translate(0, 0); } }
  @keyframes speak { from { transform: scaleY(.3); } to { transform: scaleY(1); } }
  @keyframes send { from { transform: translateX(0); opacity: 0; } 20%, 80% { opacity: 1; } to { transform: translateX(35px); opacity: 0; } }
  @keyframes picker { 0%, 15%, 85%, 100% { opacity: 0; } 30%, 70% { opacity: 1; } }
  .compact { display: none; }
  @container (max-width: 400px) { .wide { display: none; } .compact { display: block; } }
  @media (prefers-reduced-motion: reduce) { svg :global(*) { animation: none !important; } .first-agent, .picker { opacity: 0; } .next-agent, .appear { opacity: 1; } .cursor, .signal { display: none; } }
</style>
