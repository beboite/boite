<script lang="ts">
  import { Archive, ArchiveRestore, CheckCheck, FolderX } from '@lucide/svelte';
  import type { Project, ThreadId } from '@boite/contracts';
  import { count as formatCount, projectName } from '../lib/format';
  import { archiveProjectWithUndo, projectMenu } from '../lib/project-menu';
  import { projectKey, type ProjectEntry } from '../lib/project-view.svelte';
  import type { Store } from '../lib/store.svelte';
  import { archiveCount, projectThreadView, type ProjectShelfKind } from '../lib/project-threads.svelte';
  import { fill, strings } from '../lib/strings';
  import { dropKey, takesDrop, threadDrag } from '../lib/thread-move.svelte';
  import { workspace, type Machine } from '../lib/workspace.svelte';
  import { longPress } from '../lib/long-press';
  import MachineIcon from './MachineIcon.svelte';
  import ProjectTile from './ProjectTile.svelte';
  import RecentDone from './RecentDone.svelte';

  /**
   * The rows of a fold under the project list (ProjectShelf.svelte draws the
   * fold and loads this on its own, out of the entry chunk): the idle
   * projects, with nothing to do, or the archived ones, a step quieter. One
   * compact row per project; choosing it starts a conversation there,
   * restoring an archived project first. A row's one quick action shows under
   * the pointer (archive an idle project, restore an archived one) and its
   * full menu, removal included, opens with a right click or a long press.
   * Removal never sits on the row: a pointer reaching for the quick action
   * would land on it when the hover swaps the buttons in. An idle project that
   * still has done conversations shows their count, which unfolds that history
   * under its row. With several machines the rows group under their machine.
   * `onopen` runs once a draft or a conversation opens from the fold, so the
   * phone can show it. `onrows` receives the history conversations drawn, in
   * order, for Alt+digit, none while the fold is shut.
   */
  type Row = { store: Store; threadId: ThreadId };
  let { kind, projects, open, multi, now, scrollRoot, onopen, onrows }: {
    kind: ProjectShelfKind;
    projects: ProjectEntry[];
    open: boolean;
    multi: boolean;
    now: number;
    scrollRoot?: HTMLElement;
    onopen?: () => void;
    onrows?: (rows: Row[]) => void;
  } = $props();
  const history = ['done', 'archived'] as const;
  const uid = $props.id();
  /** The row whose action is in flight, so a second click cannot race it. */
  let busy = $state<string | null>(null);

  const byName = (a: Project, b: Project) => projectName(a).localeCompare(projectName(b));
  let groups = $derived.by(() => {
    const byMachine = new Map<string, { machine: Machine; projects: Project[] }>();
    for (const { machine, project } of projects) {
      const group = byMachine.get(machine.id) ?? { machine, projects: [] };
      group.projects.push(project);
      byMachine.set(machine.id, group);
    }
    return [...byMachine.values()].map(group => ({ machine: group.machine, rows: group.projects.sort(byName) }));
  });

  const key = (machine: Machine, project: Project) => dropKey(machine.id, project.id);

  /** The rows each unfolded history last drew, by list and project; a closed one is skipped below rather than cleared. */
  let historyRows = $state.raw<Record<string, Row[]>>({});
  const observers = new Map<string, (rows: Row[]) => void>();
  const historyKey = (entry: ProjectEntry, list: (typeof history)[number]) => JSON.stringify([list, projectKey(entry)]);
  function observer(entry: ProjectEntry, list: (typeof history)[number]) {
    const at = historyKey(entry, list);
    if (!observers.has(at)) observers.set(at, rows => { historyRows = { ...historyRows, [at]: rows }; });
    return observers.get(at)!;
  }
  let reported: Row[] = [];
  $effect(() => {
    const visible = !open || kind !== 'idle' ? [] : groups.flatMap(({ machine, rows }) => rows.flatMap(project => history.flatMap(list => {
      const entry = { machine, project };
      return archiveCount(project, list) > 0 && projectThreadView.isOpen(entry, list) ? historyRows[historyKey(entry, list)] ?? [] : [];
    })));
    if (visible.length === reported.length && visible.every((row, index) => row.store === reported[index]?.store && row.threadId === reported[index]?.threadId)) return;
    reported = visible;
    onrows?.(visible);
  });
  // Unmounted once the fold empties: the rows it reported leave Alt+digit too, as RecentDone's do.
  $effect(() => () => { if (reported.length) onrows?.([]); });

  async function run(machine: Machine, project: Project, action: () => Promise<unknown>) {
    if (busy !== null) return;
    busy = key(machine, project);
    try {
      await action();
    } finally {
      busy = null;
    }
  }

  function start(event: MouseEvent, machine: Machine, project: Project) {
    const owner = machine.store;
    // No conversation can start in a folder that is gone: the menu offers what can still be done with it.
    if (kind === 'idle' && project.missing === true) return projectMenu(event, owner, project);
    void run(machine, project, async () => {
      if (kind === 'archived' && !(await owner.archiveProject(project.id, false))) return;
      if (project.missing === true) return;
      await workspace.select(owner, undefined, project.id);
      onopen?.();
    });
  }

  /** What choosing the row does, above the folder it points at: the machine is already the group's header. */
  function rowTitle(project: Project): string {
    if (project.missing === true) return kind === 'idle' ? strings.sidebar.projectMissing : `${strings.sidebar.restoreProject} ${projectName(project)}`;
    return fill(kind === 'idle' ? strings.sidebar.newThreadIn : strings.sidebar.restoreAndStart, { project: projectName(project) });
  }
