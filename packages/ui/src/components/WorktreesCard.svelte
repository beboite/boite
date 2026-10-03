<script lang="ts">
  import type { Project, ProjectId, WorktreeEntry } from '@boite/contracts';
  import InfoTip from './InfoTip.svelte';
  import WorktreeStorageSetting from './WorktreeStorageSetting.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { projectName } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { folderName, heldByLive, sweepable } from '../lib/worktrees';

  /**
   * The worktrees the git projects of this machine still carry. Nothing goes on
   * its own: a thread's worktree stays after the thread is archived, and this
   * card is where a person clears them. The sweep takes only the ones with
   * nothing to lose; one holding changes or lone commits asks first.
   */
  let { store }: { store: Store } = $props();
  const s = strings.settings.worktrees;

  let projects = $derived(store.projects.filter((p) => p.kind !== 'drafts' && p.repository !== false));
  /** Null until asked for; per project, its list or why it could not be read. */
  let lists = $state<Record<ProjectId, WorktreeEntry[] | string> | null>(null);
  let busy = $state(false);
  let asked = false;

  $effect(() => {
    if (asked || store.settingsSection?.id !== 'worktrees' || store.connection !== 'ready') return;
    asked = true;
    void load();
  });

  async function read(project: Project): Promise<WorktreeEntry[] | string> {
    try {
      return (await store.client?.call('worktrees.list', { projectId: project.id })) ?? [];
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function load() {
    busy = true;
    const results = await Promise.all(projects.map(async (p) => [p.id, await read(p)] as const));
    lists = Object.fromEntries(results);
    busy = false;
  }

  async function reload(project: Project) {
    const list = await read(project);
    lists = { ...lists, [project.id]: list };
  }

  async function removeOne(project: Project, entry: WorktreeEntry, force: boolean): Promise<boolean> {
    try {
      await store.client?.call('worktrees.remove', { projectId: project.id, path: entry.path, ...(force ? { force: true } : {}) });
      return true;
    } catch (error) {
      store.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async function remove(project: Project, entry: WorktreeEntry) {
    const force = entry.dirty || entry.unmerged;
    if (force) {
      const reasons = [entry.dirty ? s.dirty : null, entry.unmerged ? s.unmerged : null].filter(Boolean).join(', ');
      const ok = await confirm.ask({
        title: fill(s.forceTitle, { name: folderName(entry.path) }),
        body: fill(s.forceBody, { reasons }),
        confirmLabel: s.remove,
        cancelLabel: strings.common.cancel,
        danger: true
      });
      if (!ok) return;
    }
    busy = true;
    await removeOne(project, entry, force);
    await reload(project);
    busy = false;
  }

  async function sweep(project: Project, entries: WorktreeEntry[]) {
    busy = true;
    for (const entry of entries.filter(sweepable)) await removeOne(project, entry, false);
    await reload(project);
    busy = false;
  }

  function flags(entry: WorktreeEntry): { text: string; tone: 'warn' | 'muted' }[] {
    return [
      ...(entry.missing ? [{ text: s.missing, tone: 'muted' as const }] : []),
      ...(entry.dirty ? [{ text: s.dirty, tone: 'warn' as const }] : []),
      ...(entry.unmerged ? [{ text: s.unmerged, tone: 'warn' as const }] : []),
      ...(entry.threadTitle !== null
        ? [{ text: fill(entry.threadArchived ? s.archivedThread : s.heldBy, { title: entry.threadTitle }), tone: 'muted' as const }]
        : [])
    ];
  }
</script>

{#if store.owner}
  <section class="card" id="settings-worktrees" data-testid="worktrees-card">
    <h2>{s.heading}<InfoTip topic={s.heading} text={s.intro} /></h2>
    <WorktreeStorageSetting {store} />
    {#if lists === null}
      <button type="button" data-testid="worktrees-show" disabled={busy || store.connection !== 'ready'} onclick={() => void load()}><span class="ui-label">{s.show}</span></button>
    {:else if projects.length === 0}
      <p class="muted">{s.noProject}</p>
    {:else}
      {#each projects as project (project.id)}
        {@const list = lists[project.id]}
        <div class="project" data-testid="worktrees-project" data-project-id={project.id}>
          <div class="head">
            <h3>{projectName(project)}</h3>
            {#if Array.isArray(list) && list.some(sweepable)}
              <button type="button" class="small" data-testid="worktrees-sweep" disabled={busy} onclick={() => void sweep(project, list)}
                ><span class="ui-label">{fill(s.sweep, { count: String(list.filter(sweepable).length) })}</span></button
              >
            {/if}
          </div>
          {#if typeof list === 'string'}
            <p class="muted">{list}</p>
          {:else if !list || list.length === 0}
            <p class="muted">{s.empty}</p>
          {:else}
            <ul>
              {#each list as entry (entry.path)}
                <li data-path={entry.path}>
                  <span class="what">
                    <span class="name ui-label" title={entry.path}>{entry.branch ?? folderName(entry.path)}</span>
                    <span class="flags">
                      {#each flags(entry) as flag (flag.text)}<span class="flag {flag.tone}">{flag.text}</span>{/each}
                    </span>
                  </span>
                  <button
                    type="button"
                    class="small"
                    data-testid="worktrees-remove"
                    disabled={busy || heldByLive(entry)}
                    title={heldByLive(entry) ? s.heldHint : entry.path}
                    onclick={() => void remove(project, entry)}><span class="ui-label">{s.remove}</span></button
                  >
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    {/if}
  </section>
{/if}

<style>
  .project + .project {
    margin-top: 12px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  h3 {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--row);
    padding: 4px 4px 4px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .what {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
  .flags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .flag {
    font-size: var(--text-xs);
    color: var(--color-subtle);
  }
  .flag.warn {
    color: var(--color-live);
  }
  li button {
    flex: none;
  }
</style>
