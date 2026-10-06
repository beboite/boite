<script lang="ts">
  import { Archive, ArchiveRestore, CheckCheck, Ellipsis, FolderX, Trash2 } from '@lucide/svelte';
  import type { Project } from '@boite/contracts';
  import { count as formatCount, projectName } from '../lib/format';
  import { archiveProjectWithUndo, confirmRemoveProject, projectMenu } from '../lib/project-menu';
  import type { ProjectEntry } from '../lib/project-view.svelte';
  import { archiveCount, projectThreadView, type ProjectShelfKind } from '../lib/project-threads.svelte';
  import { fill, strings } from '../lib/strings';
  import { dropKey, takesDrop, threadDrag } from '../lib/thread-move.svelte';
  import { workspace, type Machine } from '../lib/workspace.svelte';
  import FoldHeader from './FoldHeader.svelte';
  import MachineIcon from './MachineIcon.svelte';
  import ProjectTile from './ProjectTile.svelte';
  import RecentDone from './RecentDone.svelte';

  /**
   * A fold under the project list, one compact row per project. `idle` holds
   * projects with no open conversation, `archived` those put out of the list.
   * Choosing a row starts a conversation there, restoring an archived project
   * first; the row's own buttons archive, restore or remove without opening
   * anything. An idle project that still has done or archived conversations
   * shows their counts, which unfold that history under its row. With several
   * machines the rows group under their machine. `onopen` runs once a draft or
   * a conversation opens from the fold, so the phone can show it.
   */
  let { kind, entries, multi, now, scrollRoot, onopen }: {
    kind: ProjectShelfKind;
    entries: ProjectEntry[];
    multi: boolean;
    now: number;
    scrollRoot?: HTMLElement;
    onopen?: () => void;
  } = $props();
  const history = ['done', 'archived'] as const;
  const historyLabels = { done: strings.sidebar.projectDoneThreads, archived: strings.sidebar.projectArchivedThreads };
  const uid = $props.id();
  const open = $derived(projectThreadView.shelf[kind]);
  /** Rows render from the first opening on, so a fold nobody opens loads no project icons. */
  let visited = $state(false);
  $effect.pre(() => { if (open) visited = true; });
  /** The row whose action is in flight, so a second click cannot race it. */
  let busy = $state<string | null>(null);

  let groups = $derived.by(() => {
    const byMachine = new Map<string, { machine: Machine; projects: Project[] }>();
    for (const { machine, project } of entries) {
      const group = byMachine.get(machine.id) ?? { machine, projects: [] };
      group.projects.push(project);
      byMachine.set(machine.id, group);
    }
    return [...byMachine.values()].map((group) => ({
      ...group,
      projects: [...group.projects].sort((a, b) => projectName(a).localeCompare(projectName(b)))
    }));
  });

  const key = (machine: Machine, project: Project) => dropKey(machine.id, project.id);

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

{#if entries.length > 0}
  <section class="shelf" data-testid="{kind}-projects">
    <FoldHeader label={kind === 'idle' ? strings.sidebar.idleProjects : strings.sidebar.archivedProjects} count={entries.length} {open}
      controls={uid} testid="{kind}-projects-toggle" onclick={() => (projectThreadView.shelf[kind] = !open)} />
    <div id={uid} class="motion-fold" class:expanded={open} inert={!open}><div>
      {#if visited}
        <p class="hint">{kind === 'idle' ? strings.sidebar.idleProjectsHint : strings.sidebar.archivedProjectsHint}</p>
        {#each groups as { machine, projects } (machine.id)}
          {#if multi}
            <div class="machine" data-testid="{kind}-projects-machine" title={machine.label}>
              <MachineIcon icon={machine.icon} os={machine.store.core?.os} size={11} />
              <span class="machine-name ui-label">{machine.label}</span>
            </div>
          {/if}
          <ul>
            {#each projects as project (project.id)}
              {@const here = key(machine, project)}
              {@const entry = { machine, project }}
              {@const kept = kind === 'idle' ? history.filter(list => archiveCount(project, list) > 0) : []}
              {@const controls = `${uid}-${encodeURIComponent(here)}`}
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <li
                data-testid="{kind}-project"
                data-project-id={project.id}
                data-machine-id={machine.id}
                data-project-name={projectName(project)}
                data-thread-drop={kind === 'idle' ? '' : undefined}
                class:candidate={kind === 'idle' && takesDrop(threadDrag.current, machine.id, project.id)}
                class:drop={kind === 'idle' && threadDrag.over === here}
                aria-label={kind === 'idle' && threadDrag.over === here ? fill(strings.threadMove.dropHere, { project: projectName(project) }) : undefined}
                oncontextmenu={(event) => projectMenu(event, machine.store, project)}
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
                    {@const total = archiveCount(project, list)}
                    {@const label = fill(historyLabels[list], { count: String(total), project: projectName(project) })}
                    <button type="button" class="ghost counter {list}" class:active={projectThreadView.isOpen(entry, list)} data-testid="project-{list}-toggle" data-count={total}
                      title={label} aria-label={label} aria-expanded={projectThreadView.isOpen(entry, list)} aria-controls="{controls}-{list}"
                      onclick={() => projectThreadView.toggle(entry, list)}>
                      {#if list === 'done'}<CheckCheck size={12} aria-hidden="true" />{:else}<Archive size={12} aria-hidden="true" />{/if}<span class="ui-label">{formatCount(total)}</span>
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
                      <button
                        type="button"
                        class="ghost small icon"
                        data-testid="idle-project-menu"
                        title={strings.sidebar.projectMenu}
                        aria-label={`${strings.sidebar.projectMenu}: ${projectName(project)}`}
                        onclick={(event) => projectMenu(event, machine.store, project)}><Ellipsis size={14} /></button
                      >
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
                      {#if machine.store.owner}
                        <button
                          type="button"
                          class="ghost small icon danger"
                          data-testid="archived-project-remove"
                          title={strings.sidebar.removeProject}
                          aria-label={`${strings.sidebar.removeProject}: ${projectName(project)}`}
                          disabled={busy !== null}
                          onclick={() => void run(machine, project, () => confirmRemoveProject(machine.store, project))}><Trash2 size={13} /></button
                        >
                      {/if}
                    {/if}
                  </span>
                </div>
                {#each kept as list (list)}
                  {#if projectThreadView.isOpen(entry, list)}
                    <div id="{controls}-{list}" class="history" data-testid="project-{list}">
                      <RecentDone kind={list} entries={[entry]} {scrollRoot} {now} open header={false} {onopen} />
                    </div>
                  {/if}
                {/each}
              </li>
            {/each}
          </ul>
        {/each}
      {/if}
    </div></div>
  </section>
{/if}

<style>
  .shelf {
    border-top: 1px solid var(--color-border);
  }
  .hint {
    margin: 0;
    padding: 0 var(--fold-inset) 6px var(--fold-indent);
    color: var(--color-subtle);
    font-size: var(--text-xs);
    line-height: 1.4;
  }
  .machine {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px var(--fold-inset) 2px var(--fold-indent);
    color: var(--color-subtle);
    font-size: var(--text-xs);
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
    opacity: 0.75;
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
  .counter.done {
    color: var(--color-success);
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
