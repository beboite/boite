<script lang="ts">
  import { Check, ChevronRight, CircleSlash, Wrench, X } from '@lucide/svelte';
  import type { ToolDocument, ToolStatus } from '@boite/contracts';
  import { json } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import DocumentView from './DocumentView.svelte';

  let {
    name,
    input,
    inputText = null,
    output,
    status,
    documents = []
  }: {
    name: string;
    input: unknown;
    inputText?: string | null;
    output: string | null;
    status: ToolStatus;
    documents?: ToolDocument[];
  } = $props();

  let open = $state(false);

  const SUMMARY_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'notebook_path', 'prompt', 'description'];

  /** The first `"key": "value` of a half-typed JSON object, so the line reads before it closes. */
  const PARTIAL_VALUE = /"[^"]*"\s*:\s*"((?:[^"\\]|\\.)*)/;

  /** The one value a reader wants on the closed line: the path, the command, the pattern. */
  function summary(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value !== 'object' || value === null) return '';
    const record = value as Record<string, unknown>;
    for (const key of SUMMARY_KEYS) {
      const found = record[key];
      if (typeof found === 'string' && found.length > 0) return found.split('\n')[0] ?? '';
    }
    const first = Object.values(record).find((entry) => typeof entry === 'string');
    return typeof first === 'string' ? (first.split('\n')[0] ?? '') : '';
  }

  /** While the JSON is still arriving the summary comes from it, else the tool name. */
  function partialSummary(text: string): string {
    const found = PARTIAL_VALUE.exec(text);
    const value = found?.[1] ?? '';
    return value.length > 0 ? (value.split('\\n')[0] ?? '') : '';
  }

  /** `2 diffs` when every document is one, `2 docs` when they are mixed. */
  function chipFor(list: ToolDocument[]): string {
    const count = String(list.length);
    const diffs = list.every((entry) => entry.kind === 'diff');
    const one = list.length === 1;
    const template = diffs
      ? one
        ? strings.chat.documentChip.diff
        : strings.chat.documentChip.diffs
      : one
        ? strings.chat.documentChip.doc
        : strings.chat.documentChip.docs;
    return fill(template, { count });
  }

  /** What the expanded input is cut to before `Show all` is pressed. */
  const CLAMP_LINES = 6;

  let showAll = $state(false);

  let streaming = $derived(typeof inputText === 'string');
  // The body opens itself while the input is being typed: that is the whole point
  // of the stream. It folds back to the one line once the parsed input lands.
  let shown = $derived(open || streaming);
  let line = $derived(streaming ? partialSummary(inputText ?? '') : summary(input));
  let chip = $derived(documents.length > 0 && !shown ? chipFor(documents) : '');

  let inputJson = $derived(streaming ? '' : json(input));
  /**
   * A parsed input past six lines opens cut, with one ghost button under it. A
   * streaming one is never cut: the block cursor rides its last line.
   */
  let clamped = $derived(!streaming && !showAll && inputJson.split('\n').length > CLAMP_LINES);

  // The body is built on the first open and folds from then on, so a timeline of
  // closed cards costs nothing and an open one animates its height both ways.
  let built = $state(false);
  $effect(() => {
    if (shown) built = true;
  });
</script>

<div class="tool" data-testid="tool-card" data-status={status} data-streaming={streaming}>
  <button
    type="button"
    class="ghost head"
    data-testid="tool-toggle"
    aria-expanded={shown}
    onclick={() => (open = !open)}
  >
    <span class="caret" class:open={shown}><ChevronRight size={13} strokeWidth={2} /></span>
    <span class="glyph"><Wrench size={13} strokeWidth={1.75} /></span>
    <span class="name">{name}</span>
    {#if line}
      <span class="line mono" title={line}>{line}</span>
    {/if}
    {#if chip}
      <span class="chip" data-testid="tool-document-chip">{chip}</span>
    {/if}
    <span class="status {status}" title={strings.chat.toolStatus[status]}>
      {#if status === 'running'}
        <span class="spinner"></span>
      {:else if status === 'done'}
        <Check size={13} strokeWidth={2.25} />
      {:else if status === 'denied'}
        <CircleSlash size={13} strokeWidth={2} />
      {:else}
        <X size={13} strokeWidth={2.25} />
      {/if}
    </span>
  </button>

  <div class="fold" class:open={shown} inert={!shown}>
    <div class="clip">
      {#if built}
        <div class="body">
          <div class="section-label">{strings.chat.toolInput}</div>
          {#if streaming}
            <pre
              class="mono"
              data-testid="tool-input">{inputText}<span class="cursor" aria-label={strings.chat.streaming}></span></pre>
          {:else}
            <pre class="mono" class:clamped data-testid="tool-input">{inputJson}</pre>
            {#if clamped}
              <button
                type="button"
                class="ghost small show-all"
                data-testid="tool-input-show-all"
                onclick={() => (showAll = true)}
              >
                {strings.chat.showAll}
              </button>
            {/if}
          {/if}
          <div class="section-label">{strings.chat.toolOutput}</div>
          <pre class="mono" data-testid="tool-output">{output ?? strings.chat.noOutput}</pre>
          {#if documents.length > 0}
            <div class="section-label">{strings.chat.toolDocuments}</div>
            <div class="documents">
              {#each documents as doc, index (index)}
                <DocumentView {doc} />
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .tool {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e1);
    max-width: 100%;
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: var(--row);
    padding: 0 10px 0 6px;
    border-radius: 0;
    color: var(--color-muted-foreground);
    justify-content: flex-start;
  }

  .head:hover:not(:disabled) {
    background: var(--color-surface-2);
  }

  /* A full width row does not shrink under the finger, it fills one step more. */
  .head:active:not(:disabled) {
    transform: none;
    background: var(--color-surface-3);
  }

  .caret {
    display: inline-flex;
    color: var(--color-subtle);
    transition: transform var(--dur-2) var(--ease-out-quint);
  }

  .caret.open {
    transform: rotate(90deg);
  }

  .glyph {
    display: inline-flex;
    color: var(--color-subtle);
  }

  .name {
    font-weight: 600;
    color: var(--color-foreground);
    flex: none;
  }

  .line {
    flex: 1;
    min-width: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
  }

  .chip {
    flex: none;
    height: 18px;
    display: inline-flex;
    align-items: center;
    padding: 0 6px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .status {
    display: inline-flex;
    margin-left: auto;
    color: var(--color-subtle);
  }

  .status.done {
    color: var(--color-success);
  }

  .status.error,
  .status.denied {
    color: var(--color-danger);
  }

  .spinner {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 1.5px solid var(--color-edge);
    border-top-color: var(--color-live);
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* The open and the close are the same move: the rows track goes 0fr to 1fr,
     so the card grows to whatever the body measures without a pixel written. */
  .fold {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows var(--dur-3) var(--ease-out-quint),
      opacity var(--dur-3) var(--ease-out-quint);
  }

  .fold.open {
    grid-template-rows: 1fr;
    opacity: 1;
  }

  .clip {
    min-height: 0;
    overflow: hidden;
  }

  .body {
    border-top: 1px solid var(--color-border);
    padding: 8px 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /* A well sits above the card's fill, never below the page: a hole reads as damage. */
  pre {
    margin: 0 0 6px;
    padding: 8px 10px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    max-height: 260px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  pre:last-child {
    margin-bottom: 0;
  }

  pre.clamped {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    max-height: none;
    overflow: hidden;
    margin-bottom: 2px;
  }

  .show-all {
    align-self: flex-start;
    margin-bottom: 6px;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }

  .documents {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  /* The same blinking block a streaming text part ends on, so both read as one
     thing. Not `.caret`: that class is the head's chevron. */
  .cursor {
    display: inline-block;
    width: 7px;
    height: 12px;
    margin-left: 2px;
    vertical-align: -2px;
    background: var(--color-foreground);
    border-radius: 1px;
    animation: blink 1s steps(2, start) infinite;
  }
</style>
