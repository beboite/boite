<script lang="ts">
  import { parseChord, type KeybindingCommand } from '@boite/contracts';
  import { RotateCcw, Search, X } from '@lucide/svelte';
  import { commandLabel } from '../lib/commands.svelte';
  import { COMMAND_GROUPS, chordFromEvent, chordParts, isMac } from '../lib/keybindings';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  const mac = isMac();
  let filter = $state('');
  /** The row listening for keys, and what is held so far. */
  let recording = $state<KeybindingCommand | null>(null);
  let held = $state<string[]>([]);
  /** A chord another command already answers to, waiting for the user's word. */
  let conflict = $state<{ id: KeybindingCommand; chord: string; other: KeybindingCommand } | null>(null);
  let problem = $state<{ id: KeybindingCommand; message: string } | null>(null);
  let busy = $state(false);

  function partsOf(id: KeybindingCommand): string[] | null {
    const chord = store.bindings[id].chord;
    return chord === null ? null : chordParts(chord, mac);
  }

  let groups = $derived.by(() => {
    const needle = filter.trim().toLowerCase();
    return COMMAND_GROUPS.map((group) => ({
      id: group.id,
      rows: group.commands
        .map((id) => ({ id, label: commandLabel(id), parts: partsOf(id), custom: store.bindings[id].custom }))
        .filter((row) => needle === '' || row.label.toLowerCase().includes(needle) || row.id.includes(needle) || (row.parts?.join('+').toLowerCase().includes(needle) ?? false))
    })).filter((group) => group.rows.length > 0);
  });
  let anyCustom = $derived(Object.keys(store.keybindings?.bindings ?? {}).length > 0);

  function start(id: KeybindingCommand) {
    recording = id;
    held = [];
    conflict = null;
    problem = null;
  }

  function stop() {
    recording = null;
    held = [];
  }

  /** Who else answers to this chord: the table's own matcher decides, so `mod+k` and `ctrl+k` meet here. */
  function takenBy(id: KeybindingCommand, text: string): KeybindingCommand | null {
    const parsed = parseChord(text);
    if (!parsed.ok) return null;
    const wanted = chordParts(parsed.chord, mac).join('+');
    for (const group of COMMAND_GROUPS) {
      for (const other of group.commands) {
        if (other !== id && partsOf(other)?.join('+') === wanted) return other;
      }
    }
    return null;
  }

  async function apply(id: KeybindingCommand, chord: string | null | 'default') {
    busy = true;
    try {
      const failure = await store.setKeybinding(id, chord);
      problem = failure === null ? null : { id, message: failure };
    } finally {
      busy = false;
    }
  }

  async function replace() {
    if (!conflict) return;
    const { id, chord, other } = conflict;
    conflict = null;
    busy = true;
    try {
      const failure = (await store.setKeybinding(other, null)) ?? (await store.setKeybinding(id, chord));
      problem = failure === null ? null : { id, message: failure };
    } finally {
      busy = false;
    }
  }

  async function resetAll() {
    busy = true;
    try {
      const failure = await store.resetKeybindings();
      problem = failure === null ? null : { id: 'new-thread', message: failure };
    } finally {
      busy = false;
    }
  }

  /** Ahead of the app's own shortcuts, so the chord being recorded runs nothing. */
  function onkeydown(event: KeyboardEvent) {
    const id = recording;
    if (id === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const bare = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
    if (event.key === 'Escape' && bare) {
      stop();
      return;
    }
    const text = chordFromEvent(event, mac);
    if (text === null) {
      held = [event.ctrlKey && 'Ctrl', event.altKey && (mac ? 'Option' : 'Alt'), event.shiftKey && 'Shift', event.metaKey && (mac ? 'Cmd' : 'Win')].filter(
        (part): part is string => typeof part === 'string'
      );
      return;
    }
    const parsed = parseChord(text);
    if (!parsed.ok) {
      problem = { id, message: strings.keyboard.needsModifier };
      held = [];
      return;
    }
    stop();
    problem = null;
    const other = takenBy(id, text);
    if (other !== null) {
      conflict = { id, chord: text, other };
      return;
    }
    void apply(id, text);
  }

  function onkeyup(event: KeyboardEvent) {
    if (recording === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) held = [];
  }

  const example = '{\n  "new-thread": "mod+shift+n",\n  "palette": "mod+p",\n  "sidebar": null\n}';
</script>

<svelte:window onkeydowncapture={onkeydown} onkeyupcapture={onkeyup} onblur={stop} />

<div class="page" data-testid="keyboard-page">
  <header class="top">
    <div>
      <h1>{strings.settings.tabs.keyboard}</h1>
      <p class="intro" id="settings-shortcuts">{strings.keyboard.intro}</p>
    </div>
    {#if anyCustom}
      <button class="quiet small" data-testid="keybindings-reset-all" disabled={busy} onclick={() => void resetAll()}><RotateCcw size={14} />{strings.keyboard.resetAll}</button>
    {/if}
  </header>

  <label class="search">
    <Search size={15} />
    <input bind:value={filter} placeholder={strings.keyboard.search} aria-label={strings.keyboard.search} spellcheck="false" data-testid="keybindings-filter" />
  </label>

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

  {#each groups as group (group.id)}
    <section class="group" aria-labelledby="settings-keys-{group.id}">
      <h2 class="section-label" id="settings-keys-{group.id}">{strings.keyboard.groups[group.id]}</h2>
      <div class="card list">
        {#each group.rows as row (row.id)}
          <div class="row" data-testid="keybinding-row" data-command={row.id} class:custom={row.custom} class:recording={recording === row.id}>
            <div class="what">
              <span class="label" title={row.id}>{row.label}</span>
              {#if row.custom}<span class="tag">{strings.keyboard.custom}</span>{/if}
            </div>
            <div class="keys">
              {#if recording === row.id}
                <span class="capture" data-testid="keybinding-capture" role="status">
                  {#if held.length > 0}
                    {#each held as part, index (part)}{#if index > 0}<span class="plus">+</span>{/if}<kbd>{part}</kbd>{/each}<span class="plus">+</span>
                  {:else}
                    {strings.keyboard.record}
                  {/if}
                </span>
                <button class="quiet small" onclick={stop}>{strings.common.cancel}</button>
              {:else}
                <button class="chord" data-testid="keybinding-edit" title={strings.keyboard.change} disabled={busy} onclick={() => start(row.id)}>
                  <span class="caps" data-testid="keybinding-key">
                    {#if row.parts === null}
                      <span class="none">{strings.keyboard.none}</span>
                    {:else}
                      {#each row.parts as part, index (index)}{#if index > 0}<span class="plus">+</span>{/if}<kbd>{part}</kbd>{/each}
                    {/if}
                  </span>
                </button>
                <span class="tools">
                  {#if row.custom}
                    <button class="quiet icon-only" data-testid="keybinding-reset" aria-label={strings.keyboard.reset} title={strings.keyboard.reset} disabled={busy} onclick={() => void apply(row.id, 'default')}><RotateCcw size={14} /></button>
                  {/if}
                  {#if row.parts !== null}
                    <button class="quiet icon-only" data-testid="keybinding-clear" aria-label={strings.keyboard.clear} title={strings.keyboard.clear} disabled={busy} onclick={() => void apply(row.id, null)}><X size={14} /></button>
                  {/if}
                </span>
              {/if}
            </div>
            {#if conflict?.id === row.id}
              {@const chosen = parseChord(conflict.chord)}
              <div class="row-note" data-testid="keybinding-conflict">
                <span>{strings.keyboard.conflict.replace('{chord}', chosen.ok ? chordParts(chosen.chord, mac).join('+') : conflict.chord).replace('{command}', commandLabel(conflict.other))}</span>
                <span class="note-actions">
                  <button class="primary small" data-testid="keybinding-replace" onclick={() => void replace()}>{strings.keyboard.replace}</button>
                  <button class="quiet small" onclick={() => (conflict = null)}>{strings.common.cancel}</button>
                </span>
              </div>
            {/if}
            {#if problem?.id === row.id}<p class="row-note bad" role="alert">{problem.message}</p>{/if}
          </div>
        {/each}
      </div>
    </section>
  {:else}
    <p class="intro">{strings.keyboard.noMatch}</p>
  {/each}

  <details class="card file">
    <summary id="settings-keybinding-file">{strings.keyboard.file}</summary>
    <p class="mono path" data-testid="keybindings-path">{store.keybindings?.path ?? ''}</p>
    <p class="intro">{strings.keyboard.fileHint}</p>
    <p class="subtle example-label">{strings.keyboard.example}</p>
    <pre class="mono">{example}</pre>
  </details>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  /* One measure for every block, the settings cards' own. */
  .page > :global(*) {
    width: 100%;
    max-width: 880px;
  }
  :global(.settings) .page > header.top {
    margin-bottom: 4px;
  }
  .page .list.card,
  .page > .card {
    max-width: 880px;
    margin-bottom: 0;
  }
  .top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }
  .top h1 {
    margin-bottom: 6px;
  }
  .intro {
    margin: 0;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    line-height: 1.6;
  }

  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--input);
    padding: 0 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    color: var(--color-muted-foreground);
  }
  .search:focus-within {
    border-color: var(--color-edge);
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    outline: none;
  }

  .group {
    display: grid;
    gap: 8px;
  }
  .group h2 {
    margin: 4px 0 0;
  }
  .page .list {
    padding: 0;
    overflow: hidden;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px 16px;
    min-height: var(--row);
    padding: 7px 10px 7px 16px;
    transition: background var(--dur-2) var(--ease-out-quint);
  }
  .row + .row {
    border-top: 1px solid var(--color-border);
  }
  .row.recording {
    background: var(--color-hover);
  }
  .what {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .label {
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    flex: none;
    font-size: var(--text-xs);
    color: var(--color-subtle);
  }
  .keys {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
  }

  /* The caps are the button: a click on the chord is the way to change it. */
  .chord {
    height: auto;
    min-height: var(--control-sm);
    padding: 3px 6px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    box-shadow: none;
    font-weight: normal;
  }
  .chord:hover:not(:disabled) {
    border-color: var(--color-border);
    background: var(--color-hover);
  }
  .caps {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .plus {
    color: var(--color-subtle);
    font-size: var(--text-xs);
  }
  kbd {
    display: inline-grid;
    place-items: center;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border: 1px solid var(--color-edge);
    border-bottom-width: 2px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--color-foreground);
  }
  .none {
    font-size: var(--text-sm);
    color: var(--color-subtle);
  }
  .chord:hover .none {
    color: var(--color-muted-foreground);
  }
  .capture {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    min-height: var(--control-sm);
    padding: 0 10px;
    border: 1px dashed var(--color-edge);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
    animation: listen 1.2s var(--ease-out-quint) infinite alternate;
  }
  @keyframes listen {
    from { border-color: var(--color-edge); }
    to { border-color: var(--color-muted-foreground); }
  }
  .tools {
    display: inline-flex;
    width: 56px;
    justify-content: flex-end;
    gap: 2px;
  }
  .icon-only {
    width: var(--control-sm);
    height: var(--control-sm);
    padding: 0;
    color: var(--color-muted-foreground);
  }
  .row-note {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }
  .note-actions {
    display: inline-flex;
    gap: 6px;
  }
  .bad {
    color: var(--color-danger);
  }

  .problems {
    border-color: var(--color-danger);
  }
  .problems ul {
    margin: 8px 0 0;
    padding-left: 18px;
  }
  .problems li {
    font-size: var(--text-sm);
    margin-bottom: 4px;
  }

  .file {
    padding: 14px 20px;
  }
  .file summary {
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }
  .file[open] summary {
    margin-bottom: 12px;
    color: var(--color-foreground);
  }
  .path {
    margin: 0 0 8px;
    word-break: break-all;
    color: var(--color-foreground);
    font-size: var(--text-sm);
  }
  .subtle {
    color: var(--color-muted-foreground);
  }
  .example-label {
    margin: 12px 0 4px;
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
    overflow-x: auto;
  }
  @media (prefers-reduced-motion: reduce) {
    .capture { animation: none; }
  }
  @media (max-width: 720px) {
    .top { flex-direction: column; gap: 8px; }
    .row { grid-template-columns: 1fr; padding-right: 12px; }
    .keys { justify-content: flex-start; }
  }
</style>
