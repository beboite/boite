<script lang="ts">
  import { tick, type Component } from 'svelte';
  import { ArrowDownWideNarrow, Folder, Folders, GitMerge, GripVertical, List, LoaderCircle, SlidersHorizontal } from '@lucide/svelte';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import { workspace } from '../lib/workspace.svelte';
  import { projectView, type ProjectEntry } from '../lib/project-view.svelte';
  import { recentPreferences } from '../lib/recent.svelte';
  import { projectName } from '../lib/format';
  import { strings } from '../lib/strings';
  import type { Project } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import InfoTip from './InfoTip.svelte';
  import ProjectTile from './ProjectTile.svelte';

  /**
   * How the thread list is drawn, in one small panel under its sliders: the
   * view (by project or by recency) and, by project, the order, as two
   * segmented choices; then what folds away, as switches; then the open
   * project's own setting under its name. The details of a switch sit behind
   * its "i". The panel stays open while the user adjusts it; a press outside
   * or Escape puts it away. `target` is the project the last section speaks
   * for, owned by `owner`, which may be another machine's Store.
   */
  let { entries, target, owner, prefix = '' }: { entries: ProjectEntry[]; target: Project | undefined; owner: Store; prefix?: string } = $props();

  const popover = new Closing();
  let root = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  let panel = $state<HTMLDivElement>();
  const uid = $props.id();

  const projects = $derived(workspace.view === 'projects');
  /** The merged-PR switch is the project's, on cores that know it, for a repository the owner controls. */
  const merged = $derived(target && owner.owner && target.autoArchiveMergedPr !== undefined && target.repository !== false && target.kind !== 'drafts' ? target : null);
  // Bound to the project and connection on screen when the panel drew, so a stale press cannot reach another one.
  const mergedBusy = $derived(merged ? owner.connection !== 'ready' || owner.projectAutoArchiveMergedPrBusy(merged.id) : true);

  $effect(() => {
    if (!popover.open) return;
    // The panel takes the keyboard, so Tab reaches its first choice and Escape works, without a ring on a choice nobody pointed at.
    void tick().then(() => panel?.focus({ preventScroll: true }));
  });

  function toggle(event: MouseEvent): void {
    event.stopPropagation();
    popover.toggle();
  }
  function close(refocus = false): void {
    popover.hide();
    if (refocus) trigger?.focus({ preventScroll: true });
  }
  function onWindowPointerdown(event: PointerEvent): void {
    if (!popover.open || (root && event.target instanceof Node && root.contains(event.target))) return;
    // A tooltip opened from the panel lives in the top layer, outside it.
    if (event.target instanceof Element && event.target.closest('.info-bubble')) return;
    close();
  }
  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && popover.open) {
      event.stopPropagation();
      close(true);
      return;
    }
    // Inside a segmented choice the arrows move between its options, the radio way.
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'radio') return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const group = [...(event.target.parentElement?.querySelectorAll<HTMLButtonElement>('[role=radio]') ?? [])];
    const at = group.indexOf(event.target as HTMLButtonElement);
    const next = group[(at + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? group.length - 1 : 1)) % group.length];
    event.preventDefault();
    next?.click();
    next?.focus();
  }
  function setOrder(order: 'recent' | 'manual'): void {
    if (projectView.order !== order) projectView.toggle(entries);
  }
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

