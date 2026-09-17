<script lang="ts">
  import type { Project } from '@boite/contracts';
  import { focusOnMount } from '../lib/actions';
  import { strings } from '../lib/i18n.svelte';
  import type { Store } from '../lib/store.svelte';

  let {
    store,
    primary = true,
    focus = false,
    onadded,
    oncancel
  }: {
    store: Store;
    primary?: boolean;
    focus?: boolean;
    onadded?: (project: Project) => void;
    oncancel?: () => void;
  } = $props();

  let path = $state('');
  let submitting = $state(false);

  function focusInput(node: HTMLInputElement) {
    if (focus) focusOnMount(node);
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const clean = path.trim();
    if (!clean || submitting) return;
    submitting = true;
    const project = await store.addProject(clean);
    submitting = false;
    if (!project) return;
    path = '';
    onadded?.(project);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !oncancel || submitting) return;
    event.preventDefault();
    event.stopPropagation();
    oncancel();
  }
</script>

<form onsubmit={submit} data-testid="add-project-form">
  <input
    data-testid="project-path"
    bind:value={path}
    {onkeydown}
    use:focusInput
    placeholder={strings.firstRun.pathPlaceholder}
    aria-label={strings.firstRun.pathPlaceholder}
    spellcheck="false"
    autocomplete="off"
  />
  <button type="submit" class:primary {onkeydown} data-testid="project-add" disabled={path.trim().length === 0 || submitting}>
    {strings.firstRun.add}
  </button>
  {#if oncancel}
    <button type="button" class="quiet" {onkeydown} data-testid="project-cancel" disabled={submitting} onclick={oncancel}>
      {strings.common.cancel}
    </button>
  {/if}
</form>

<style>
  form {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    width: 100%;
    margin-top: 8px;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  input {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  button {
    height: var(--input);
  }
</style>
