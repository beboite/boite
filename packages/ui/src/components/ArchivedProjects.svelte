<script lang="ts">
  import { ChevronRight, RotateCcw, Trash2 } from '@lucide/svelte';
  import type { Project } from '@boite/contracts';
  import { confirm } from '../lib/confirm.svelte';
  import { projectName } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Machine } from '../lib/workspace.svelte';
  import MachineIcon from './MachineIcon.svelte';
  import ProjectTile from './ProjectTile.svelte';

  /**
   * The projects put out of the list, under it. One click brings one back;
   * starting a thread in it does the same. The owner can also remove one from
   * Boite after a confirm. With several machines the rows group under their
   * machine instead of repeating it on every row. Folded until asked, for this
   * session only.
   */
  let { entries, multi }: { entries: { machine: Machine; project: Project }[]; multi: boolean } = $props();
  let open = $state(false);
  let visited = $state(false);
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

  const key = (machine: Machine, project: Project) => `${machine.id}:${project.id}`;

  async function run(machine: Machine, project: Project, action: () => Promise<unknown>) {
    busy = key(machine, project);
    try {
      await action();
    } finally {
      busy = null;
    }
  }

  function restore(machine: Machine, project: Project) {
    void run(machine, project, () => machine.store.archiveProject(project.id, false));
  }

  function remove(machine: Machine, project: Project) {
    void run(machine, project, async () => {
      const sure = await confirm.ask({
        title: fill(strings.sidebar.removeProjectTitle, { project: projectName(project) }),
        body: strings.sidebar.removeProjectBody,
        confirmLabel: strings.sidebar.remove,
        cancelLabel: strings.common.cancel,
        danger: true
      });
      if (sure) await machine.store.removeProject(project.id);
    });
  }
</script>

{#if entries.length > 0}
  <div class="archived" data-testid="archived-projects">
    <button class="ghost small toggle" aria-expanded={open} data-testid="archived-projects-toggle" onclick={() => { visited = true; open = !open; }}>
      <span class="caret" class:open><ChevronRight size={11} /></span>
      <span class="ui-label">{fill(strings.sidebar.archivedProjects, { count: String(entries.length) })}</span>
    </button>
    <div class="motion-fold" class:expanded={open} inert={!open}><div>
      {#if visited}
        {#each groups as { machine, projects } (machine.id)}
          {#if multi}
            <div class="machine" data-testid="archived-projects-machine" title={machine.label}>
              <MachineIcon icon={machine.icon} os={machine.store.core?.os} size={11} />
              <span class="machine-name ui-label">{machine.label}</span>
            </div>
          {/if}
          <ul>
            {#each projects as project (project.id)}
              <li data-project-id={project.id} data-machine-id={machine.id}>
                <span class="tile" aria-hidden="true"><ProjectTile {project} store={machine.store} size={16} /></span>
                <span class="name ui-label" title={multi ? `${project.path} · ${machine.label}` : project.path}>{projectName(project)}</span>
                <span class="actions">
                  <button
                    class="ghost small icon"
                    data-testid="archived-project-restore"
                    title={strings.sidebar.restoreProject}
                    aria-label={`${strings.sidebar.restoreProject} ${projectName(project)}`}
                    disabled={busy !== null}
                    onclick={() => restore(machine, project)}><RotateCcw size={13} /></button
                  >
                  {#if machine.store.owner}
                    <button
                      class="ghost small icon danger"
                      data-testid="archived-project-remove"
                      title={strings.sidebar.removeProject}
                      aria-label={`${strings.sidebar.removeProject}: ${projectName(project)}`}
                      disabled={busy !== null}
                      onclick={() => remove(machine, project)}><Trash2 size={13} /></button
                    >
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        {/each}
      {/if}
    </div></div>
  </div>
{/if}

<style>
  .archived {
    padding: 0 4px;
  }
  .toggle {
    width: 100%;
    justify-content: flex-start;
    gap: 4px;
    padding: 0 6px;
    color: var(--color-subtle);
  }
  .caret {
    display: flex;
    transition: transform var(--dur-2) var(--ease-out-quint);
  }
  .caret.open {
    transform: rotate(90deg);
  }
  .machine {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 6px 2px 22px;
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
    padding: 0 0 2px;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: var(--row);
    padding: 0 2px 0 22px;
    border-radius: var(--radius-sm);
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }
  li:hover {
    background: var(--color-hover);
    color: var(--color-foreground);
  }
  .tile {
    display: flex;
    flex: none;
    opacity: 0.7;
  }
  li:hover .tile {
    opacity: 1;
  }
  .name {
    flex: 1;
  }
  .actions {
    display: flex;
    flex: none;
    gap: 2px;
  }
  /* A pointer sees the actions on the row it is over; a touch screen always does. */
  @media (hover: hover) {
    .actions {
      opacity: 0;
      transition: opacity var(--dur-1) var(--ease-out-quint);
    }
    li:hover .actions,
    li:focus-within .actions {
      opacity: 1;
    }
  }
  .actions button {
    border-color: transparent;
  }
</style>
