<script lang="ts">
  import type { PermissionMode, Thread } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store, thread }: { store: Store; thread: Thread } = $props();

  const modes: PermissionMode[] = [
    'default',
    'acceptEdits',
    'plan',
    'bypassPermissions',
    'dontAsk'
  ];

  let draft = $state('');
  let busy = $derived(
    thread.status === 'running' || thread.status === 'queued' || thread.status === 'waiting'
  );
  let provider = $derived(store.providerOf(thread.providerId));
  let account = $derived(store.accountOf(thread.accountId));

  function submit() {
    const prompt = draft;
    if (prompt.trim().length === 0) return;
    draft = '';
    void store.send(prompt);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submit();
  }
</script>

<div class="composer">
  <div class="chips">
    <span class="chip">{provider?.shortName ?? thread.providerId}</span>
    <span class="chip">{account?.label ?? thread.accountId}</span>
    <label class="chip mode">
      <span class="sr">{strings.composer.permissionMode}</span>
      <select
        value={thread.permissionMode}
        onchange={(event) =>
          void store.setPermissionMode(event.currentTarget.value as PermissionMode)}
      >
        {#each modes as mode (mode)}
          <option value={mode}>{strings.permissionMode[mode]}</option>
        {/each}
      </select>
    </label>
  </div>

  <div class="input">
    <textarea
      data-testid="composer-input"
      bind:value={draft}
      {onkeydown}
      rows="3"
      placeholder={strings.composer.placeholder}
      aria-label={strings.composer.placeholder}
    ></textarea>
    <div class="buttons">
      {#if busy}
        <button class="danger" data-testid="composer-stop" onclick={() => void store.stop()}>
          {strings.composer.stop}
        </button>
      {/if}
      <button
        class="primary"
        data-testid="composer-send"
        disabled={draft.trim().length === 0}
        onclick={submit}
      >
        {strings.composer.send}
      </button>
    </div>
  </div>
</div>

<style>
  .composer {
    border-top: 1px solid var(--border);
    background: var(--panel);
    padding: 6px 12px 8px;
  }

  .chips {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 5px;
  }

  .chip {
    font-size: 11px;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0 7px;
    background: var(--panel-alt);
  }

  .chip.mode {
    padding: 0;
    border: none;
    background: none;
  }

  .chip.mode select {
    font-size: 11px;
    padding: 0 4px;
    border-radius: 10px;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .input {
    display: flex;
    gap: 6px;
    align-items: flex-end;
  }

  textarea {
    flex: 1;
    resize: vertical;
    min-height: 52px;
    font-family: inherit;
  }

  .buttons {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
</style>