{#snippet segment(value: string, label: string, checked: boolean, Glyph: Component<{ size?: number }>, onclick: () => void, testid?: string)}
  <button type="button" role="radio" class="segment" class:checked aria-checked={checked} tabindex={checked ? 0 : -1} data-value={value} data-testid={testid} {onclick}>
    <Glyph size={14} /><span class="ui-label">{label}</span>
  </button>
{/snippet}

{#snippet option(value: string, label: string, checked: boolean, Glyph: Component<{ size?: number }>, hint: string, onclick: () => void, disabled = false)}
  {@const id = `${uid}-${value}`}
  <div class="option" class:disabled>
    <label class="option-label" for={id}><span class="glyph" aria-hidden="true"><Glyph size={15} /></span><span class="ui-label" id="{id}-name">{label}</span></label>
    <InfoTip text={hint} topic={label} testid={`${prefix}display-hint-${value}`} />
    <button {id} type="button" role="switch" aria-labelledby="{id}-name" class="switch" class:on={checked} aria-checked={checked} data-value={value} {disabled} {onclick}><span class="knob" aria-hidden="true"></span></button>
  </div>
{/snippet}

<div class="display-options" bind:this={root}>
  <button type="button" class="ghost icon small trigger" bind:this={trigger} aria-haspopup="dialog" aria-expanded={popover.open}
    aria-label={strings.sidebar.groupingOptions} title={strings.sidebar.groupingOptions} data-testid={`${prefix}grouping-options`} onclick={toggle}>
    <SlidersHorizontal size={15} />
  </button>
  {#if popover.shown}
    <div
      bind:this={panel}
      class="panel"
      class:closing={popover.closing}
      role="dialog"
      tabindex="-1"
      aria-label={strings.sidebar.groupingOptions}
      data-testid={`${prefix}grouping-options-menu`}
      {onkeydown}
      use:popover.attach
      use:floating={{ anchor: () => trigger ?? null, placement: 'bottom', align: 'end', dismiss: () => close() }}
      onanimationend={popover.end}
    >
      <section>
        <h3 class="ui-label" id="{uid}-view">{strings.sidebar.displayView}</h3>
        <div class="segmented" role="radiogroup" aria-labelledby="{uid}-view">
          {@render segment('view:projects', strings.sidebar.projectsView, projects, Folder, () => workspace.setView('projects'))}
          {@render segment('view:recent', strings.sidebar.recentView, !projects, List, () => workspace.setView('recent'))}
        </div>
      </section>
      {#if projects && entries.length}
        <section>
          <h3 class="ui-label" id="{uid}-order">{strings.sidebar.displayOrder}</h3>
          <div class="segmented" role="radiogroup" aria-labelledby="{uid}-order" data-testid={`${prefix}project-sort`} data-order={projectView.order}>
            {@render segment('order:recent', strings.sidebar.recentOrder, projectView.order === 'recent', ArrowDownWideNarrow, () => setOrder('recent'))}
            {@render segment('order:manual', strings.sidebar.customOrderShort, projectView.order === 'manual', GripVertical, () => setOrder('manual'))}
          </div>
        </section>
      {/if}
      <section>
        <h3 class="ui-label">{strings.sidebar.displayGroup}</h3>
        {@render option('working', strings.sidebar.groupWorkingRow, recentPreferences.groupWorking, LoaderCircle, strings.settings.groupWorkingThreadsHint,
          () => recentPreferences.setGroupWorking(!recentPreferences.groupWorking))}
        {#if projects}
          {@render option('other', strings.sidebar.groupIdleRow, recentPreferences.groupOtherProjects, Folders, strings.settings.groupOtherProjectsHint,
            () => recentPreferences.setGroupOtherProjects(!recentPreferences.groupOtherProjects))}
        {/if}
      </section>
      {#if merged}
        {@const project = merged}
        <section>
          <h3 class="ui-label project"><ProjectTile {project} store={owner} size={14} /><span>{projectName(project)}</span></h3>
          {@render option('merged', strings.sidebar.autoArchiveMergedPr, project.autoArchiveMergedPr === true, GitMerge, strings.sidebar.autoArchiveMergedPrHint,
            () => { if (!mergedBusy) void owner.setProjectAutoArchiveMergedPr(project.id, !project.autoArchiveMergedPr); }, mergedBusy)}
        </section>
      {/if}
    </div>
  {/if}
</div>

<style>
  .display-options { position: relative; display: inline-flex; }
  .trigger[aria-expanded='true'] { background: var(--color-surface-3); color: var(--color-foreground); }
  .panel {
    width: min(292px, calc(100vw - 24px));
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-e2);
    font-size: var(--text-sm);
    z-index: 40;
    animation: pop var(--dur-2) var(--ease-out-quint);
    transform-origin: top right;
    outline: none;
  }
  .panel.closing { animation-name: pop-out; pointer-events: none; }
  section { display: flex; flex-direction: column; gap: 2px; padding: 4px 4px 6px; }
  section + section { border-top: 1px solid var(--color-border); padding-top: 8px; }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 0 4px 4px;
    color: var(--color-subtle);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  h3.project span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); }
  /* Two choices side by side: the chosen one lifts out of the track. */
  .segmented {
    display: grid;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-md);
    background: var(--color-edge);
  }
  .segment {
    min-width: 0;
    height: 28px;
    gap: 6px;
    padding: 0 8px;
    border: none;
    border-radius: calc(var(--radius-md) - 2px);
    background: transparent;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    font-weight: 500;
    transition: background var(--dur-2) var(--ease-out-quint), color var(--dur-2) var(--ease-out-quint), box-shadow var(--dur-2) var(--ease-out-quint);
  }
  .segment span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .segment :global(svg) { flex: none; }
  .segment:hover:not(.checked) { color: var(--color-foreground); background: var(--color-hover); }
  .segment.checked { background: var(--color-active); color: var(--color-foreground); box-shadow: var(--shadow-control); }
  .segment.checked :global(svg) { color: var(--color-accent); }
  .option {
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 34px;
    padding: 0 2px 0 4px;
    border-radius: var(--radius-sm);
  }
  .option:hover { background: var(--color-hover); }
  .option.disabled { opacity: .55; }
  .option-label { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--color-foreground); }
  .option-label span:last-child { min-width: 0; overflow-wrap: anywhere; line-height: 1.3; padding: 6px 0; }
  .glyph { display: inline-flex; flex: none; color: var(--color-muted-foreground); }
  .option :global(.info-tip) { flex: none; margin: 0 4px 0 0; }
  .switch {
    position: relative;
    flex: none;
    width: 32px;
    height: 20px;
    padding: 0;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-full);
    background: var(--color-surface-3);
    transition: background var(--dur-2) var(--ease-out-quint), border-color var(--dur-2) var(--ease-out-quint);
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--color-muted-foreground);
    transition: transform var(--dur-2) var(--ease-out-quint), background var(--dur-2) var(--ease-out-quint);
  }
  /* The app's switch (app.css), a size down for a panel row. */
  .switch.on { background: var(--color-foreground); border-color: var(--color-foreground); }
  .switch.on .knob { transform: translateX(12px); background: var(--color-background); }
  .switch:hover:not(:disabled):not(.on) { border-color: var(--color-muted-foreground); }
  .switch:focus-visible { outline: 2px solid var(--color-foreground); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .switch, .knob, .segment { transition: none; } }
  @media (max-width: 720px) {
    .trigger { width: var(--control-touch); height: var(--control-touch); }
    .panel { width: auto; padding: 10px 8px max(10px, env(safe-area-inset-bottom)); }
    .segment { height: 36px; }
    .option { min-height: var(--touch-target); }
  }
</style>
