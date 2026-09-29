<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import type { Project } from '@boite/contracts';
  import { projectName } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Machine } from '../lib/workspace.svelte';
  import MachineIcon from './MachineIcon.svelte';

  /**
   * The projects put out of the list, under it. One click brings one back;
   * starting a thread in it does the same. Folded until asked, for this
   * session only.
   */
  let { entries, multi }: { entries: { machine: Machine; project: Project }[]; multi: boolean } = $props();
  let open = $state(false);
  let visited = $state(false);
</script>

{#if entries.length > 0}
  <div class="archived" data-testid="archived-projects">
    <button class="ghost small toggle" aria-expanded={open} data-testid="archived-projects-toggle" onclick={() => { visited = true; open = !open; }}>
      <span class="caret" class:open><ChevronRight size={11} /></span>
      {fill(strings.sidebar.archivedProjects, { count: String(entries.length) })}
    </button>
    <div class="motion-fold" class:expanded={open} inert={!open}><div>
      {#if visited}
      <ul>
        {#each entries as { machine, project } (`${machine.id}:${project.id}`)}
          <li data-project-id={project.id}>
            <div class="project">
              <span class="name" title={multi ? `${project.path} · ${machine.label}` : project.path}>{projectName(project)}</span>
              <span class="machine" title={machine.label}>
                <MachineIcon icon={machine.icon} os={machine.store.core?.os} size={11} />
                <span class="machine-name">{machine.label}</span>
              </span>
            </div>
            <button
              class="ghost small"
              data-testid="archived-project-restore"
              onclick={() => void machine.store.archiveProject(project.id, false)}>{strings.sidebar.restoreProject}</button
            >
          </li>
        {/each}
      </ul>
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
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: var(--row);
    padding: 4px 2px 4px 22px;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }
  .project {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name, .machine-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .machine {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--color-subtle);
    font-size: var(--text-xs);
  }
  .machine :global(svg) {
    flex: none;
  }
  .machine-name {
    min-width: 0;
  }
  li button {
    flex: none;
  }
</style>
