<script lang="ts">
  // The files one finished answer made or changed, at its end. A row opens the
  // file in the side panel, which already reads text, shows pictures and offers
  // a download for the rest. "Show in folder" hands the path to the system file
  // manager, only in the shell on its own core, and never opens the file itself.
  import { FileText, FolderOpen } from '@lucide/svelte';
  import { revealFile } from '../lib/links';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import type { TurnFile } from '../lib/turn-files';

  let { store, files }: { store: Store; files: TurnFile[] } = $props();

  const CHANGE_LABEL = {
    created: () => strings.chat.fileCreated,
    changed: () => strings.chat.fileChanged,
    deleted: () => strings.chat.fileDeleted
  } satisfies Record<TurnFile['change'], () => string>;

  function openable(file: TurnFile): boolean {
    return file.relative !== null && file.change !== 'deleted';
  }

  async function reveal(file: TurnFile): Promise<void> {
    if (file.absolute === null) return;
    try {
      await revealFile(file.absolute);
    } catch (error) {
      store.error = fill(strings.chat.revealFailed, { reason: error instanceof Error ? error.message : String(error) });
    }
  }
</script>

<section class="turn-files" data-testid="turn-files" aria-label={strings.chat.turnFiles}>
  <span class="section-label">{strings.chat.turnFiles}</span>
  <ul>
    {#each files as file (file.path)}
      <li class="row" data-change={file.change}>
        {#if openable(file)}
          <button
            type="button"
            class="open"
            data-testid="turn-file"
            aria-label={fill(strings.chat.openFile, { name: file.name })}
            onclick={() => store.panel.openFile(file.relative!)}
          >
            <FileText size={14} strokeWidth={1.75} />
            <span class="name">{file.name}</span>
            {#if file.folder}<span class="folder">{file.folder}</span>{/if}
          </button>
        {:else}
          <span class="open" data-testid="turn-file">
            <FileText size={14} strokeWidth={1.75} />
            <span class="name">{file.name}</span>
            {#if file.folder}<span class="folder">{file.folder}</span>{/if}
          </span>
        {/if}
        <span class="change" data-testid="turn-file-change">{CHANGE_LABEL[file.change]()}</span>
        {#if store.pickerAvailable && file.absolute !== null && file.change !== 'deleted'}
          <button
            type="button"
            class="ghost small icon reveal"
            data-testid="turn-file-reveal"
            title={strings.chat.revealFile}
            aria-label={strings.chat.revealFile}
            onclick={() => void reveal(file)}
          >
            <FolderOpen size={14} strokeWidth={1.75} />
          </button>
        {/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  .turn-files {
    display: flex;
    flex-direction: column;
    gap: 4px;
    /* The answer's parts sit 4px in; the card lines up with them. */
    margin: 12px 0 0 4px;
    padding: 8px 6px 6px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .section-label { padding: 0 6px; }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: var(--control-sm);
    border-radius: var(--radius-sm);
  }

  .row:hover { background: var(--color-hover); }

  .open {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 8px;
    min-width: 0;
    height: auto;
    min-height: var(--control-sm);
    padding: 0 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    justify-content: flex-start;
    text-align: left;
  }

  /* The row carries the hover, so the button inside it stays flat. */
  button.open:hover:not(:disabled) { background: none; }
  button.open:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
  .open :global(svg) { flex: none; color: var(--color-muted-foreground); }

  .name {
    font-size: var(--text-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .folder {
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  [data-change='deleted'] .name { text-decoration: line-through; color: var(--color-muted-foreground); }

  .change {
    flex: none;
    padding-right: 6px;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  [data-change='created'] .change { color: var(--color-success); }

  .reveal { flex: none; }
</style>
