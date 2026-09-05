<script lang="ts">
  import { untrack } from 'svelte';
  import type { PermissionMode } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store, done }: { store: Store; done: () => void } = $props();

  const modes: PermissionMode[] = [
    'default',
    'acceptEdits',
    'plan',
    'bypassPermissions',
    'dontAsk'
  ];

  let projectId = $state(untrack(() => store.projects[0]?.id ?? ''));
  let providerId = $state(
    untrack(() => store.providers.find((p) => p.available)?.id ?? store.providers[0]?.id ?? '')
  );
  let chosenAccountId = $state('');
  let permissionMode = $state<PermissionMode>('default');
  let title = $state('');

  let candidates = $derived(store.accountsOf(providerId));
  let accountId = $derived(
    candidates.some((a) => a.id === chosenAccountId) ? chosenAccountId : (candidates[0]?.id ?? '')
  );

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!projectId || !providerId || !accountId) return;
    await store.createThread({
      projectId,
      providerId,
      accountId,
      permissionMode,
      ...(title.trim() ? { title: title.trim() } : {})
    });
    done();
  }
</script>

<form onsubmit={submit}>
  <h2>{strings.newThread.heading}</h2>

  <label>
    <span>{strings.newThread.project}</span>
    <select bind:value={projectId}>
      {#each store.projects as project (project.id)}
        <option value={project.id}>{project.name}</option>
      {/each}
    </select>
  </label>

  <label>
    <span>{strings.newThread.provider}</span>
    <select bind:value={providerId}>
      {#each store.providers as provider (provider.id)}
        <option value={provider.id}>
          {provider.name}{provider.available ? '' : ` (${strings.newThread.unavailable})`}
        </option>
      {/each}
    </select>
  </label>

  <label>
    <span>{strings.newThread.account}</span>
    <select
      value={accountId}
      onchange={(event) => (chosenAccountId = event.currentTarget.value)}
      disabled={candidates.length === 0}
    >
      {#each candidates as account (account.id)}
        <option value={account.id}>{account.label}</option>
      {/each}
    </select>
  </label>

  <label>
    <span>{strings.newThread.permissionMode}</span>
    <select bind:value={permissionMode}>
      {#each modes as mode (mode)}
        <option value={mode}>{strings.permissionMode[mode]}</option>
      {/each}
    </select>
  </label>

  <label>
    <span>{strings.newThread.title}</span>
    <input bind:value={title} placeholder={strings.newThread.titlePlaceholder} />
  </label>

  {#if candidates.length === 0}
    <p class="muted">{strings.newThread.noAccounts}</p>
  {/if}

  <div class="actions">
    <button type="submit" class="primary" disabled={!projectId || !accountId}>
      {strings.newThread.create}
    </button>
    <button type="button" class="quiet" onclick={done}>{strings.newThread.cancel}</button>
  </div>
</form>

<style>
  form {
    display: grid;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel);
    margin-bottom: 8px;
  }

  select,
  input {
    width: 100%;
  }

  p {
    margin: 0;
    font-size: 11px;
  }

  .actions {
    display: flex;
    gap: 6px;
    margin-top: 2px;
  }
</style>
