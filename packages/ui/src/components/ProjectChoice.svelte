<script lang="ts">
  import { tick, untrack, type Snippet } from 'svelte';
  import { Check, FolderOpen, Search } from '@lucide/svelte';
  import type { Project, ProjectId } from '@boite/contracts';
  import { Closing } from '../lib/closing.svelte';
  import { focusComposer, focusInitial } from '../lib/focus';
  import { mobileOverlay } from '../lib/mobile-history';
  import { homePath, projectName } from '../lib/format';
  import { scoreFields, type SearchField } from '../lib/palette';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { workspace, type Machine } from '../lib/workspace.svelte';
  import MachineIcon from './MachineIcon.svelte';
  import ProjectTile from './ProjectTile.svelte';

  /**
   * The draft's project dropdown: a search field over every machine's drafts
   * and projects, grouped by machine when there are several, and for the owner
   * the way to open a folder. The keyboard stays in the field: the arrows move
   * the highlighted row and Enter takes it. Typing ranks every machine's rows
   * in one list, each word on the name, the machine or the folder ("boite m2"),
   * and a pick hands the keyboard back to the composer. The find chord opens it
   * on a draft (`store.projectChoiceRequest`).
   */
  /** `phone`: the copy the phone's welcome draws; the find chord opens the one the width shows. */
  let { store, testid, phone = false, selection, children }: {
    store: Store; testid: string; phone?: boolean; children: Snippet;
    /** Reuse the search for an action on an existing project, without changing the draft. */
    selection?: {
      machines: Machine[];
      projects: (owner: Store) => readonly Project[];
      onpick: (owner: Store, project: Project) => void;
      label: string;
      empty: string;
    };
  } = $props();

  const OPEN_FOLDER = 'open-folder';

  interface Row {
    id: string;
    label: string;
    /** The folder, home folded to `~`: what tells two projects of one name apart. */
    hint: string;
    /** The full folder or the drafts' explanation, under the pointer. */
    title: string;
    active: boolean;
    tile: { project: Project; store: Store } | null;
    machine: Machine;
    /** What a query word may land on: the name, the machine, the folder. */
    fields: SearchField[];
  }

  interface Group {
    /** The machine's id: two machines can carry the same label. */
    id: string;
    /** Null on one machine, or on a ranked list where every row names its own. */
    machine: Machine | null;
    rows: Row[];
  }

  const popover = new Closing();
  /** One machine names no machine. */
  const machines = $derived(selection?.machines ?? workspace.machinesOr(store));
  const label = $derived(selection?.label ?? strings.thread.changeProject);
  const openFolder = $derived(!selection && store.owner);
  let several = $derived(workspace.machines.length > 1 || machines.length > 1);
  let trigger = $state<HTMLButtonElement | undefined>(undefined);
  let input = $state<HTMLInputElement | undefined>(undefined);
  let list = $state<HTMLDivElement | undefined>(undefined);
  const listId = `project-choice-${Math.random().toString(36).slice(2)}`;
  let query = $state('');
  let highlight = $state(0);
  /** Opened by the find chord: the search takes the keys even on a phone, where a tap leaves the keyboard down. */
  let byKeyboard = false;

  /** Every machine's drafts first, whether the core has made them yet or not, then its live projects. */
  let groups = $derived.by<Group[]>(() => {
    // The machine on screen first: its projects are the likeliest pick.
    const ordered = [...machines.filter((m) => m.store === store), ...machines.filter((m) => m.store !== store)];
    const fields = (name: string, machine: Machine, path: string): SearchField[] => [
      { text: name },
      ...(several ? [{ text: machine.label, penalty: 5 }] : []),
      ...(path ? [{ text: path, penalty: 15 }] : [])
    ];
    return ordered.map((machine) => {
      const here = machine.store === store;
      const drafts = selection ? undefined : machine.store.draftsProject;
      const rows: Row[] = [
        ...(!selection ? [{
          id: JSON.stringify([machine.id, null]),
          label: strings.drafts.name,
          hint: drafts ? homePath(drafts.path) : '',
          title: strings.drafts.hint,
          active: here && store.draftInDrafts,
          tile: drafts ? { project: drafts, store: machine.store } : null,
          machine,
          fields: fields(strings.drafts.name, machine, '')
        }] : []),
        ...(selection ? selection.projects(machine.store) : machine.store.projects)
          .filter((entry) => entry.id !== drafts?.id && entry.archived !== true)
          .map((entry) => ({
            id: JSON.stringify([machine.id, entry.id]),
            label: projectName(entry),
            hint: homePath(entry.path),
            title: entry.path,
            active: !selection && here && entry.id === store.draft?.projectId,
            tile: { project: entry, store: machine.store },
            machine,
            fields: fields(projectName(entry), machine, entry.path)
          }))
      ];
      return { id: machine.id, machine: several ? machine : null, rows };
    }).filter(group => group.rows.length > 0);
  });

  /** Typed, one list over every machine, best first, the palette's ranking (`lib/palette.ts`). */
  let typed = $derived(query.trim().length > 0);
  let shown = $derived.by<Group[]>(() => {
    if (!typed) return groups;
    const ranked = groups
      .flatMap((group) => group.rows)
      .map((row, at) => ({ row, at, score: scoreFields(query, row.fields) }))
      .filter((entry): entry is { row: Row; at: number; score: number } => entry.score !== null && entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.at - b.at)
      .map((entry) => entry.row);
    return ranked.length ? [{ id: 'ranked', machine: null, rows: ranked }] : [];
  });

  /** What the arrows walk: the rows in screen order, then opening a folder. */
  let order = $derived([...shown.flatMap((group) => group.rows.map((row) => row.id)), ...(openFolder ? [OPEN_FOLDER] : [])]);
  let empty = $derived(shown.length === 0);

  $effect(() => {
    void query;
    highlight = 0;
  });

  /**
   * The find chord on a draft: only the copy on screen opens, the phone's
   * heading or the computer's. Each machine's store counts its own asks, so a
   * draft moved to another machine starts from that one's count and opens nothing.
   */
  let seen = untrack(() => ({ store, request: store.projectChoiceRequest }));
  $effect(() => {
    const owner = store;
    const request = owner.projectChoiceRequest;
    if (seen.store !== owner || request === seen.request) {
      seen = { store: owner, request };
      return;
    }
    seen = { store: owner, request };
    untrack(() => {
      if (selection || !trigger || window.matchMedia('(max-width: 720px)').matches !== phone) return;
      if (popover.open) input?.focus({ preventScroll: true });
      else open(true);
    });
  });

  /** The field takes the keyboard on a desktop; on a phone it would raise the keyboard over the list. */
  $effect(() => {
    if (!popover.open) return;
    void tick().then(() => {
      if (byKeyboard) input?.focus({ preventScroll: true });
      else focusInitial(input, input?.closest<HTMLElement>('[role=dialog]'));
      const at = order.findIndex((id) => shown.some((group) => group.rows.some((row) => row.id === id && row.active)));
      if (at >= 0) move(at);
    });
  });

  // A phone's Back closes the list, as it did when `floating` held it.
  $effect(() => { if (popover.open) return mobileOverlay(() => close(false)); });

  /**
   * The list opens where the command palette does, under the title bar and
   * centred, on `<body>`: from the heading it had only the space above it,
   * three rows on a laptop.
   */
  function portal(node: HTMLElement) {
    document.body.append(node);
    return { destroy: () => node.remove() };
  }

  function open(keyboard = false) {
    byKeyboard = keyboard;
    query = '';
    highlight = 0;
    popover.show();
  }

  /** Closed from the keyboard, it gives the keys to the composer: the next thing typed is the prompt. */
  function close(refocus: boolean) {
    popover.hide();
    if (refocus && (selection || !focusComposer())) trigger?.focus({ preventScroll: true });
  }

  function move(at: number) {
    highlight = at;
    // The folder action sits outside the scrolled list and is always in view.
    list?.querySelector<HTMLElement>(`#${listId}-${at}`)?.scrollIntoView?.({ block: 'nearest' });
  }

  async function pick(id: string) {
    popover.hide();
    if (selection) {
      const row = groups.flatMap(group => group.rows).find(row => row.id === id);
      if (row?.tile) selection.onpick(row.machine.store, row.tile.project);
      trigger?.focus({ preventScroll: true });
      return;
    }
    if (id === OPEN_FOLDER) {
      store.projectPickerOpen = true;
      return;
    }
    const [machineId, projectId] = JSON.parse(id) as [string, ProjectId | null];
    const target = workspace.machines.find((m) => m.id === machineId)?.store ?? store;
    if (target === store) store.setDraftProject(projectId);
    else if (projectId !== null) await workspace.select(target, undefined, projectId);
    else await workspace.select(target).then(() => target.startDraft(null));
    // Another machine draws its own composer: the focus waits for it.
    await tick();
    focusComposer();
  }

  function onTriggerKeydown(event: KeyboardEvent) {
    if (popover.open && event.key === 'Escape') {
      event.stopPropagation();
      popover.hide();
      return;
    }
    if (popover.open || event.key !== 'ArrowDown') return;
    event.preventDefault();
    open(true);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Tab') {
      // Modal: the page behind the scrim takes no keys. The rows are walked with the arrows.
      event.preventDefault();
      input?.focus({ preventScroll: true });
      return;
    }
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
      event.preventDefault();
      // A query nothing answers takes nothing: Enter is not a way to open a folder.
      if (!id || (id === OPEN_FOLDER && typed && empty)) return;
      void pick(id);
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

