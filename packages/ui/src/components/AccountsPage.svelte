<script lang="ts">
  import { untrack } from 'svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  let adding = $state(false);
  let providerId = $state(untrack(() => store.providers[0]?.id ?? ''));
  let label = $state('');
  let useDefaultLocation = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!providerId || label.trim().length === 0) return;
    await store.addAccount({ providerId, label: label.trim(), useDefaultLocation });
    label = '';
    adding = false;
  }
</script>

<div class="page">
  <header>
    <h1>{strings.accounts.heading}</h1>
    <button class="quiet" onclick={() => (adding = !adding)}>{strings.accounts.add}</button>
  </header>

  {#if adding}
    <form class="card" onsubmit={submit}>
      <label>
        <span>{strings.accounts.provider}</span>
        <select bind:value={providerId}>
          {#each store.providers as provider (provider.id)}
            <option value={provider.id}>{provider.name}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>{strings.accounts.label}</span>
        <input bind:value={label} placeholder={strings.accounts.labelPlaceholder} />
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={useDefaultLocation} />
        {strings.accounts.useDefaultLocation}
      </label>
      <div class="actions">
        <button type="submit" class="primary" disabled={label.trim().length === 0}>
          {strings.accounts.create}
        </button>
        <button type="button" class="quiet" onclick={() => (adding = false)}>
          {strings.accounts.cancel}
        </button>
      </div>
    </form>
  {/if}

  {#if store.accounts.length === 0}
    <p class="empty">{strings.accounts.empty}</p>
  {:else}
    <table class="card">
      <thead>
        <tr>
          <th>{strings.accounts.label}</th>
          <th>{strings.accounts.provider}</th>
          <th>{strings.accounts.identity}</th>
          <th>{strings.accounts.isolation}</th>
          <th></th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each store.accounts as account (account.id)}
          <tr>
            <td>{account.label}</td>
            <td class="mono">{store.providerOf(account.providerId)?.shortName ?? account.providerId}</td>
            <td class="mono">{account.identity ?? strings.common.none}</td>
            <td class="mono path" title={account.isolationDir ?? strings.accounts.defaultLocation}>
              {account.isolationDir ?? strings.accounts.defaultLocation}
            </td>
            <td>
              <span
                class="status"
                class:ok={account.status === 'ok'}
                class:bad={account.status === 'unauthenticated' || account.status === 'error'}
              >
                {strings.accounts.status[account.status]}
              </span>
            </td>
            <td>
              <button class="quiet" onclick={() => void store.checkAccount(account.id)}>
                {strings.accounts.check}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  form {
    display: grid;
    gap: 6px;
    padding: 8px;
    margin-bottom: 10px;
    max-width: 420px;
  }

  form select,
  form input:not([type]) {
    width: 100%;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }

  .actions {
    display: flex;
    gap: 6px;
  }

  table {
    background: var(--panel);
  }

  .path {
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--muted);
  }

  .status.ok {
    color: var(--ok);
  }

  .status.bad {
    color: var(--danger);
  }
</style>
