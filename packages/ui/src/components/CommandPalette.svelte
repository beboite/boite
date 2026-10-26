<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { CornerDownLeft, Search } from '@lucide/svelte';
  import type { Project, ProjectId, ThreadSummary } from '@boite/contracts';
  import { Closing } from '../lib/closing.svelte';
  import { minuteClock } from '../lib/clock.svelte';
  import { appCommands, runCommand } from '../lib/commands.svelte';
  import { focusComposer, focusedElement, restoreFocus } from '../lib/focus';
  import { projectName } from '../lib/format';
  import { PALETTE_LIMIT, RECENT_THREADS, rankItems, sectionRows, type PaletteItem } from '../lib/palette';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { workspace, type Machine } from '../lib/workspace.svelte';
  import MachineIcon from './MachineIcon.svelte';
  import ProjectTile from './ProjectTile.svelte';
  import StatusMark from './StatusMark.svelte';
  import ThreadState from './ThreadState.svelte';
  import { threadTone } from '../lib/thread-state';

  let { store }: { store: Store } = $props();

  const overlay = new Closing();
  let query = $state('');
  let selected = $state(0);
  let input = $state<HTMLInputElement | undefined>(undefined);
  let list = $state<HTMLDivElement | undefined>(undefined);
  let dialog = $state<HTMLDivElement | undefined>(undefined);
  /** What had the keyboard before the palette took it, where it goes back on close. */
  let previous: HTMLElement | null = null;

  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  const now = $derived(minuteClock.now);

  $effect(() => {
    if (!store.paletteOpen) {
      overlay.hide();
      // Shut from outside (the Ctrl+K chord again): the focus would die with the input.
      untrack(() => {
        const active = document.activeElement;
        if (active === document.body || (active && dialog?.contains(active))) restoreFocus(previous);
        previous = null;
      });
      return;
    }
    untrack(() => (previous = focusedElement()));
    query = '';
    selected = 0;
    overlay.show();
    void tick().then(() => input?.focus({ preventScroll: true }));
  });

  /** What a row or a heading draws beside its words: the thread, its project, its machine. */
  interface Place {
    machine: Machine;
    project: Project | null;
    thread: ThreadSummary | null;
  }

  let machines = $derived(workspace.machinesOr(store));
  /** One machine names no machine. */
  let several = $derived(workspace.machines.length > 1);

  /** Every live thread, most recent first; the list cuts it to the recents until something is typed. */
  let threadData = $derived.by(() => {
    const entries: { item: PaletteItem; at: number }[] = [];
    const places = new Map<string, Place>();
    for (const machine of machines) {
      for (const thread of machine.store.threads) {
        if (thread.archived || thread.incognito) continue;
        const project = machine.store.projects.find(p => p.id === thread.projectId) ?? null;
        const id = `thread:${machine.store.threadKey(thread.id)}`;
        const section = `in:${machine.id}:${thread.projectId}`;
        places.set(id, { machine, project, thread });
        if (!places.has(section)) places.set(section, { machine, project, thread: null });
        entries.push({ at: thread.lastUserMessageAt ?? thread.createdAt, item: {
          id,
          kind: 'thread',
          label: thread.title,
          // What a query may also land on: the project and the machine, never drawn on the row.
          hint: [project ? projectName(project) : '', several ? machine.label : ''].filter(Boolean).join(' '),
          keywords: thread.status,
          section
        } });
      }
    }
    return { items: entries.sort((a, b) => b.at - a.at).map(entry => entry.item), places };
  });

  /** Every project, a new thread in it once picked: offered only to a query, nothing typed keeps the list short. */
  let projectData = $derived.by(() => {
    const items: PaletteItem[] = [];
    const places = new Map<string, Place>();
    for (const machine of machines) {
      for (const project of machine.store.projects) {
        if (project.archived) continue;
        const id = `project:${JSON.stringify([machine.id, project.id])}`;
        places.set(id, { machine, project, thread: null });
        items.push({ id, kind: 'project', label: projectName(project), hint: [several ? machine.label : '', project.path].filter(Boolean).join(' '), keywords: strings.palette.newThreadWords });
      }
    }
    return { items, places };
  });

  let commandItems = $derived.by((): PaletteItem[] => appCommands(store, inShell));

  const snapshot = { rows: [] as PaletteItem[] };
  /** The ranked rows, a project's threads, the projects and the commands mixed until `sections` cuts them. */
  let ranked = $derived.by((): PaletteItem[] => {
    // Keep the exit animation's rows without subscribing a closed search to live updates.
    if (!store.paletteOpen) return snapshot.rows;
    const typed = query.trim().length > 0;
    const threads = typed ? threadData.items : threadData.items.slice(0, RECENT_THREADS);
    const projects = typed ? projectData.items : [];
    return snapshot.rows = rankItems(query, [...threads, ...projects, ...commandItems], PALETTE_LIMIT);
  });
  let sections = $derived(sectionRows(ranked));
  /** The rows in the order they are drawn: what the arrows walk. */
  let rows = $derived(sections.flatMap(section => section.items));

  // The walk starts over on what the user typed, never on the list being
  // rebuilt: the core pushes a `thread.updated` a second per live agent, and
  // the selection cannot jump back to the top under his fingers.
  $effect(() => {
    void query;
    untrack(() => (selected = 0));
  });

  /** A shorter list keeps the keyboard on a row that is still there. */
  $effect(() => {
    const count = rows.length;
    untrack(() => {
      if (selected >= count) selected = Math.max(0, count - 1);
    });
  });

  $effect(() => {
    const row = list?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    // jsdom draws nothing and has no scrollIntoView; a real list keeps the row in view.
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  });

  function close() {
    store.paletteOpen = false;
    restoreFocus(previous);
  }

  function pick(item: PaletteItem) {
    close();
    if (item.kind === 'thread') {
      if (workspace.machines.length) void workspace.openNotification(item.id.slice('thread:'.length));
      else { store.showChat(); void store.open(item.id.slice('thread:'.length)); }
      return;
    }
    if (item.kind === 'project') {
      void newThreadIn(item.id);
      return;
    }
    runCommand(store, item.id, inShell);
  }

  /** A fresh draft in that project on that machine, the keyboard in its composer. */
  async function newThreadIn(id: string) {
    const [machineId, projectId] = JSON.parse(id.slice('project:'.length)) as [string, ProjectId];
    const target = machines.find(m => m.id === machineId)?.store ?? store;
    if (workspace.machines.length) await workspace.select(target, undefined, projectId, { fresh: true });
    else {
      store.showChat();
      store.startDraft(projectId, { fresh: true });
    }
    await tick();
    focusComposer();
  }

  /** On the whole dialog, so a key pressed with a row focused never reaches the window's Escape. */
  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Tab') {
      // The field is the one stop: the rows are walked with the arrows.
      event.preventDefault();
      input?.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Enter') {
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      const item = rows[selected];
      if (item) pick(item);
      return;
    }
    if (rows.length === 0) return;
    if (event.key === 'ArrowDown') selected = (selected + 1) % rows.length;
    else if (event.key === 'ArrowUp') selected = (selected - 1 + rows.length) % rows.length;
    else if (event.key === 'Home') selected = 0;
    else if (event.key === 'End') selected = rows.length - 1;
    else return;
    event.preventDefault();
  }

  function placeOf(id: string): Place | null {
    return threadData.places.get(id) ?? projectData.places.get(id) ?? null;
  }

  /** The first row of a section, so the walk keeps one index across headings. */
  function offset(at: number): number {
    let count = 0;
    for (let i = 0; i < at; i++) count += sections[i]!.items.length;
    return count;
  }