<div class="choice">
  <button
    type="button"
    class="trigger"
    class:chip={!!selection}
    aria-haspopup="dialog"
    aria-expanded={popover.open}
    aria-label={label}
    title={label}
    data-testid={testid}
    bind:this={trigger}
    onclick={(event) => { event.stopPropagation(); if (popover.open) popover.hide(); else open(); }}
    onkeydown={onTriggerKeydown}
  >
    {@render children()}
  </button>

  {#if popover.shown}
    <div
      class="scrim"
      class:closing={popover.closing}
      role="presentation"
      use:portal
      use:popover.attach
      onanimationend={popover.end}
      onclick={(event) => { if (event.target === event.currentTarget) close(false); }}
    >
    <div
      class="popover"
      class:closing={popover.closing}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabindex="-1"
      {onkeydown}
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

      <div class="rows" role="listbox" id={listId} aria-label={label} bind:this={list} data-testid="{testid}-list">
        {#each shown as group (group.id)}
          {#if group.machine}<div class="group ui-label" role="presentation"><MachineIcon icon={group.machine.icon} os={group.machine.store.core?.os} size={12} />{group.machine.label}</div>{/if}
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
              title={row.title}
              onpointermove={() => (highlight = order.indexOf(row.id))}
              onclick={() => void pick(row.id)}
            >
              {#if row.tile}<ProjectTile project={row.tile.project} store={row.tile.store} size={20} />{:else}<span class="blank" aria-hidden="true"><FolderOpen size={14} strokeWidth={1.75} /></span>{/if}
              <span class="name ui-label">{row.label}</span>
              <span class="hint ui-label">{row.hint}</span>
              {#if typed && several}<span class="machine ui-label"><MachineIcon icon={row.machine.icon} os={row.machine.store.core?.os} size={12} />{row.machine.label}</span>{/if}
              <span class="check" aria-hidden="true">{#if row.active}<Check size={15} strokeWidth={2} />{/if}</span>
            </button>
          {/each}
        {/each}
        {#if empty}<p class="empty" data-testid="{testid}-empty">{!typed && selection ? selection.empty : fill(strings.thread.noProjectMatch, { query: query.trim() })}</p>{/if}
      </div>

      {#if openFolder}
        <button
          type="button"
          class="row folder"
          class:highlight={order[highlight] === OPEN_FOLDER && !(typed && empty)}
          tabindex="-1"
          id={optionId(OPEN_FOLDER)}
          data-row
          data-value={OPEN_FOLDER}
          onpointermove={() => (highlight = order.indexOf(OPEN_FOLDER))}
          onclick={() => void pick(OPEN_FOLDER)}
        >
          <span class="blank" aria-hidden="true"><FolderOpen size={14} strokeWidth={1.75} /></span>
          <span class="name ui-label">{strings.drafts.pickFolder}</span>
        </button>
      {/if}
    </div>
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
    gap: 6px;
  }

  .trigger:not(.chip) {
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

  .trigger:not(.chip):hover,
  .trigger:not(.chip)[aria-expanded='true'] {
    background: var(--color-hover);
  }

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

  .popover {
    width: min(520px, calc(100vw - 24px));
    max-height: min(70vh, 520px);
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
    overflow: hidden;
    animation: pop var(--dur-2) var(--ease-out-quint);
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
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 8px 4px;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  /* One line a project: its tile, its name, its folder, then the machine and the mark. */
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: auto;
    min-height: var(--row);
    padding: 4px 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-foreground);
    text-align: left;
    cursor: pointer;
  }

  /* The row Enter takes, as in the command palette: the accent's wash and a bar on its edge. */
  .row.highlight {
    background: var(--color-accent-soft);
    box-shadow: inset 2px 0 0 var(--color-accent);
  }

  .row:active {
    transform: none;
    background: var(--color-active);
  }

  .check {
    flex: none;
    display: inline-flex;
    width: 15px;
    color: var(--color-accent);
  }

  .machine {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
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

  .name {
    flex: none;
    max-width: 55%;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .folder .name {
    flex: 1;
    max-width: none;
    font-weight: 400;
    color: var(--color-muted-foreground);
  }

  .folder.highlight .name {
    color: var(--color-foreground);
  }

  /* After the name, filling the line: a long path ends in an ellipsis, the full one is in the title. */
  .hint {
    flex: 1;
    min-width: 0;
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
    .scrim { padding-top: 12px; }
    .search { height: var(--control-touch); }
    .row { min-height: var(--touch-target); }
  }
</style>
