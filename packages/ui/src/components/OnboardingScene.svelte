<script lang="ts">
  import { ArrowDown, ArrowRight, ArrowUp, Bell, Check, ChevronDown, FileCode2, Folder, LockKeyhole, Mic, Monitor, Pause, Play, RotateCcw, Smartphone, VolumeX } from '@lucide/svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import BoiteMark from './BoiteMark.svelte';
  import { strings } from '../lib/strings';

  let { scene }: { scene: 'welcome' | 'agents' | 'voice' | 'panel' | 'usage' | 'reach' | 'quiet' } = $props();
  let paused = $state(false);
  let replay = $state(0);
  // One markup per scene: the artwork reads the same strings as the tour around it.
  const t = $derived(strings.onboarding.demo);
  const description = $derived(scene === 'voice' ? t.voiceHint : scene === 'agents' ? t.continued : scene === 'panel' ? t.reviewed : scene === 'usage' ? t.trayHint : scene === 'reach' ? t.reachHint : scene === 'quiet' ? t.quietBody : strings.onboarding.welcome.body);
</script>

{#snippet pointer(extra: string)}
  <svg class="pointer {extra}" viewBox="0 0 28 32" aria-hidden="true"><path d="M4 2v24l6-6 5 10 5-3-5-9h10z" /></svg>
{/snippet}
{#snippet author(provider: 'claude' | 'codex')}
  <span class="author"><ProviderLogo providerId={provider} size={17} />{provider === 'claude' ? 'Claude' : 'Codex'}</span>
{/snippet}
{#snippet threadHeader()}
  <div class="chrome"><BoiteMark size={16} /><span>{t.task}</span><span class="chrome-end"><Check size={14} /></span></div>
{/snippet}

<figure data-testid="onboarding-scene" data-scene={scene} class:paused>
  {#key `${scene}-${replay}`}
    <div class="stage {scene}" role="img" aria-label={description} data-testid="onboarding-animation">
      {#if scene === 'welcome'}
        <ul class="tasks">
          {#each [{ name: t.task, provider: 'claude', result: t.taskResult }, { name: t.secondTask, provider: 'codex', result: t.loginResult }, { name: t.thirdTask, provider: 'claude', result: t.testsResult }] as item, i (i)}
            <li class="task" style:--order={i}>
              <ProviderLogo providerId={item.provider} size={18} />
              <strong>{item.name}</strong>
              <span class="task-state"><span class="task-working"><span class="spinner"></span>{t.working}</span><span class="task-done"><Check size={15} />{item.result}</span></span>
            </li>
          {/each}
        </ul>
      {:else if scene === 'agents'}
        <div class="mini-app">
          {@render threadHeader()}
          <div class="conversation">
            <div class="message user">{t.request}</div>
            <div class="message assistant">{@render author('claude')}<p>{t.answer}</p></div>
            <div class="message user sent-prompt">{t.followup}</div>
            <div class="message assistant handoff-result">{@render author('codex')}<p>{t.checked}</p></div>
          </div>
          <div class="composer">
            <p class="agent-draft"><span>{t.followup}</span><span>{t.nextMessage}</span></p>
            <div class="composer-tools">
              <div class="agent-chip"><span class="agent-old">{@render author('claude')}</span><span class="agent-new">{@render author('codex')}</span><ChevronDown size={14} />
                <div class="agent-menu"><span>{@render author('claude')}<Check size={14} /></span><span class="chosen">{@render author('codex')}<Check size={14} /></span></div>
                {@render pointer('agent-pointer')}
              </div>
              <span class="send"><ArrowUp size={17} /></span>
            </div>
          </div>
        </div>
        <div class="scene-outcome"><span class="before-handoff"><ArrowDown size={16} />{t.chooseAgent}</span><span class="after-handoff"><Check size={16} />{t.handoff}</span></div>
      {:else if scene === 'voice'}
        <div class="voice-sequence"><span><b>1</b>{t.record}</span><span><b>2</b>{t.speak}</span><span><b>3</b>{t.review}</span></div>
        <div class="mini-app">
          {@render threadHeader()}
          <div class="recording-area">
            <div class="recording-live"><span class="record-dot"></span>{t.listening}</div>
            <div class="recording-done"><Check size={17} />{t.review}</div>
            <svg class="waveform" viewBox="0 0 360 66" aria-hidden="true">
              <path class="wave-axis" d="M4 33h352" />
              {#each [8, 14, 26, 18, 38, 50, 28, 44, 60, 36, 20, 48, 32, 54, 24, 40, 16, 30, 12, 8] as height, i (i)}
                <rect x={17 + i * 17} y={(66 - height) / 2} width="4" height={height} rx="2" style:--beat={`${i * 55}ms`} />
              {/each}
            </svg>
          </div>
          <div class="composer voice-composer">
            <span class="draft-label">{t.draft}</span>
            <p class="transcript">{#each t.voiceWords.split(' ') as word, i (i)}<span style:--word={i}>{word + ' '}</span>{/each}<span class="caret"></span></p>
            <div class="composer-tools"><span class="local"><LockKeyhole size={13} />{t.localLabel}</span><div class="voice-actions"><span class="mic-target"><Mic size={20} />{@render pointer('mic-pointer')}</span><span class="send voice-send"><ArrowUp size={17} /></span></div></div>
          </div>
        </div>
      {:else if scene === 'panel'}
        <div class="mini-app">
          {@render threadHeader()}
          <div class="split-view">
            <div class="chat-side"><div class="message user">{t.request}</div><div class="message assistant">{@render author('claude')}<p>{t.answer}</p><span class="file-chip"><FileCode2 size={15} />{t.changedFile}</span></div></div>
            <div class="diff-side"><div class="diff-title"><FileCode2 size={16} /><strong>{t.changes}</strong><span>+2 −1</span></div><div class="file-name">{t.changedFile}</div><div class="code-diff"><div class="removed">− &lt;button&gt;{t.buttonBefore}</div><div class="added">+ &lt;button type="submit"&gt;<br />+ &nbsp; {t.buttonAfter}</div></div><div class="preview"><span>{t.before}</span><div class="old-button">{t.buttonBefore}</div><span>{t.after}</span><div class="new-button">{t.buttonAfter}<ArrowRight size={14} /></div></div></div>
          </div>
        </div>
        <div class="scene-outcome"><Check size={16} />{t.changesReady}</div>
      {:else if scene === 'usage'}
        <div class="desktop-space">
          <div class="quota-popup"><div class="quota-title"><ProviderLogo providerId="claude" size={22} /><strong>{t.usageLabel}</strong></div><div class="quota-value"><span>{t.window}</span><strong>{t.used}</strong></div><div class="quota-track"><span></span></div><p>{t.reset}</p></div>
          <div class="tray-instruction">{t.hoverTray}<ArrowDown size={18} /></div>
          <div class="taskbar"><span class="desktop-app"><Folder size={18} /></span><span class="desktop-app"><Monitor size={18} /></span><div class="system-tray"><ChevronDown size={14} /><span class="tray-target"><BoiteMark size={20} />{@render pointer('tray-pointer')}</span><VolumeX size={16} /><span class="clock">14:32</span></div></div>
        </div>
      {:else if scene === 'reach'}
        <!-- The same three lines on both screens: the picture says "same conversation" without text to read. -->
        {#snippet chat()}
          <span class="line user-line"></span>
          <span class="reply"><ProviderLogo providerId="claude" size={14} /><span class="line"></span></span>
          <span class="done"><Check size={13} /></span>
        {/snippet}
        <div class="devices">
          <div class="computer"><div class="monitor">{@render chat()}</div><div class="stand"></div><span class="device-label"><Monitor size={14} />{t.desktop}</span></div>
          <div class="sync-link" aria-hidden="true"><span></span></div>
          <div class="phone-side"><div class="phone">{@render chat()}</div><span class="device-label"><Smartphone size={14} />{t.phone}</span></div>
        </div>
        <div class="scene-outcome"><Check size={16} />{t.synced}</div>
      {:else}
        <div class="quiet-desktop"><div class="background-agent"><BoiteMark size={18} /><span>{t.background}</span></div><div class="notes"><div class="chrome"><FileCode2 size={15} />{t.notes}<span class="chrome-end"><VolumeX size={15} /></span></div><strong>{t.writing}</strong><p><span class="empty-check"></span>{t.noteOne}</p><p><span class="empty-check"></span>{t.noteTwo}<span class="caret"></span></p></div><div class="notification"><Bell size={18} /><div><strong>Boite</strong><span>{t.notification}</span></div><Check size={16} /></div></div>
      {/if}
    </div>
  {/key}
  <figcaption>
    <button class="ghost small" aria-pressed={paused} data-testid="onboarding-animation-pause" onclick={() => paused = !paused}>{#if paused}<Play size={13} />{t.resume}{:else}<Pause size={13} />{t.pause}{/if}</button>
    <button class="ghost small" data-testid="onboarding-animation-replay" onclick={() => { paused = false; replay++; }}><RotateCcw size={13} />{t.play}</button>
  </figcaption>
</figure>

<style>
  figure { margin: 18px 0 8px; container-type: inline-size; }
  .stage { --demo-duration: calc(var(--dur-3) * 16); font-size: var(--text-sm); line-height: 1.5; color: var(--color-foreground); }
  /* The two conversation demos carry text to read; the others are over in under four seconds. */
  .stage.agents, .stage.voice { --demo-duration: calc(var(--dur-3) * 22); }
  .stage :global(svg) { flex: none; }
  .stage p { margin: 0; }
  .mini-app { background: var(--color-surface-2); border: 1px solid var(--color-edge); border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow-e1); }
  .chrome { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 8px 14px; border-bottom: 1px solid var(--color-border); color: var(--color-muted-foreground); }
  .chrome-end { margin-left: auto; display: flex; }
  .author { display: inline-flex; align-items: center; gap: 7px; font-weight: 500; }
  .conversation { display: grid; gap: 14px; padding: 16px 18px 10px; }
  .message p { margin-top: 5px; }
  .user { justify-self: end; background: var(--color-active); border-radius: var(--radius-lg) var(--radius-lg) var(--radius-sm) var(--radius-lg); padding: 9px 12px; max-width: 88%; }
  .assistant { padding-left: 3px; }
  .sent-prompt { animation: second var(--demo-duration) both; }
  .handoff-result { animation: later var(--demo-duration) both; }
  .agent-draft { position: relative; }
  .agent-draft > span:first-child { animation: first var(--demo-duration) both; }
  .agent-draft > span:last-child { position: absolute; inset: 0; color: var(--color-muted-foreground); animation: second var(--demo-duration) both; }
  .composer { margin: 12px; padding: 12px; background: var(--color-surface-3); border: 1px solid var(--color-edge); border-radius: var(--radius-lg); box-shadow: var(--shadow-e1); }
  .composer-tools { margin-top: 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .agent-chip { position: relative; display: flex; align-items: center; gap: 7px; padding: 5px 8px; border: 1px solid var(--color-edge); border-radius: var(--radius-md); }
  .agent-old, .agent-new { display: flex; }
  .agent-old { animation: first var(--demo-duration) both; }
  .agent-new { position: absolute; left: 8px; animation: second var(--demo-duration) both; }
  .agent-menu { position: absolute; bottom: calc(100% + 8px); left: 0; width: 158px; padding: 5px; border-radius: var(--radius-md); border: 1px solid var(--color-edge); background: var(--color-surface); box-shadow: var(--shadow-e2); animation: menu var(--demo-duration) both; }
  .agent-menu > span { display: flex; justify-content: space-between; align-items: center; padding: 8px; }
  .agent-menu .chosen { background: var(--color-accent-soft); border-radius: var(--radius-sm); }
  .agent-menu .chosen > :global(svg) { color: var(--color-accent); }
  .send { display: flex; align-items: center; justify-content: center; width: 27px; height: 27px; border-radius: var(--radius-md); background: var(--color-foreground); color: var(--color-surface); }
  .pointer { position: absolute; width: 23px; height: 27px; z-index: 2; overflow: visible; pointer-events: none; }
  .pointer path { fill: var(--color-foreground); stroke: var(--color-background); stroke-width: 1.5; }
  .agent-pointer { left: 80%; top: 70%; animation: agent-point var(--demo-duration) both; }
  .scene-outcome { display: flex; justify-content: center; align-items: center; gap: 7px; position: relative; margin-top: 12px; min-height: 24px; font-weight: 500; }
  .scene-outcome :global(svg) { color: var(--color-accent); }
  .before-handoff, .after-handoff { display: flex; align-items: center; gap: 7px; }
  .before-handoff { animation: first var(--demo-duration) both; }
  .after-handoff { position: absolute; animation: second var(--demo-duration) both; }
  .voice-sequence { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
  .voice-sequence > span { display: flex; align-items: center; gap: 7px; line-height: 1.35; }
  .voice-sequence b { flex: none; display: grid; place-items: center; width: 22px; height: 22px; border: 1px solid var(--color-edge); border-radius: 50%; font-size: var(--text-xs); color: var(--color-accent); }
  .recording-area { position: relative; padding: 18px 24px 4px; }
  .recording-live, .recording-done { display: flex; gap: 7px; align-items: center; justify-content: center; }
  .recording-live { animation: first var(--demo-duration) both; color: var(--color-accent); }
  .recording-done { position: absolute; inset: 18px 0 auto; animation: second var(--demo-duration) both; color: var(--color-success); }
  .record-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .waveform { width: 100%; height: 68px; margin-top: 10px; overflow: visible; }
  .waveform rect { fill: var(--color-accent); transform-box: fill-box; transform-origin: center; animation: waveform calc(var(--dur-3) * 3) 5 alternate both; animation-delay: var(--beat); }
  .wave-axis { stroke: var(--color-edge); stroke-width: 1; }
  .draft-label { font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .transcript { min-height: 44px; padding-top: 8px; font-size: var(--text-base); }
  .transcript > span:not(.caret) { animation: word var(--demo-duration) both; animation-delay: calc(var(--word) * var(--dur-2)); }
  .caret { display: inline-block; vertical-align: middle; margin-left: 3px; height: 1.1em; border-left: 2px solid var(--color-accent); }
  .local { display: inline-flex; align-items: center; gap: 5px; color: var(--color-muted-foreground); }
  .voice-actions { display: flex; align-items: center; gap: 12px; }
  .mic-target { position: relative; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; color: var(--color-accent); background: var(--color-accent-soft); animation: mic-active var(--demo-duration) both; }
  .mic-pointer { left: 20px; top: 22px; animation: tap var(--demo-duration) both; }
  .voice-send { animation: later var(--demo-duration) both; }
  .split-view { display: grid; grid-template-columns: .85fr 1.15fr; min-height: 270px; }
  .chat-side { padding: 14px 12px; display: flex; flex-direction: column; gap: 22px; }
  .file-chip { display: flex; align-items: center; gap: 5px; margin-top: 16px; color: var(--color-muted-foreground); font-size: var(--text-xs); word-break: break-all; }
  .diff-side { border-left: 1px solid var(--color-edge); background: var(--color-surface); animation: early var(--demo-duration) both; }
  .diff-title { display: flex; align-items: center; gap: 5px; padding: 12px; border-bottom: 1px solid var(--color-border); }
  .diff-title > span { margin-left: auto; color: var(--color-success); font-size: var(--text-xs); white-space: nowrap; }
  .file-name { padding: 8px 12px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .code-diff { font-family: var(--font-mono); font-size: var(--text-xs); }
  .removed { background: color-mix(in srgb, var(--color-danger) 12%, transparent); color: var(--color-danger); padding: 4px 12px; }
  .added { background: color-mix(in srgb, var(--color-success) 12%, transparent); color: var(--color-success); padding: 4px 12px; }
  .preview { padding: 10px 12px 14px; display: grid; gap: 5px; }
  .preview > span { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .old-button { justify-self: start; font-size: var(--text-xs); border: 1px solid var(--color-edge); padding: 3px 9px; border-radius: var(--radius-sm); color: var(--color-muted-foreground); }
  .new-button { display: flex; justify-content: center; align-items: center; gap: 7px; background: var(--color-foreground); color: var(--color-surface); border-radius: var(--radius-md); padding: 8px; font-weight: 500; }
  .desktop-space { position: relative; min-height: 288px; padding: 16px 0 52px; border: 1px solid var(--color-edge); border-radius: var(--radius-lg); background: var(--color-surface-2); overflow: hidden; }
  .quota-popup { width: min(290px, calc(100% - 32px)); margin: 0 18px 0 auto; padding: 18px; border: 1px solid var(--color-edge); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-e2); animation: pop var(--demo-duration) both; }
  .quota-title { display: flex; align-items: center; gap: 9px; margin-bottom: 18px; }
  .quota-value { display: flex; justify-content: space-between; gap: 8px; }
  .quota-track { height: 8px; background: var(--color-surface-3); border-radius: 8px; margin: 10px 0; overflow: hidden; }
  .quota-track span { display: block; width: 24%; height: 100%; background: var(--color-success); border-radius: inherit; animation: meter var(--demo-duration) both; }
  .quota-popup p { color: var(--color-muted-foreground); }
  .taskbar { position: absolute; inset: auto 0 0; height: 44px; background: var(--color-surface-3); border-top: 1px solid var(--color-edge); display: flex; align-items: center; gap: 15px; padding: 0 14px; }
  .desktop-app { display: flex; color: var(--color-muted-foreground); }
  .system-tray { display: flex; align-items: center; gap: 13px; margin-left: auto; }
  .system-tray > :global(svg:first-child) { transform: rotate(180deg); }
  .tray-target { position: relative; display: flex; padding: 6px; border-radius: var(--radius-sm); background: var(--color-accent-soft); color: var(--color-accent); }
  .tray-pointer { top: 17px; left: 16px; animation: hover var(--demo-duration) both; }
  .clock { font-variant-numeric: tabular-nums; }
  .tray-instruction { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin: 14px 85px 0 12px; color: var(--color-muted-foreground); }
  .tasks { margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-edge); border-radius: var(--radius-lg); background: var(--color-surface-2); }
  .task { --delay: calc(var(--order) * var(--dur-3) * 2); display: flex; align-items: center; gap: 11px; padding: 11px 14px; }
  .task + .task { border-top: 1px solid var(--color-border); }
  .task strong { flex: 1; min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-state { display: grid; justify-items: end; color: var(--color-muted-foreground); }
  .task-working, .task-done { grid-area: 1 / 1; display: flex; align-items: center; gap: 6px; white-space: nowrap; animation: first var(--demo-duration) both var(--delay); }
  .task-done { color: var(--color-success); animation-name: second; }
  .spinner { display: block; width: 12px; height: 12px; border: 2px solid var(--color-edge); border-top-color: var(--color-accent); border-radius: 50%; animation: spin calc(var(--dur-3) * 4) linear 4; }
  .devices { display: flex; align-items: flex-end; justify-content: center; gap: 12px; padding-top: 4px; }
  .computer, .phone-side { display: grid; justify-items: center; gap: 0; }
  .device-label { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .monitor, .phone { display: flex; flex-direction: column; gap: 9px; padding: 14px; border: 2px solid var(--color-edge); background: var(--color-surface-2); }
  .monitor { width: 216px; height: 136px; border-radius: var(--radius-md); }
  .phone { width: 92px; height: 164px; padding: 22px 10px 10px; border-radius: 18px; }
  .stand { width: 48px; height: 12px; border-bottom: 3px solid var(--color-edge); background: linear-gradient(90deg, transparent 42%, var(--color-edge) 42%, var(--color-edge) 58%, transparent 58%); }
  .line { display: block; height: 9px; border-radius: 9px; background: var(--color-edge); }
  .user-line { align-self: flex-end; width: 58%; background: var(--color-active); }
  .reply { display: flex; align-items: center; gap: 6px; }
  .reply .line { flex: 1; }
  .done { display: grid; place-items: center; width: 22px; height: 22px; margin-top: auto; border-radius: 50%; color: var(--color-background); background: var(--color-success); }
  .monitor > *, .phone > * { animation: rise var(--demo-duration) both; }
  .monitor > .reply { animation-name: rise-2; } .monitor > .done { animation-name: rise-3; }
  .phone > * { animation-name: mirror; } .phone > .reply { animation-name: mirror-2; } .phone > .done { animation-name: mirror-3; }
  .sync-link { position: relative; align-self: center; width: 44px; height: 2px; margin-bottom: 40px; background: repeating-linear-gradient(90deg, var(--color-edge) 0 5px, transparent 5px 9px); }
  .sync-link span { position: absolute; top: -3px; left: 0; width: 8px; height: 8px; border-radius: 50%; background: var(--color-accent); animation: sync var(--demo-duration) both; }
  .quiet-desktop { position: relative; padding: 0 0 42px; }
  .background-agent { display: flex; align-items: center; gap: 8px; margin: 0 16px -9px; padding: 9px 12px 16px; background: var(--color-surface-3); border: 1px solid var(--color-border); border-radius: var(--radius-lg) var(--radius-lg) 0 0; color: var(--color-muted-foreground); }
  .notes { position: relative; border: 1px solid var(--color-edge); background: var(--color-surface-2); border-radius: var(--radius-lg); overflow: hidden; padding-bottom: 18px; box-shadow: var(--shadow-e1); }
  .notes > strong { display: block; padding: 14px 16px 8px; }
  .notes > p { display: flex; align-items: center; gap: 8px; padding: 4px 16px; }
  .empty-check { width: 12px; height: 12px; border: 1px solid var(--color-edge); border-radius: 3px; flex: none; }
  .notification { position: absolute; bottom: 0; right: 8px; display: flex; align-items: center; gap: 10px; padding: 12px; background: var(--color-surface-3); border: 1px solid var(--color-edge); border-radius: var(--radius-lg); box-shadow: var(--shadow-e2); animation: second var(--demo-duration) both; }
  .notification div { display: grid; gap: 2px; }
  .notification strong { font-size: var(--text-xs); }
  .notification > :global(svg:last-child) { color: var(--color-success); }
  figcaption { display: flex; justify-content: flex-end; gap: 4px; margin-top: 7px; }
  figcaption button { display: inline-flex; align-items: center; gap: 5px; color: var(--color-muted-foreground); }
  .paused .stage, .paused .stage :global(*) { animation-play-state: paused !important; }
  @keyframes first { 0%, 45% { opacity: 1; } 53%, 100% { opacity: 0; } }
  @keyframes second { 0%, 48% { opacity: 0; } 58%, 100% { opacity: 1; } }
  @keyframes later { 0%, 65% { opacity: 0; transform: translateY(4px); } 76%, 100% { opacity: 1; transform: none; } }
  @keyframes early { 0%, 18% { opacity: 0; transform: translateY(4px); } 30%, 100% { opacity: 1; transform: none; } }
  @keyframes menu { 0%, 18%, 52%, 100% { opacity: 0; } 24%, 46% { opacity: 1; } }
  @keyframes agent-point { 0% { opacity: 0; transform: translate(6px, 6px); } 12%, 20% { opacity: 1; transform: none; } 32%, 45% { opacity: 1; transform: translate(0, -50px); } 55%, 100% { opacity: 0; transform: translate(0, -50px); } }
  @keyframes tap { 0% { opacity: 0; transform: translate(5px, 5px); } 12%, 22% { opacity: 1; transform: none; } 30%, 100% { opacity: 0; } }
  @keyframes hover { 0% { opacity: 0; transform: translate(8px, 6px); } 8%, 100% { opacity: 1; transform: none; } }
  @keyframes pop { 0%, 8% { opacity: 0; transform: translateY(6px); } 13%, 100% { opacity: 1; transform: none; } }
  @keyframes waveform { from { transform: scaleY(.2); opacity: .6; } to { transform: scaleY(1); opacity: 1; } }
  @keyframes word { 0%, 28% { opacity: 0; } 32%, 100% { opacity: 1; } }
  @keyframes mic-active { 0%, 12% { box-shadow: 0 0 0 0 transparent; } 20%, 45% { box-shadow: 0 0 0 5px var(--color-accent-soft); } 60%, 100% { box-shadow: 0 0 0 0 transparent; } }
  @keyframes meter { 0%, 13% { transform: scaleX(0); transform-origin: left; } 35%, 100% { transform: scaleX(1); transform-origin: left; } }
  @keyframes spin { to { transform: rotate(1turn); } }
  @keyframes sync { 0%, 32% { opacity: 0; transform: none; } 36% { opacity: 1; } 50% { opacity: 1; transform: translateX(36px); } 54%, 100% { opacity: 0; transform: translateX(36px); } }
  @keyframes rise { 0% { opacity: 0; transform: translateY(4px); } 8%, 100% { opacity: 1; transform: none; } }
  @keyframes rise-2 { 0%, 12% { opacity: 0; transform: translateY(4px); } 20%, 100% { opacity: 1; transform: none; } }
  @keyframes rise-3 { 0%, 24% { opacity: 0; transform: scale(.6); } 32%, 100% { opacity: 1; transform: none; } }
  @keyframes mirror { 0%, 48% { opacity: 0; transform: translateY(4px); } 56%, 100% { opacity: 1; transform: none; } }
  @keyframes mirror-2 { 0%, 54% { opacity: 0; transform: translateY(4px); } 62%, 100% { opacity: 1; transform: none; } }
  @keyframes mirror-3 { 0%, 60% { opacity: 0; transform: scale(.6); } 68%, 100% { opacity: 1; transform: none; } }
  @container (max-width: 400px) {
    .voice-sequence { gap: 8px; font-size: var(--text-xs); } .voice-sequence > span { flex-direction: column; align-items: flex-start; gap: 5px; }
    .task { padding: 10px 12px; gap: 9px; } .task-state { font-size: var(--text-xs); }
    .split-view { grid-template-columns: 1fr; } .chat-side { flex-direction: row; align-items: start; gap: 12px; } .chat-side .user { flex: 1; } .chat-side .assistant { flex: 1; } .file-chip { display: none; }
    .diff-side { border-left: 0; border-top: 1px solid var(--color-edge); } .preview { grid-template-columns: 1fr 1fr; align-items: center; } .preview > span { grid-column: 1; } .preview > div { grid-column: 2; } .old-button { justify-self: stretch; text-align: center; }
    .devices { gap: 8px; } .monitor { width: 168px; height: 112px; padding: 12px; } .sync-link { width: 24px; }
    .notification { left: 12px; right: 0; gap: 7px; font-size: var(--text-xs); }
    .quota-popup { margin-right: 14px; } .tray-instruction { margin-right: 16px; } .desktop-app { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .stage :global(*) { animation: none !important; }
    .agent-old, .agent-draft > span:first-child, .before-handoff, .recording-live, .task-working, .agent-menu, .pointer, .sync-link span { opacity: 0; }
    figcaption { display: none; }
  }
  :global(html[data-motion="reduced"]) .stage :global(*) { animation: none !important; }
  :global(html[data-motion="reduced"]) :is(.agent-old, .agent-draft > span:first-child, .before-handoff, .recording-live, .task-working, .agent-menu, .pointer, .sync-link span) { opacity: 0; }
  :global(html[data-motion="reduced"]) figcaption { display: none; }
</style>