</script>

{#if overlay.shown}
  <div
    class="scrim"
    class:closing={overlay.closing}
    role="presentation"
    use:overlay.attach
    onanimationend={overlay.end}
    onclick={(event) => {
      if (event.target === event.currentTarget) close();
    }}
  >
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="palette" class:closing={overlay.closing} role="dialog" aria-modal="true" tabindex="-1" aria-label={strings.palette.placeholder} data-testid="palette" bind:this={dialog} {onkeydown}>
      <label class="field">
        <Search size={16} strokeWidth={1.75} />
        <input
          bind:this={input}
          bind:value={query}
          placeholder={strings.palette.placeholder}
          aria-label={strings.palette.placeholder}
          autocomplete="off"
          spellcheck="false"
          data-testid="palette-input"
        />
        <span class="kbd ui-label-box"><span class="ui-label">Esc</span></span>
      </label>
      <div class="list" role="listbox" bind:this={list} data-testid="palette-list">
        {#each sections as section, at (section.id)}
          {@const first = offset(at)}
          {@const heading = section.kind === 'thread' ? placeOf(section.id) : null}
          <div class="section" data-testid="palette-section" data-section={section.id}>
            {#if heading}
              <div class="section-label project-label" data-testid="palette-project">
                {#if heading.project}<ProjectTile project={heading.project} store={heading.machine.store} size={16} />{/if}
                <span class="name ui-label">{heading.project ? projectName(heading.project) : strings.drafts.name}</span>
                {#if several}<span class="machine ui-label"><MachineIcon icon={heading.machine.icon} os={heading.machine.store.core?.os} size={12} />{heading.machine.label}</span>{/if}
              </div>
            {:else}
              <div class="section-label">{section.kind === 'project' ? strings.palette.projects : strings.palette.commands}</div>
            {/if}
            {#each section.items as item, n (item.id)}
              {@const index = first + n}
              {@const place = placeOf(item.id)}
              <button
                type="button"
                class="row"
                class:selected={index === selected}
                role="option"
                tabindex="-1"
                aria-selected={index === selected}
                data-index={index}
                data-testid="palette-row"
                data-palette-id={item.id}
                onmousemove={() => (selected = index)}
                onclick={() => pick(item)}
              >
                <span class="mark-slot">
                  {#if place?.thread}<StatusMark {...threadTone(place.thread.status, place.thread.unread)} />
                  {:else if item.kind === 'project' && place?.project}<ProjectTile project={place.project} store={place.machine.store} size={16} />{/if}
                </span>
                <span class="label ui-label">{item.label}</span>
                {#if place?.thread}
                  <span class="state"><ThreadState thread={place.thread} {now} subagents={place.machine.store.subagents(place.thread.id)} away={place.machine.store.connection !== 'ready'} /></span>
                {:else if item.kind === 'project' && place}
                  <span class="meta ui-label">{#if several}<MachineIcon icon={place.machine.icon} os={place.machine.store.core?.os} size={12} />{place.machine.label}{' · '}{/if}{strings.palette.newThread}</span>
                {:else if item.hint}
                  <span class="kbd ui-label-box"><span class="ui-label">{item.hint}</span></span>
                {/if}
                <span class="enter" aria-hidden="true"><CornerDownLeft size={13} strokeWidth={2} /></span>
              </button>
            {/each}
          </div>
        {/each}
        {#if rows.length === 0}
          <p class="empty subtle">{strings.palette.empty}</p>
        {/if}
      </div>
      <!-- With nothing to open, Enter does nothing: the foot names only the way out. -->
      <div class="foot subtle">{rows.length === 0 ? strings.palette.hintEmpty : strings.palette.hint}</div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: min(14vh, 120px);
    background: var(--color-scrim);
    animation: fade var(--dur-2) var(--ease-out-quint);
  }

  .scrim.closing {
    animation-name: fade-out;
    pointer-events: none;
  }

  .palette {
    width: min(560px, calc(100vw - 32px));
    max-height: min(70vh, 520px);
    display: flex;
    flex-direction: column;
    background: var(--color-surface);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-e3);
    overflow: hidden;
    animation: pop var(--dur-2) var(--ease-out-quint);
  }

  .palette.closing {
    animation-name: pop-out;
  }

  /* The list scrolls, the field and the foot keep their height. */
  .field,
  .foot {
    flex: none;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 48px;
    padding: 0 14px;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-subtle);
  }

  .field input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: none;
    background: transparent;
    font-size: var(--text-md);
    color: var(--color-foreground);
  }

  .field input:focus {
    outline: none;
  }

  .list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 6px;
  }

  .section + .section {
    margin-top: 4px;
  }

  .section-label {
    padding: 8px 10px 4px;
  }

  /* A project heading reads like the sidebar's: tile, name, then its machine. */
  .project-label {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    text-transform: none;
    letter-spacing: normal;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-foreground);
  }

  .project-label .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .machine {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    font-weight: 400;
    color: var(--color-muted-foreground);
  }

  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    height: var(--row);
    padding: 0 10px;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-foreground);
    text-align: left;
    justify-content: flex-start;
  }

  .row:hover:not(:disabled) {
    background: transparent;
  }

  /* The row Enter takes: the accent's wash, a bar on its edge and the Enter glyph, readable in both themes. */
  .row.selected {
    background: var(--color-accent-soft);
    box-shadow: inset 2px 0 0 var(--color-accent);
  }

  .enter {
    display: inline-flex;
    flex: none;
    width: 13px;
    color: var(--color-accent);
    opacity: 0;
  }

  .row.selected .enter {
    opacity: 1;
  }

  .row:active:not(:disabled) {
    transform: none;
  }

  .mark-slot {
    display: inline-flex;
    width: 16px;
    justify-content: center;
    flex: none;
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 400;
  }

  .state,
  .meta {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }

  .kbd {
    flex: none;
  }

  .empty {
    padding: 14px 10px;
    text-align: center;
    font-size: var(--text-sm);
  }

  .foot {
    padding: 6px 14px 8px;
    border-top: 1px solid var(--color-border);
    font-size: var(--text-xs);
  }
</style>
