<script lang="ts">
  import { RefreshCw } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import { errorText } from '../lib/errors';
  import type { AllowedWindowApp, Project, ProjectId } from '@boite/contracts';
  import InfoTip from './InfoTip.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { projectName } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * The apps whose windows each project's agents capture without asking
   * (docs/windows.md). An app joins a project's list when the owner answers
   * Always for this project on a capture card; this is where it leaves it.
   */
  let { store }: { store: Store } = $props();
  const s = strings.windows.settings;

  const projects = $derived(store.projects.filter((p) => p.kind !== 'drafts'));
  /** Null until read; per project, its apps or why they could not be read. */
  let lists = $state<Record<ProjectId, AllowedWindowApp[] | string> | null>(null);
  let busy = $state(false);
  let loads = 0;
  /** A project added or removed reads the lists again; an Always answered elsewhere waits for Refresh. */
  const projectIds = $derived(projects.map((p) => p.id).join('\n'));
  const shown = $derived(lists === null ? [] : projects.filter((p) => { const list = lists?.[p.id]; return typeof list === 'string' || (list?.length ?? 0) > 0; }));

  $effect(() => {
    void projectIds;
    if (!store.owner || store.connection !== 'ready') return;
    untrack(() => void load());
  });

  async function read(project: Project): Promise<AllowedWindowApp[] | string> {
    try {
      return (await store.client?.call('windows.allowlist', { projectId: project.id }))?.apps ?? [];
    } catch (error) {
      return errorText(error);
    }
  }

  async function load() {
    const at = ++loads;
    const results = await Promise.all(projects.map(async (p) => [p.id, await read(p)] as const));
    // Only the latest reading lands: an earlier one may answer last.
    if (at === loads) lists = Object.fromEntries(results);
  }

  async function remove(project: Project, app: AllowedWindowApp) {
    const ok = await confirm.ask({
      title: fill(s.removeTitle, { process: app.process }),
      body: fill(s.removeBody, { process: app.process, project: projectName(project) }),
      confirmLabel: s.remove,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (!ok) return;
    busy = true;
    try {
      const result = await store.client?.call('windows.revoke', { projectId: project.id, path: app.path });
      if (result) {
        lists = { ...lists, [project.id]: result.apps };
        // A reading that started before the revoke answered would bring the app back: read again after it.
        void load();
      }
    } catch (error) {
      store.error = errorText(error);
    } finally {
      busy = false;
    }
  }
</script>

{#if store.owner}
  <section class="card" id="settings-windows" data-testid="window-allowlist">
    <h2 class="ui-label-box"><span class="ui-label">{s.allowedHeading}</span><InfoTip topic={s.allowedHeading} text={s.allowedIntro} /><button type="button" class="ghost icon" disabled={busy} onclick={() => void load()} aria-label={strings.common.refresh} title={strings.common.refresh} data-testid="window-allowlist-refresh"><RefreshCw size={15} /></button></h2>
    {#if lists !== null && shown.length === 0}
      <p class="muted" data-testid="window-allowlist-empty">{s.allowedEmpty}</p>
    {/if}
    {#each shown as project (project.id)}
      {@const list = lists?.[project.id]}
      <div class="project" data-testid="window-allowlist-project" data-project-id={project.id}>
        <h3>{projectName(project)}</h3>
        {#if typeof list === 'string'}
          <p class="muted">{list}</p>
        {:else if list}
          <ul>
            {#each list as app (app.path)}
              <li data-path={app.path}>
                <span class="what">
                  <span class="name ui-label">{app.process}</span>
                  <span class="path" title={app.path}>{app.path}</span>
                </span>
                <button type="button" class="small" data-testid="window-allowlist-remove" disabled={busy} onclick={() => void remove(project, app)}><span class="ui-label">{s.remove}</span></button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
  </section>
{/if}

<style>
  .project + .project { margin-top: 12px; }
  h3 { margin-bottom: 6px; font-size: var(--text-sm); font-weight: 600; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--row);
    padding: 4px 4px 4px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .what { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .name { font-family: var(--font-mono); font-size: var(--text-sm); }
  .path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); color: var(--color-subtle); }
  li button { flex: none; }
</style>
