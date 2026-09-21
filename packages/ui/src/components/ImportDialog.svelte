<script lang="ts">
  import { tick } from 'svelte';
  import type { ImportableSession } from '@boite/contracts';
  import { Closing } from '../lib/closing.svelte';
  import { ago } from '../lib/format';
  import { fill, strings } from '../lib/i18n.svelte';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  const overlay = new Closing();
  /** The dialog state is nulled the moment it closes, so the exit plays on a copy. */
  let held = $state<NonNullable<Store['imports']> | null>(null);
  let list = $state<HTMLDivElement | undefined>(undefined);
  let now = $state(Date.now());

  $effect(() => {
    const current = store.imports;
    if (!current) {
      overlay.hide();
      return;
    }
    held = current;
    now = Date.now();
    overlay.show();
    void tick().then(() => list?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true }));
  });

  let projectName = $derived(store.projects.find((p) => p.id === held?.projectId)?.name ?? '');

  function accountLabel(session: ImportableSession): string {
    return store.accounts.find((account) => account.id === session.accountId)?.label ?? session.accountId;
  }

  function hintOf(session: ImportableSession): string {
    if (held?.running === session.sessionId) return strings.imports.importing;
    if (session.threadId !== null) return strings.imports.imported;
    return ago(session.updatedAt, now);
  }

  function onkeydown(event: KeyboardEvent) {
    if (!store.imports) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      store.closeImports();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = Array.from(list?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (rows.length === 0) return;
    event.preventDefault();
    const at = rows.findIndex((row) => row === document.activeElement);
    const next = event.key === 'ArrowDown' ? (at + 1) % rows.length : (at - 1 + rows.length) % rows.length;
    rows[next]?.focus({ preventScroll: true });
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />

{#if overlay.shown && held}
  {@const dialog = held}
  <div
    class="scrim"
    class:closing={overlay.closing}
    role="presentation"
    use:overlay.attach
    onanimationend={overlay.end}
    onclick={(event) => {
      if (event.target === event.currentTarget) store.closeImports();
    }}
  >
    <div
      class="dialog"
      class:closing={overlay.closing}
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-title"
      tabindex="-1"
      data-testid="import-dialog"
    >
      <div class="head">
        <h2 id="import-title">{fill(strings.imports.title, { project: projectName })}</h2>
        <p class="muted">{strings.imports.intro}</p>
      </div>
      <div class="list" bind:this={list}>
        {#if dialog.loading}
          <p class="muted empty" data-testid="import-loading">{strings.imports.loading}</p>
        {:else if dialog.sessions.length === 0}
          <p class="muted empty" data-testid="import-empty">{strings.imports.empty}</p>
        {:else}
          {#each dialog.sessions as session (session.accountId + session.sessionId)}
            <button
              type="button"
              class="row"
              class:done={session.threadId !== null}
              disabled={session.threadId !== null || dialog.running !== null}
              title={session.file}
              data-testid="import-row"
              data-session={session.sessionId}
              onclick={() => void store.importSession(session.accountId, session.sessionId)}
            >
              <span class="title">{session.title}</span>
              <span class="account">{accountLabel(session)}</span>
              <span class="hint">{hintOf(session)}</span>
            </button>
          {/each}
        {/if}
      </div>
      <div class="actions">
        <button type="button" class="ghost" data-testid="import-close" disabled={dialog.running !== null} onclick={() => store.closeImports()}>
          {strings.imports.close}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: min(14vh, 120px);
    background: var(--color-scrim);
    backdrop-filter: blur(4px);
    animation: fade var(--dur-2) var(--ease-out-quint);
  }

  .scrim.closing {
    animation-name: fade-out;
    pointer-events: none;
  }

  .dialog {
    width: min(560px, calc(100vw - 32px));
    max-height: min(70vh, 520px);
    display: flex;
    flex-direction: column;
    background: var(--color-surface);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-e3);
    overflow: hidden;
    animation: pop var(--dur-2) var(--ease-out-quint);
  }

  .dialog.closing {
    animation-name: pop-out;
  }

  .head {
    padding: 16px 18px 12px;
    border-bottom: 1px solid var(--color-border);
  }

  h2 {
    font-size: var(--text-md);
    margin-bottom: 4px;
  }

  .list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 6px;
  }

  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    height: var(--row);
    padding: 0 10px;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-foreground);
    text-align: left;
    justify-content: flex-start;
  }

  .row:hover:not(:disabled),
  .row:focus-visible {
    background: var(--color-active);
    outline: none;
  }

  .row:active:not(:disabled) {
    transform: none;
  }

  .row.done {
    color: var(--color-muted-foreground);
  }

  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 400;
  }

  .account,
  .hint {
    flex: none;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }

  .empty {
    padding: 14px 10px;
    text-align: center;
    font-size: var(--text-sm);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    padding: 8px 12px 10px;
    border-top: 1px solid var(--color-border);
  }
</style>
