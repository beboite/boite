<script lang="ts">
  import { GitBranch, Paperclip, Plus, X } from '@lucide/svelte';
  import { tick } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import type { EffortLevel, PermissionMode } from '@boite/contracts';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import { strings } from '../lib/strings';

  let { levels, effort, speeds, speed, mode, worktree, canAttach, busy, onattach, oneffort, onspeed, onmode, onworktree } : {
    levels: EffortLevel[]; effort: string | null;
    speeds: { id: string; label: string }[]; speed: string | null;
    mode: PermissionMode; worktree: boolean | null; canAttach: boolean; busy: boolean;
    onattach: () => void; oneffort: (id: string) => void;
    onspeed: (id: string | null) => void; onmode: (id: PermissionMode) => void;
    onworktree: () => void;
  } = $props();
  const panel = new Closing();
  const mobile = new MediaQuery('(max-width: 720px)');
  $effect(() => { if (!mobile.current) panel.hide(); });
  let trigger = $state<HTMLButtonElement>();
  let content = $state<HTMLDivElement>();
  const modes: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions'];
  function close() { panel.hide(); trigger?.focus({ preventScroll: true }); }
  async function open() {
    panel.show(); await tick();
    content?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }
  function keydown(event: KeyboardEvent) {
    if (!panel.open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== 'Tab' || !content) return;
    const nodes = [...content.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
    const first = nodes[0], last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
</script>

<div class="options">
  <button class="icon ghost opener" bind:this={trigger} data-testid="composer-options" aria-label={strings.composer.options} aria-haspopup="dialog" aria-expanded={panel.open} onclick={() => panel.open ? close() : void open()}><Plus size={21} /></button>
  {#if panel.shown}
    <div class="options-sheet" class:closing={panel.closing} bind:this={content} role="dialog" aria-modal="true" aria-label={strings.composer.options} tabindex="-1" data-testid="composer-options-sheet" onkeydown={keydown}
      use:panel.attach onanimationend={panel.end} use:floating={{ anchor: () => trigger ?? null, dismiss: close }}>
      <header><h2>{strings.composer.options}</h2><button class="icon ghost" aria-label={strings.common.close} onclick={close}><X size={19} /></button></header>
      {#if canAttach}
        <button class="attachment" data-testid="composer-options-attach" onclick={() => { onattach(); close(); }}><Paperclip size={20} /><span>{strings.composer.attach}</span></button>
      {/if}
      {#if levels.length}
        <fieldset disabled={busy}><legend>{strings.composer.effortTitle}</legend><div class="choices">
          {#each levels as level (level.id)}<label class:selected={effort === level.id}><input type="radio" name="mobile-effort" value={level.id} checked={effort === level.id} onchange={() => oneffort(level.id)} />{level.label}</label>{/each}
        </div></fieldset>
      {/if}
      {#if speeds.length}
        <fieldset disabled={busy}><legend>{strings.composer.speed}</legend><div class="choices">
          {#each [{ id: null, label: strings.composer.standardSpeed }, ...speeds] as entry (entry.id)}<label class:selected={speed === entry.id}><input type="radio" name="mobile-speed" checked={speed === entry.id} onchange={() => onspeed(entry.id)} />{entry.label}</label>{/each}
        </div></fieldset>
      {/if}
      <fieldset disabled={busy}><legend>{strings.composer.mode}</legend><div class="choices permissions">
        {#each modes as item (item)}<label class:selected={mode === item} title={strings.permissionModeLong[item]}><input type="radio" name="mobile-mode" value={item} checked={mode === item} onchange={() => onmode(item)} />{strings.permissionMode[item]}</label>{/each}
      </div><p class="hint">{strings.permissionModeLong[mode]}</p></fieldset>
      {#if worktree !== null}<button class="worktree" aria-pressed={worktree} data-testid="composer-options-worktree" onclick={onworktree}><GitBranch size={19} /><span>{strings.composer.worktree}</span><span class="switch" class:on={worktree}></span></button>{/if}
    </div>
  {/if}
</div>

<style>
  .options { display: none; }
  .options-sheet { color: var(--color-foreground); background: var(--color-surface-2); border: 1px solid var(--color-edge); border-radius: var(--radius-xl); padding: 16px; overflow-y: auto; box-shadow: var(--shadow-e3); animation: pop var(--dur-2) var(--ease-out-quint); }
  .options-sheet.closing { animation-name: pop-out; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  h2 { font-size: var(--text-md); margin: 0; font-weight: 600; }
  .attachment, .worktree { display: flex; align-items: center; gap: 12px; width: 100%; min-height: var(--touch-target); height: auto; text-align: left; border: none; background: var(--color-hover); padding: 10px 12px; border-radius: var(--radius-lg); }
  fieldset { border: none; padding: 0; margin: 22px 0; min-width: 0; }
  fieldset:disabled { opacity: .6; }
  legend { padding: 0; margin-bottom: 10px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .hint { margin: 10px 0 0; font-size: var(--text-xs); line-height: 1.5; color: var(--color-muted-foreground); }
  .choices { display: flex; flex-wrap: wrap; gap: 6px; }
  .choices label { position: relative; flex: 1 0 auto; display: flex; justify-content: center; align-items: center; min-height: var(--touch-target); padding: 8px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-md); cursor: pointer; font-size: var(--text-sm); }
  .choices label.selected { background: var(--color-accent-soft); border-color: var(--color-accent); color: var(--color-accent); }
  .choices label:focus-within { outline: 2px solid var(--color-accent); outline-offset: 2px; }
  input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .worktree span:first-of-type { flex: 1; }
  .switch { width: 30px; height: 18px; padding: 3px; background: var(--color-edge); border-radius: var(--radius-xl); }
  .switch::after { content: ''; display: block; width: 12px; height: 12px; border-radius: var(--radius-xl); background: var(--color-foreground); transition: transform var(--dur-2); }
  .switch.on { background: var(--color-accent); }
  .switch.on::after { transform: translateX(12px); }
  @media (max-width: 720px) { .options { display: block; flex: none; } .opener { width: var(--touch-target); height: var(--touch-target); border-radius: var(--radius-xl); } }
</style>
