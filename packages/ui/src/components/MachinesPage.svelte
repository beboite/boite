<script lang="ts">
  import { Plus, ArrowUpRight } from '@lucide/svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { store as primary } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import MachineIcon from './MachineIcon.svelte';
  let label = $state(''),
    link = $state(''),
    url = $state(''),
    token = $state('');
  let busy = $state(false);
  let origins = $state('');
  $effect(() => {
    origins = (workspace.active.settings?.browserOrigins ?? []).join('\n');
  });
  async function add(manual = false) {
    if (busy) return;
    busy = true;
    try {
      const ok = manual
        ? await workspace.add({ url: url.trim(), token }, label)
        : await workspace.pair(link.trim(), label);
      if (ok) {
        link = '';
        token = '';
        url = '';
        label = '';
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="machines-page" data-testid="machines-page">
  <h1>{strings.machines.heading}</h1>
  <p class="intro">{strings.machines.intro}</p>
  <div class="machines">
    {#each workspace.machines as machine (machine.id)}
      <section class="card machine-card" data-testid="machine-card" data-machine-id={machine.id}>
        <span class="logo"><MachineIcon os={machine.store.core?.os} size={22} /></span>
        <div class="identity">
          <h2>{machine.label}</h2>
          <span class="address">{machine.store.localCore ? strings.machines.local : machine.id}</span>
          <span class="status" class:ready={machine.store.connection === 'ready'}
            >{strings.connection[machine.store.connection]}</span
          >
          {#if machine.store.error}<p class="error">{machine.store.error}</p>{/if}
        </div>
        <div class="actions">
          <button class="ghost small" data-testid="machine-open" onclick={() => void workspace.select(machine.store)}
            >{strings.machines.open}<ArrowUpRight size={13} /></button
          >
          {#if machine.store.connection === 'closed'}<button
              class="ghost small"
              onclick={() => void machine.store.connect()}>{strings.common.refresh}</button
            >{/if}
          {#if machine.store !== primary}<button
              class="ghost small"
              data-testid="machine-remove"
              onclick={() => void workspace.remove(machine.id)}>{strings.machines.remove}</button
            >{/if}
        </div>
      </section>
    {/each}
  </div>
  <section class="card add">
    <h2>{strings.machines.add}</h2>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <label>{strings.machines.label}<input bind:value={label} data-testid="machine-name" autocomplete="off" /></label>
      <label
        >{strings.machines.link}<input
          bind:value={link}
          data-testid="machine-link"
          type="password"
          autocomplete="off"
          spellcheck="false"
        /></label
      >
      <button type="submit" class="primary" data-testid="machine-add" disabled={busy || !link.trim()}
        ><Plus size={14} />{busy ? strings.machines.adding : strings.machines.add}</button
      >
    </form>
    <details>
      <summary>{strings.machines.manual}</summary>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void add(true);
        }}
      >
        <label
          >{strings.settings.coreUrl}<input
            bind:value={url}
            data-testid="machine-url"
            autocomplete="off"
            spellcheck="false"
          /></label
        >
        <label
          >{strings.settings.token}<input
            bind:value={token}
            data-testid="machine-token"
            type="password"
            autocomplete="off"
          /></label
        >
        <button class="primary" disabled={busy || !url.trim() || !token}
          >{busy ? strings.machines.adding : strings.machines.add}</button
        >
      </form>
    </details>
    {#if workspace.error}<p class="error" role="alert">{workspace.error}</p>{/if}
  </section>
  {#if workspace.active.owner}
    <section class="card add origins">
      <h2>{strings.machines.browserOrigins}</h2>
      <p class="intro">{strings.machines.browserOriginsHint}</p>
      <textarea bind:value={origins} aria-label={strings.machines.browserOrigins} rows="3"></textarea>
      <button
        onclick={() =>
          void workspace.active.saveSettings({
            browserOrigins: origins
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean)
          })}>{strings.settings.save}</button
      >
    </section>
  {/if}
</div>

<style>
  .machines-page {
    max-width: 820px;
    padding: 28px;
    margin: 0 auto;
  }
  h1 {
    font-size: var(--text-lg);
    margin: 0 0 10px;
  }
  h2 {
    font-size: var(--text-base);
    margin: 0 0 6px;
  }
  .intro {
    color: var(--color-muted-foreground);
    line-height: 1.6;
    margin-bottom: 24px;
  }
  .machines {
    display: grid;
    gap: 10px;
    margin-bottom: 24px;
  }
  .machine-card {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 18px;
  }
  .logo {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: var(--radius-md);
    background: var(--color-surface-3);
    color: var(--color-muted-foreground);
    flex: none;
  }
  .identity {
    flex: 1;
    min-width: 0;
  }
  .address {
    display: block;
    color: var(--color-subtle);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
  .status {
    display: block;
    margin-top: 7px;
    font-size: var(--text-xs);
    color: var(--color-live);
  }
  .status.ready {
    color: var(--color-success);
  }
  .actions {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
  }
  .add {
    padding: 20px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
    margin-top: 16px;
  }
  .origins {
    margin-top: 20px;
  }
  textarea {
    display: block;
    width: 100%;
    margin-bottom: 12px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }
  input {
    width: 100%;
  }
  details {
    margin-top: 20px;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }
  summary {
    cursor: pointer;
  }
  .error {
    color: var(--color-danger);
    overflow-wrap: anywhere;
  }
  @media (max-width: 720px) {
    .machines-page {
      padding: 16px;
    }
    .machine-card {
      flex-wrap: wrap;
    }
    .actions {
      flex-direction: row;
      width: 100%;
    }
  }
</style>
