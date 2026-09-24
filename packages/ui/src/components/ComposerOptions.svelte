<script lang="ts">
  // The options the bar does not show. On a phone it is a sheet holding them
  // all, since the bar has no room for chips. On a computer it holds the ones
  // this device has not pinned, each with the pin that puts it back in the
  // bar. The permission mode stays in the bar on a computer, never in here.
  import { GitBranch, Paperclip, Pin, Plus, SlidersHorizontal, X } from '@lucide/svelte';
  import { tick } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import type { EffortLevel, PermissionMode } from '@boite/contracts';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import { fill, strings } from '../lib/strings';
  import type { PinId } from '../lib/work-prefs.svelte';

  let { variant = 'phone', levels, effort, speeds, speed, modes, modeLabel, modeHint, mode, worktree, canAttach, busy, pins = { effort: true, worktree: true }, onattach, oneffort, onspeed, onmode, onworktree, onpin } : {
    variant?: 'phone' | 'desktop';
    levels: EffortLevel[]; effort: string | null;
    speeds: { id: string; label: string }[]; speed: string | null;
    /** The composer's list, the most open first; the panel reads it the other way. */
    modes: PermissionMode[]; modeLabel: (mode: PermissionMode) => string; modeHint: (mode: PermissionMode) => string;
    mode: PermissionMode; worktree: boolean | null; canAttach: boolean; busy: boolean;
    pins?: Record<PinId, boolean>;
    onattach: () => void; oneffort: (id: string) => void;
    onspeed: (id: string | null) => void; onmode: (id: PermissionMode) => void;
    onworktree: () => void; onpin?: (id: PinId, on: boolean) => void;
  } = $props();
  const desktop = $derived(variant === 'desktop');
  /** Radio group names, one set per variant since both live in the page at once. */
  const prefix = $derived(desktop ? 'desktop' : 'mobile');
  const panel = new Closing();
  const mobile = new MediaQuery('(max-width: 720px)');
  // Each variant belongs to one width: crossing the line closes the one left behind.
  $effect(() => { if (mobile.current === desktop) panel.hide(); });
  let trigger = $state<HTMLButtonElement>();
  let content = $state<HTMLDivElement>();
  let ordered = $derived([...modes].reverse());
  /** A computer's menu only exists while there is something a pin can move. */
  let pinnable = $derived(levels.length > 0 || speeds.length > 0 || worktree !== null);
  function close() { panel.hide(); trigger?.focus({ preventScroll: true }); }
  async function open() {
    panel.show(); await tick();
    content?.querySelector<HTMLButtonElement>('button, input')?.focus({ preventScroll: true });
  }
  function keydown(event: KeyboardEvent) {
    if (!panel.open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== 'Tab' || !content || desktop) return;
    const nodes = [...content.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
    const first = nodes[0], last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  // A phone has the sheet's backdrop; a computer's popover closes on a press elsewhere.
  $effect(() => {
    if (!desktop || !panel.open) return;
    const onpress = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (trigger?.contains(target) || content?.contains(target))) return;
      panel.hide();
    };
    document.addEventListener('pointerdown', onpress, true);
    return () => document.removeEventListener('pointerdown', onpress, true);
  });
</script>

