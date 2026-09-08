<script lang="ts">
  import { Check, ChevronRight, CircleSlash, Wrench, X } from '@lucide/svelte';
  import type { ToolStatus } from '@boite/contracts';
  import { json } from '../lib/format';
  import { strings } from '../lib/strings';

  let {
    name,
    input,
    inputText = null,
    output,
    status
  }: {
    name: string;
    input: unknown;
    inputText?: string | null;
    output: string | null;
    status: ToolStatus;
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

  let streaming = $derived(typeof inputText === 'string');
  // The body opens itself while the input is being typed: that is the whole point
  // of the stream. It folds back to the one line once the parsed input lands.
  let shown = $derived(open || streaming);
  let line = $derived(streaming ? partialSummary(inputText ?? '') : summary(input));
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

  {#if shown}
    <div class="body">
      <div class="section-label">{strings.chat.toolInput}</div>
      {#if streaming}
        <pre
          class="mono"
          data-testid="tool-input">{inputText}<span class="caret" aria-label={strings.chat.streaming}></span></pre>
      {:else}
        <pre class="mono" data-testid="tool-input">{json(input)}</pre>
      {/if}
      <div class="section-label">{strings.chat.toolOutput}</div>
      <pre class="mono" data-testid="tool-output">{output ?? strings.chat.noOutput}</pre>
    </div>
  {/if}
</div>

<style>
  .tool {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    max-width: 100%;
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 30px;
    padding: 0 10px 0 6px;
    border-radius: 0;
    color: var(--color-muted-foreground);
    justify-content: flex-start;
  }

  .head:hover:not(:disabled) {
    background: var(--color-surface-2);
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
    font-size: var(--text-xs);
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

  .body {
    border-top: 1px solid var(--color-border);
    padding: 8px 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  pre {
    margin: 0 0 6px;
    padding: 8px 10px;
    background: var(--color-background);
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

  /* The same caret a streaming text part ends on, so both read as one thing. */
  .caret {
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