</script>

{#each groups as { machine, rows } (machine.id)}
  {#if multi}
    <div class="machine" data-testid="project-shelf-machine" title={machine.label}>
      <MachineIcon icon={machine.icon} os={machine.store.core?.os} size={13} />
      <span class="machine-name ui-label">{machine.label}</span>
    </div>
  {/if}
  <ul>
    {#each rows as project (project.id)}
      {@const here = key(machine, project)}
      {@const entry = { machine, project }}
      {@const kept = kind === 'idle' ? history.filter(list => archiveCount(project, list) > 0) : []}
      {@const controls = `${uid}-${encodeURIComponent(here)}`}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <li
        class={kind}
        data-testid="{kind}-project"
        data-project-id={project.id}
        data-machine-id={machine.id}
        data-project-name={projectName(project)}
        data-thread-drop={kind === 'idle' ? '' : undefined}
        class:candidate={kind === 'idle' && takesDrop(threadDrag.current, machine.id, project.id)}
        class:drop={kind === 'idle' && threadDrag.over === here}
        aria-label={kind === 'idle' && threadDrag.over === here ? fill(strings.threadMove.dropHere, { project: projectName(project) }) : undefined}
        oncontextmenu={(event) => projectMenu(event, machine.store, project)}
        use:longPress
      >
        <div class="row">
          <button
            type="button"
            class="ghost main"
            data-testid="{kind}-project-open"
            title={`${rowTitle(project)}\n${project.path}`}
            disabled={busy !== null}
            onclick={(event) => start(event, machine, project)}
          >
            <span class="tile" aria-hidden="true"><ProjectTile {project} store={machine.store} size={16} /></span>
            <span class="name ui-label" class:gone={project.missing === true}>{projectName(project)}</span>
            {#if project.missing === true}<span class="missing" title={strings.sidebar.projectMissing}><FolderX size={13} aria-label={strings.sidebar.projectMissing} /></span>{/if}
          </button>
          {#each kept as list (list)}
            {@const count = archiveCount(project, list)}
            {@const listLabel = fill(list === 'done' ? strings.sidebar.projectDoneThreads : strings.sidebar.projectArchivedThreads, { count: String(count), project: projectName(project) })}
            <button type="button" class="ghost counter {list}" class:active={projectThreadView.isOpen(entry, list)} data-testid="project-{list}-toggle" data-count={count}
              title={listLabel} aria-label={listLabel} aria-expanded={projectThreadView.isOpen(entry, list)} aria-controls="{controls}-{list}"
              onclick={() => projectThreadView.toggle(entry, list)}>
              {#if list === 'done'}<CheckCheck size={12} aria-hidden="true" />{:else}<Archive size={12} aria-hidden="true" />{/if}<span class="ui-label">{formatCount(count)}</span>
            </button>
          {/each}
          <span class="actions">
            {#if kind === 'idle'}
              {#if project.kind !== 'drafts'}
                <button
                  type="button"
                  class="ghost small icon"
                  data-testid="idle-project-archive"
                  title={strings.sidebar.archiveProject}
                  aria-label={`${strings.sidebar.archiveProject}: ${projectName(project)}`}
                  disabled={busy !== null}
                  onclick={() => void run(machine, project, () => archiveProjectWithUndo(machine.store, project))}><Archive size={13} /></button
                >
              {/if}
            {:else}
              <button
                type="button"
                class="ghost small icon"
                data-testid="archived-project-restore"
                title={strings.sidebar.restoreProject}
                aria-label={`${strings.sidebar.restoreProject} ${projectName(project)}`}
                disabled={busy !== null}
                onclick={() => void run(machine, project, () => machine.store.archiveProject(project.id, false))}><ArchiveRestore size={13} /></button
              >
            {/if}
          </span>
        </div>
        {#each kept as list (list)}
          {#if projectThreadView.isOpen(entry, list)}
            <div id="{controls}-{list}" class="history" data-testid="project-{list}">
              <RecentDone kind={list} entries={[entry]} {scrollRoot} {now} open header={false} {onopen} onrows={observer(entry, list)} />
            </div>
          {/if}
        {/each}
      </li>
    {/each}
  </ul>
{/each}

<style>
  .machine {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px var(--fold-inset) 4px var(--fold-indent);
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .machine :global(svg) {
    flex: none;
  }
  .machine-name,
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  ul {
    margin: 0;
    padding: 0 0 6px;
    list-style: none;
  }
  li {
    border-radius: var(--radius-sm);
    transition: background var(--dur-1) var(--ease-out-quint), box-shadow var(--dur-1) var(--ease-out-quint), opacity var(--dur-1) var(--ease-out-quint);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: var(--row);
    padding-right: 2px;
    border-radius: var(--radius-sm);
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }
  .row:hover,
  .row:focus-within {
    background: var(--color-hover);
    color: var(--color-foreground);
  }
  .main {
    flex: 1;
    min-width: 0;
    height: auto;
    min-height: var(--row);
    justify-content: flex-start;
    gap: 8px;
    padding: 0 4px 0 var(--fold-indent);
    border-color: transparent;
    color: inherit;
    font-size: inherit;
    text-align: left;
  }
  /* The row draws the hover, so the button inside it does not add a second shade. */
  .row .main:hover:not(:disabled),
  .row .main:focus-visible {
    background: transparent;
  }
  .tile {
    display: flex;
    flex: none;
  }
  .row:hover .tile,
  .row:focus-within .tile {
    opacity: 1;
  }
  .name {
    flex: 1;
  }
  .name.gone {
    text-decoration: line-through;
    color: var(--color-subtle);
  }
  .missing {
    display: flex;
    flex: none;
    color: var(--color-danger);
  }
  .actions {
    display: flex;
    flex: none;
    gap: 2px;
  }
  /* An archived project reads a step quieter than an idle one; under the pointer it wakes. */
  li.archived .row { color: var(--color-subtle); }
  li.archived .tile { opacity: 0.55; filter: grayscale(0.6); }
  li.archived .row:hover, li.archived .row:focus-within { color: var(--color-foreground); }
  li.archived .row:hover .tile, li.archived .row:focus-within .tile { opacity: 1; filter: none; }
  li { -webkit-touch-callout: none; }
  .actions button {
    border-color: transparent;
  }
  /* A pointer sees a row's own buttons on the row it is over; a touch screen always does. Hidden, they take no room, so the counts stay at the edge. */
  @media (hover: hover) {
    .actions {
      display: none;
    }
    .row:hover .actions,
    .row:focus-within .actions {
      display: flex;
    }
  }
  /* Done and archived conversations an idle project still has: always shown, they are what it holds. */
  .counter {
    flex: none;
    height: 26px;
    min-width: 30px;
    padding: 0 4px;
    gap: 3px;
    border: 1px solid transparent;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  /* The project cards' pill, a size smaller: the same tint says the same thing. */
  .counter.done {
    height: 22px;
    border-radius: var(--radius-full);
    color: var(--color-success);
    background-color: color-mix(in oklch, var(--color-success) 14%, transparent);
    background-clip: padding-box;
  }
  .counter.active {
    background: var(--color-active);
    border-color: var(--color-edge);
    color: var(--color-foreground);
  }
  .history {
    padding: 0 0 4px calc(var(--fold-indent) - 8px);
  }
  @media (max-width: 720px) {
    .counter {
      min-width: var(--touch-target);
      min-height: var(--touch-target);
      padding: 0 7px;
      gap: 5px;
    }
    /* The 44px target stays; the transparent border leaves the 22px pill drawn inside it, its open ring included. */
    .counter.done { border-width: 11px 0; }
    .counter.done.active { border-color: transparent; background-clip: padding-box; box-shadow: inset 0 0 0 1px var(--color-edge); }
  }
  /* A dragged thread can land on an idle project: same dashed edge and accent fill as a project section. */
  :global(html.thread-dragging) li:not(.candidate) {
    opacity: 0.6;
  }
  li.candidate {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  }
  li.drop {
    background: var(--color-accent-soft);
    box-shadow: inset 0 0 0 1px var(--color-accent), 0 0 0 3px color-mix(in srgb, var(--color-accent) 22%, transparent);
  }
</style>
