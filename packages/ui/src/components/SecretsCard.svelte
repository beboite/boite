<script lang="ts">
  import { untrack } from 'svelte';
  import type { Project, ProjectId, SecretKeyInfo, SecretStorage } from '@boite/contracts';
  import { confirm } from '../lib/confirm.svelte';
  import { errorText } from '../lib/errors';
  import { projectName, relativeTime } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import InfoTip from './InfoTip.svelte';

  /**
   * The keys agents asked for and the user kept for a project: names and dates,
   * never a value, which no client ever holds. A paired device sees the list;
   * it deletes only over an encrypted link.
   */
  let { store }: { store: Store } = $props();
  const s = strings.secrets;

  /** Per project, its kept keys or why they could not be read; null until read. */
  let lists = $state<Record<ProjectId, SecretKeyInfo[] | string> | null>(null);
  let storage = $state<SecretStorage | null>(null);
  let encrypted = $state(true);
  let busy = $state(false);

  const shown = $derived(
    lists === null ? [] : store.projects.filter((project) => {
      const list = lists?.[project.id];
      return typeof list === 'string' || (list?.length ?? 0) > 0;
    })
  );
  const storageName = $derived(
    storage === 'dpapi' ? s.storageDpapi
      : storage === 'keychain' ? s.storageKeychain
      : storage === 'libsecret' ? s.storageLibsecret
      : storage === 'memory' ? s.storageMemory
      : null
  );

  async function read(project: Project): Promise<SecretKeyInfo[] | string> {
    try {
      const listed = await store.client?.call('secrets.list', { projectId: project.id });
      if (!listed) return [];
      storage = listed.storage;
      encrypted = listed.encrypted;
      return listed.secrets;
    } catch (error) {
      return errorText(error);
    }
  }

  async function load(): Promise<void> {
    const results = await Promise.all(store.projects.map(async (project) => [project.id, await read(project)] as const));
    lists = Object.fromEntries(results);
  }

  async function reload(projectId: ProjectId): Promise<void> {
    const project = store.projects.find((entry) => entry.id === projectId);
    if (!project) return;
    const list = await read(project);
    lists = { ...lists, [projectId]: list };
  }

  $effect(() => {
    const client = store.client;
    if (!client || store.connection !== 'ready') return;
    // Read once per connection, then kept fresh by the event, not by every change to the project list.
    void untrack(load);
    return client.on('secrets.changed', ({ projectId }) => void reload(projectId));
  });

  async function remove(project: Project, key: SecretKeyInfo): Promise<void> {
    const ok = await confirm.ask({
      title: fill(s.deleteTitle, { name: key.name }),
      body: fill(s.deleteBody, { project: projectName(project) }),
      confirmLabel: s.delete,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (!ok) return;
    busy = true;
    try {
      await store.client?.call('secrets.delete', { projectId: project.id, name: key.name });
    } catch (error) {
      store.error = errorText(error);
    }
    await reload(project.id);
    busy = false;
  }

  function dates(key: SecretKeyInfo): string {
    const created = fill(s.created, { time: relativeTime(key.createdAt) });
    const used = key.lastUsedAt === null ? s.neverUsed : fill(s.lastUsed, { time: relativeTime(key.lastUsedAt) });
    return `${created} · ${used}`;
  }
</script>

<section class="card" id="settings-secrets" data-testid="secrets-card">
  <h2 class="ui-label-box"><span class="ui-label">{s.heading}</span><InfoTip topic={s.heading} text={s.info} /></h2>
  {#if storageName}
    <p class="muted storage" class:warn={storage === 'memory'} data-testid="secrets-storage" data-storage={storage}>{fill(s.storage, { storage: storageName })}</p>
  {/if}
  {#if lists !== null && shown.length === 0}
    <p class="muted" data-testid="secrets-empty">{s.empty}</p>
  {/if}
  {#each shown as project (project.id)}
    {@const list = lists?.[project.id]}
    <div class="project" data-testid="secrets-project" data-project-id={project.id}>
      <h3>{projectName(project)}</h3>
      {#if typeof list === 'string'}
        <p class="muted">{list}</p>
      {:else if list}
        <ul>
          {#each list as key (key.name)}
            <li data-testid="secrets-key" data-name={key.name}>
              <span class="what">
                <span class="name" title={key.name}>{key.name}</span>
                <span class="dates">{dates(key)}</span>
              </span>
              <button
                type="button"
                class="small"
                data-testid="secrets-delete"
                aria-label={fill(s.deleteLabel, { name: key.name })}
                title={encrypted ? undefined : s.deletePlain}
                disabled={busy || !encrypted}
                onclick={() => void remove(project, key)}><span class="ui-label">{s.delete}</span></button
              >
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/each}
  {#if !encrypted && shown.length > 0}
    <p class="muted note" data-testid="secrets-plain">{s.deletePlain}</p>
  {/if}
</section>

<style>
  .storage {
    margin: 0 0 8px;
    font-size: var(--text-sm);
  }
  .storage.warn {
    color: var(--color-live);
  }
  .project + .project {
    margin-top: 12px;
  }
  h3 {
    margin-bottom: 6px;
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
    align-items: baseline;
    gap: 2px 10px;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
  .dates {
    font-size: var(--text-xs);
    color: var(--color-subtle);
  }
  li button {
    flex: none;
  }
  .note {
    margin: 8px 0 0;
    font-size: var(--text-sm);
  }
</style>
