<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { Check, FolderOpen, Search } from '@lucide/svelte';
  import type { Project, ProjectId } from '@boite/contracts';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import { fitMenu } from '../lib/menu-fit';
  import { projectName } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import ProjectTile from './ProjectTile.svelte';

  /**
   * The draft's project dropdown: a search field over every machine's drafts
   * and projects, grouped by machine when there are several, and for the owner
   * the way to open a folder. The keyboard stays in the field: the arrows move
   * the highlighted row and Enter takes it.
   */
  let { store, testid, children }: { store: Store; testid: string; children: Snippet } = $props();

  const OPEN_FOLDER = 'open-folder';

  interface Row {
    id: string;
    label: string;
    hint: string;
    active: boolean;
    tile: { project: Project; store: Store } | null;
    /** Name, path and machine, lowercased without accents: what the search reads. */
    haystack: string;
    name: string;
  }

  interface Group {
    /** The machine's id: two machines can carry the same label. */
    id: string;
    label: string;
    rows: Row[];
  }

  const popover = new Closing();
  let root = $state<HTMLDivElement | undefined>(undefined);
  let trigger = $state<HTMLButtonElement | undefined>(undefined);
  let input = $state<HTMLInputElement | undefined>(undefined);
  let list = $state<HTMLDivElement | undefined>(undefined);
  let panel = $state<HTMLDivElement | undefined>(undefined);
  const listId = `project-choice-${Math.random().toString(36).slice(2)}`;
  let query = $state('');
  let highlight = $state(0);

  function fold(text: string): string {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  /** Every machine's drafts first, whether the core has made them yet or not, then its live projects. */
  let groups = $derived.by<Group[]>(() => {
    const machines = workspace.machines.length ? workspace.machines : [{ id: '', label: '', store }];
    const several = workspace.machines.length > 1;
    return machines.map((machine) => {
      const here = machine.store === store;
      const drafts = machine.store.draftsProject;
      const place = several ? machine.label : '';
      const rows: Row[] = [
        {
          id: JSON.stringify([machine.id, null]),
          label: strings.drafts.name,
          hint: strings.drafts.hint,
          active: here && store.draftInDrafts,
          tile: drafts ? { project: drafts, store: machine.store } : null,
          haystack: fold(`${strings.drafts.name} ${place}`),
          name: fold(strings.drafts.name)
        },
        ...machine.store.projects
          .filter((entry) => entry.id !== drafts?.id && entry.archived !== true)
          .map((entry) => ({
            id: JSON.stringify([machine.id, entry.id]),
            label: projectName(entry),
            hint: entry.path,
            active: here && entry.id === store.draft?.projectId,
            tile: { project: entry, store: machine.store },
            haystack: fold(`${projectName(entry)} ${entry.path} ${place}`),
            name: fold(projectName(entry))
          }))
      ];
      return { id: machine.id, label: place, rows };
    });
  });

  /**
   * Every word has to appear somewhere in the row. A name that starts with the
   * query comes first, then a name that holds it, then a path or a machine.
   */
  let shown = $derived.by<Group[]>(() => {
    const words = fold(query).split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) return groups;
    const whole = words.join(' ');
    const rank = (row: Row) => (row.name.startsWith(whole) ? 0 : row.name.includes(whole) ? 1 : 2);
    return groups
      .map((group) => ({
        id: group.id,
        label: group.label,
        rows: group.rows
          .filter((row) => words.every((word) => row.haystack.includes(word)))
          .map((row, at) => ({ row, at, rank: rank(row) }))
          .sort((a, b) => a.rank - b.rank || a.at - b.at)
          .map(({ row }) => row)
      }))
      .filter((group) => group.rows.length > 0);
  });

  /** What the arrows walk: the rows in screen order, then opening a folder. */
  let order = $derived([...shown.flatMap((group) => group.rows.map((row) => row.id)), ...(store.owner ? [OPEN_FOLDER] : [])]);
  let empty = $derived(shown.length === 0);

  $effect(() => {
    void query;
    highlight = 0;
  });

  /** The field takes the keyboard on a desktop; on a phone it would raise the keyboard over the list. */
  $effect(() => {
    if (!popover.open) return;
    void tick().then(() => {
      // Typing shrinks the list: the popover keeps the height it opened at, so
      // the field does not slide toward the trigger under the cursor.
      if (panel) panel.style.minHeight = `${panel.offsetHeight}px`;
      if (!window.matchMedia('(max-width: 720px)').matches) input?.focus({ preventScroll: true });
      const at = order.findIndex((id) => shown.some((group) => group.rows.some((row) => row.id === id && row.active)));
      if (at >= 0) move(at);
    });
    // A viewport that shrinks afterwards, a phone's keyboard or a shorter
    // window, lowers the cap `floating` sets: the frozen height gives way to it.
    const release = () => panel?.style.removeProperty('min-height');
    window.addEventListener('resize', release);
    window.visualViewport?.addEventListener('resize', release);
    return () => {
      window.removeEventListener('resize', release);
      window.visualViewport?.removeEventListener('resize', release);
    };
  });

  function open() {
    query = '';
    highlight = 0;
    popover.show();
  }

  function close(refocus: boolean) {
    popover.hide();
    if (refocus) trigger?.focus({ preventScroll: true });
  }

  function move(at: number) {
    highlight = at;
    // The folder action sits outside the scrolled list and is always in view.
    list?.querySelector<HTMLElement>(`#${listId}-${at}`)?.scrollIntoView?.({ block: 'nearest' });
  }

  function pick(id: string) {
    popover.hide();
    if (id === OPEN_FOLDER) {
      store.projectPickerOpen = true;
      return;
    }
    const [machineId, projectId] = JSON.parse(id) as [string, ProjectId | null];
    const target = workspace.machines.find((m) => m.id === machineId)?.store ?? store;
    if (target === store) store.setDraftProject(projectId);
    else if (projectId !== null) void workspace.select(target, undefined, projectId);
    else void workspace.select(target).then(() => target.startDraft(null));
  }

  function onWindowPointerdown(event: PointerEvent) {
    if (!popover.open) return;
    if (root && event.target instanceof Node && root.contains(event.target)) return;
    popover.hide();
  }

  function onTriggerKeydown(event: KeyboardEvent) {
    if (popover.open && event.key === 'Escape') {
      event.stopPropagation();
      popover.hide();
      return;
    }
    if (popover.open || event.key !== 'ArrowDown') return;
    event.preventDefault();
    open();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      // A first Escape clears what was typed, the next one closes.
      if (query !== '') query = '';
      else close(true);
      return;
    }
    if (event.key === 'Enter') {
      // Enter also confirms an input method's candidate: that one is not a pick.
      if (event.isComposing || event.keyCode === 229) return;
      const id = order[highlight];
      if (!id) return;
      event.preventDefault();
      pick(id);
      return;
    }
    if (order.length === 0) return;
    if (event.key === 'ArrowDown') move((highlight + 1) % order.length);
    else if (event.key === 'ArrowUp') move((highlight - 1 + order.length) % order.length);
    else if (event.key === 'PageDown') move(Math.min(order.length - 1, highlight + 8));
    else if (event.key === 'PageUp') move(Math.max(0, highlight - 8));
    else return;
    event.preventDefault();
  }

  const optionId = (id: string) => `${listId}-${order.indexOf(id)}`;
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