{#snippet pin(id: PinId, option: string)}
  {#if desktop && onpin}
    <button type="button" class="ghost icon pin" class:on={pins[id]} aria-pressed={pins[id]} aria-label={fill(strings.composer.pin, { option })} title={fill(strings.composer.pin, { option })} data-testid="composer-pin-{id}" onclick={() => onpin(id, !pins[id])}><Pin size={15} strokeWidth={1.75} /></button>
  {/if}
{/snippet}

{#if !desktop || pinnable}
<div class="options" class:desktop>
  {#if desktop}
    <button type="button" class="trigger more" bind:this={trigger} data-testid="composer-more" aria-haspopup="dialog" aria-expanded={panel.open} onclick={() => panel.open ? close() : void open()}><SlidersHorizontal size={14} strokeWidth={1.75} />{strings.composer.moreOptions}</button>
  {:else}
    <button class="icon ghost opener" bind:this={trigger} data-testid="composer-options" aria-label={strings.composer.options} aria-haspopup="dialog" aria-expanded={panel.open} onclick={() => panel.open ? close() : void open()}><Plus size={21} /></button>
  {/if}
  {#if panel.shown}
    <div class="options-sheet" class:desktop class:closing={panel.closing} bind:this={content} role="dialog" aria-modal={desktop ? undefined : 'true'} aria-label={strings.composer.options} tabindex="-1" data-testid={desktop ? 'composer-more-menu' : 'composer-options-sheet'} onkeydown={keydown}
      use:panel.attach onanimationend={panel.end} use:floating={{ anchor: () => trigger ?? null, dismiss: close }}>
      <header><h2>{strings.composer.options}</h2><button class="icon ghost" aria-label={strings.common.close} onclick={close}><X size={19} /></button></header>
      {#if canAttach && !desktop}
        <button class="attachment" data-testid="composer-options-attach" onclick={() => { onattach(); close(); }}><Paperclip size={20} /><span>{strings.composer.attach}</span></button>
      {/if}
      {#if levels.length}
        <div class="group">
          <fieldset disabled={busy}><legend>{strings.composer.effortTitle}</legend><div class="choices">
            {#each levels as level (level.id)}<label class:selected={effort === level.id}><input type="radio" name="{prefix}-effort" value={level.id} checked={effort === level.id} onchange={() => oneffort(level.id)} />{level.label}</label>{/each}
          </div></fieldset>
          {@render pin('effort', strings.composer.effortTitle)}
        </div>
      {/if}
      {#if speeds.length}
        <div class="group">
          <fieldset disabled={busy}><legend>{strings.composer.speed}</legend><div class="choices">
            {#each [{ id: null, label: strings.composer.standardSpeed }, ...speeds] as entry (entry.id)}<label class:selected={speed === entry.id}><input type="radio" name="{prefix}-speed" checked={speed === entry.id} onchange={() => onspeed(entry.id)} />{entry.label}</label>{/each}
          </div></fieldset>
          <!-- The speed rides on the effort chip, so one pin holds both. -->
          {#if !levels.length}{@render pin('effort', strings.composer.speed)}{/if}
        </div>
      {/if}
      {#if ordered.length > 0 && !desktop}<fieldset disabled={busy}><legend>{strings.composer.mode}</legend><div class="choices permissions">
        {#each ordered as item (item)}<label class:selected={mode === item} title={modeHint(item)}><input type="radio" name="{prefix}-mode" value={item} checked={mode === item} onchange={() => onmode(item)} />{modeLabel(item)}</label>{/each}
      </div><p class="hint">{modeHint(mode)}</p></fieldset>{/if}
      {#if worktree !== null}
        <div class="worktree-row">
          <button class="worktree" aria-pressed={worktree} data-testid="composer-options-worktree" onclick={onworktree}><GitBranch size={19} /><span>{strings.composer.worktree}</span><span class="switch" class:on={worktree}></span></button>
          {@render pin('worktree', strings.composer.worktree)}
        </div>
      {/if}
    </div>
  {/if}
</div>
{/if}

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

  /* A computer: a popover at the chip, denser rows, a pin at the right of each group. */
  .options.desktop { display: block; flex: none; }
  .options.desktop .more { display: inline-flex; align-items: center; }
  .options-sheet.desktop { width: 320px; padding: 12px 14px; border-radius: var(--radius-lg); }
  .options-sheet.desktop header { margin-bottom: 4px; }
  .options-sheet.desktop h2 { font-size: var(--text-sm); }
  .options-sheet.desktop fieldset { margin: 12px 0; }
  .options-sheet.desktop .choices label { min-height: var(--control); padding: 4px 10px; }
  .options-sheet.desktop .worktree { min-height: var(--control); padding: 6px 10px; gap: 10px; font-size: var(--text-sm); }
  .group { position: relative; }
  .group .pin { position: absolute; top: -6px; right: 0; }
  .worktree-row { display: flex; align-items: center; gap: 6px; margin-top: 12px; }
  .worktree-row .worktree { flex: 1; }
  .pin { width: 28px; height: 28px; color: var(--color-muted-foreground); }
  .pin.on { color: var(--color-accent); }
  .pin.on :global(svg) { fill: currentColor; }

  @media (max-width: 720px) {
    .options:not(.desktop) { display: block; flex: none; }
    .options.desktop { display: none; }
    .opener { width: var(--touch-target); height: var(--touch-target); border-radius: var(--radius-xl); }
  }
</style>
