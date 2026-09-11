<script lang="ts">
  import { KEYBINDING_COMMANDS } from '@boite/contracts';
  import { commandLabel } from '../lib/commands.svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  /** One row per command the table knows, in the table's order. */
  let rows = $derived(
    KEYBINDING_COMMANDS.map((id) => ({
      id,
      label: commandLabel(id),
      key: store.keyLabel(id),
      custom: store.bindings[id].custom
    }))
  );

  const example = '{\n  "new-thread": "mod+shift+n",\n  "palette": "mod+p",\n  "sidebar": null\n}';
</script>

<div class="page" data-testid="keyboard-page">
  <header>
    <h1>{strings.settings.tabs.keyboard}</h1>
  </header>

  <section class="card">
    <h2>{strings.keyboard.heading}</h2>
    <p class="intro">{strings.keyboard.intro}</p>
    <table>
      <thead>
        <tr>
          <th>{strings.keyboard.command}</th>
          <th>{strings.keyboard.id}</th>
          <th>{strings.keyboard.chord}</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr data-testid="keybinding-row" data-command={row.id} class:custom={row.custom}>
            <td>{row.label}</td>
            <td class="mono subtle">{row.id}</td>
            <td>
              {#if row.key === null}
                <span class="subtle" data-testid="keybinding-key">{strings.keyboard.none}</span>
              {:else}
                <kbd data-testid="keybinding-key">{row.key}</kbd>
              {/if}
              {#if row.custom}
                <span class="tag">{strings.keyboard.custom}</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>

  {#if store.keybindings && store.keybindings.errors.length > 0}
    <section class="card problems" data-testid="keybinding-problems">
      <h2>{strings.keyboard.problems}</h2>
      <p class="intro">{strings.keyboard.problemsHint}</p>
      <ul>
        {#each store.keybindings.errors as error (error)}
          <li class="mono" data-testid="keybinding-error">{error}</li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="card">
    <h2>{strings.keyboard.file}</h2>
    <p class="mono path" data-testid="keybindings-path">{store.keybindings?.path ?? ''}</p>
    <p class="intro">{strings.keyboard.fileHint}</p>
    <p class="subtle example-label">{strings.keyboard.example}</p>
    <pre class="mono">{example}</pre>
  </section>
</div>

<style>
  .intro {
    color: var(--color-muted-foreground);
    margin: 0 0 12px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  th {
    text-align: left;
    font-weight: 500;
    color: var(--color-muted-foreground);
    padding: 4px 8px 8px 0;
    border-bottom: 1px solid var(--color-border);
  }

  td {
    padding: 6px 8px 6px 0;
    border-bottom: 1px solid var(--color-border);
    vertical-align: middle;
  }

  tr:last-child td {
    border-bottom: none;
  }

  .subtle {
    color: var(--color-muted-foreground);
  }

  kbd {
    display: inline-block;
    padding: 1px 6px;
    border: 1px solid var(--color-edge);
    border-bottom-width: 2px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-foreground);
  }

  .tag {
    margin-left: 8px;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .problems {
    border-color: var(--color-danger);
  }

  .problems ul {
    margin: 0;
    padding-left: 18px;
  }

  .problems li {
    font-size: var(--text-sm);
    margin-bottom: 4px;
  }

  .path {
    margin: 0 0 8px;
    word-break: break-all;
    color: var(--color-foreground);
  }

  .example-label {
    margin: 0 0 4px;
    font-size: var(--text-xs);
  }

  pre {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
    white-space: pre;
  }
</style>