<div class="choice" bind:this={root}>
  <button
    type="button"
    class="trigger"
    aria-haspopup="dialog"
    aria-expanded={popover.open}
    aria-label={strings.thread.changeProject}
    title={strings.thread.changeProject}
    data-testid={testid}
    bind:this={trigger}
    onclick={(event) => { event.stopPropagation(); if (popover.open) popover.hide(); else open(); }}
    onkeydown={onTriggerKeydown}
  >
    {@render children()}
  </button>

  {#if popover.shown}
    <div
      class="popover"
      class:closing={popover.closing}
      role="dialog"
      aria-label={strings.thread.changeProject}
      tabindex="-1"
      {onkeydown}
      bind:this={panel}
      use:popover.attach
      use:floating={{ anchor: () => trigger ?? null, placement: 'top', cap: 460, fit: fitMenu, dismiss: () => popover.hide() }}
      onanimationend={popover.end}
      data-testid="{testid}-menu"
    >
      <label class="search">
        <Search size={14} strokeWidth={1.75} />
        <input
          bind:this={input}
          bind:value={query}
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={order[highlight] ? `${listId}-${highlight}` : undefined}
          aria-autocomplete="list"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder={strings.thread.searchProjects}
          aria-label={strings.thread.searchProjects}
          data-testid="{testid}-search"
        />
      </label>

      <div class="rows" role="listbox" id={listId} aria-label={strings.thread.changeProject} bind:this={list} data-testid="{testid}-list">
        {#each shown as group (group.id)}
          {#if group.label}<div class="group ui-label" role="presentation">{group.label}</div>{/if}
          {#each group.rows as row (row.id)}
            <button
              type="button"
              class="row"
              class:highlight={order[highlight] === row.id}
              class:active={row.active}
              role="option"
              aria-selected={row.active}
              tabindex="-1"
              id={optionId(row.id)}
              data-row
              data-value={row.id}
              title={row.hint}
              onpointermove={() => (highlight = order.indexOf(row.id))}
              onclick={() => pick(row.id)}
            >
              {#if row.tile}<ProjectTile project={row.tile.project} store={row.tile.store} size={22} />{:else}<span class="blank" aria-hidden="true"><FolderOpen size={14} strokeWidth={1.75} /></span>{/if}
              <span class="text">
                <span class="name ui-label">{row.label}</span>
                <span class="hint ui-label">{row.hint}</span>
              </span>
              {#if row.active}<span class="check" aria-hidden="true"><Check size={15} strokeWidth={2} /></span>{/if}
            </button>
          {/each}
        {/each}
        {#if empty}<p class="empty" data-testid="{testid}-empty">{fill(strings.thread.noProjectMatch, { query: query.trim() })}</p>{/if}
      </div>

      {#if store.owner}
        <button
          type="button"
          class="row folder"
          class:highlight={order[highlight] === OPEN_FOLDER}
          tabindex="-1"
          id={optionId(OPEN_FOLDER)}
          data-row
          data-value={OPEN_FOLDER}
          onpointermove={() => (highlight = order.indexOf(OPEN_FOLDER))}
          onclick={() => pick(OPEN_FOLDER)}
        >
          <span class="blank" aria-hidden="true"><FolderOpen size={14} strokeWidth={1.75} /></span>
          <span class="name ui-label">{strings.drafts.pickFolder}</span>
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .choice {
    position: relative;
    display: inline-flex;
  }

  /* A word inside the heading: it takes the sentence's type and only fills under the pointer. */
  .trigger {
    cursor: pointer;
    height: auto;
    padding: 2px 6px;
    gap: 4px;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    border-radius: var(--radius-md);
    transition: background var(--dur-2) var(--ease-out-quint);
  }

  .trigger:hover,
  .trigger[aria-expanded='true'] {
    background: var(--color-hover);
  }

  .popover {
    width: min(420px, calc(100vw - 24px));
    display: flex;
    flex-direction: column;
    padding: 6px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-e2);
    /* The list reads at the body size even under the heading's large type. */
    font-size: var(--text-base);
    font-weight: 400;
    letter-spacing: normal;
    line-height: normal;
    text-align: left;
    z-index: 40;
    overflow: hidden;
    animation: pop var(--dur-2) var(--ease-out-quint);
    transform-origin: bottom left;
  }

  .popover.closing {
    animation-name: pop-out;
    pointer-events: none;
  }

  .search {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--control);
    padding: 0 10px;
    margin-bottom: 6px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-subtle);
    transition: border-color var(--dur-2) var(--ease-out-quint);
  }

  .search:focus-within {
    border-color: var(--color-edge);
    color: var(--color-muted-foreground);
  }

  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--color-foreground);
    font-size: var(--text-sm);
  }

  .search input:focus {
    outline: none;
  }

  /* Only the rows scroll: the field above and the folder action below stay put. */
  .rows {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .rows > * {
    flex: none;
  }

  .group {
    padding: 8px 8px 4px;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: auto;
    min-height: 44px;
    padding: 6px 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-foreground);
    text-align: left;
    cursor: pointer;
  }

  .row.highlight {
    background: var(--color-hover);
  }

  .row:active {
    transform: none;
    background: var(--color-active);
  }

  .check {
    flex: none;
    display: inline-flex;
    color: var(--color-muted-foreground);
  }

  .blank {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    color: var(--color-muted-foreground);
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .name {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .folder .name {
    flex: 1;
    font-weight: 400;
    color: var(--color-muted-foreground);
  }

  .folder.highlight .name {
    color: var(--color-foreground);
  }

  /* One line each: a long path ends in an ellipsis, the full one is in the title. */
  .hint {
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .folder {
    flex: none;
    min-height: var(--control);
    margin-top: 6px;
    position: relative;
  }

  .folder::before {
    content: '';
    position: absolute;
    top: -4px;
    left: 6px;
    right: 6px;
    height: 1px;
    background: var(--color-border);
  }

  .empty {
    margin: 0;
    padding: 18px 8px;
    text-align: center;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }

  @media (max-width: 720px) {
    .search { height: var(--control-touch); }
    .row { min-height: var(--touch-target); }
  }
</style>
