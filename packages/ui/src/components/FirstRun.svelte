<script lang="ts">
  import { FolderOpen } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import BoiteMark from './BoiteMark.svelte';

  let { store }: { store: Store } = $props();

  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  let path = $state('');
  let typing = $state(!inShell);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const clean = path.trim();
    if (clean.length === 0) return;
    const project = await store.addProject(clean);
    if (project) path = '';
  }
</script>

<div class="first-run" data-testid="first-run">
  <div class="card">
    <div class="mark"><BoiteMark size={28} /></div>
    <h1>{strings.firstRun.heading}</h1>
    <p class="muted">{strings.firstRun.body}</p>

    {#if inShell}
      <button type="button" class="primary big" data-testid="pick-project" onclick={() => void store.pickProject()}>
        <FolderOpen size={16} strokeWidth={1.75} />
        {strings.firstRun.pick}
      </button>
    {/if}

    {#if typing}
      <form onsubmit={submit} data-testid="add-project-form">
        <input
          data-testid="project-path"
          bind:value={path}
          placeholder={strings.firstRun.pathPlaceholder}
          spellcheck="false"
          autocomplete="off"
        />
        <button type="submit" class:primary={!inShell} data-testid="project-add" disabled={path.trim().length === 0}>
          {strings.firstRun.add}
        </button>
      </form>
    {:else}
      <button type="button" class="ghost small" data-testid="add-project" onclick={() => (typing = true)}>
        {strings.firstRun.pathPlaceholder}
      </button>
    {/if}
  </div>
</div>

<style>
  .first-run {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    width: min(420px, 100%);
    padding: 36px 32px 28px;
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-e2);
    text-align: center;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .mark {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: var(--radius-lg);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    margin-bottom: 6px;
  }

  h1 {
    font-size: var(--text-lg);
  }

  p {
    max-width: 30ch;
  }

  .big {
    height: 36px;
    padding: 0 16px;
    margin-top: 10px;
  }

  form {
    display: flex;
    gap: 6px;
    width: 100%;
    margin-top: 8px;
  }

  form input {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  form button {
    height: 32px;
  }
</style>
