<script lang="ts">
  import { page } from '../lib/page-hidden.svelte';
  import { Bot, ChevronRight, FilePen, FileText, Globe, Search, SquareTerminal, Wrench, X } from '@lucide/svelte';
  import type { ToolDocument, ToolStatus } from '@boite/contracts';
  import { elapsed, json } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import { familyOf, liveLabel, runSummary, toolLine, type ToolPart } from '../lib/tool-groups';
  import { describeTool, fileName } from '../lib/tool-summary';
  import { toolErrorPreview } from '../lib/tool-error';
  import { diffCounts, diffRows } from '../lib/diff';
  import DiffView from './DiffView.svelte';
  import DocumentView from './DocumentView.svelte';

  /*
   * One tool call as a plain line of the timeline: what it did
   * in words or the command it ran, a clock past one second, a mark only when
   * it runs or failed, and the input, the output and what it produced one
   * click below. A run of calls folds under `ToolGroup`.
   */

  let {
    name,
    input,
    inputText = null,
    output,
    outputDeferred = false,
    inputDeferred = false,
    documentsDeferred = false,
    loadOutput,
    status,
    exitCode = null,
    documents = [],
    startedAt = null,
    finishedAt = null,
    background = false,
    nested = false
  }: {
    name: string;
    input: unknown;
    inputText?: string | null;
    output: string | null;
    outputDeferred?: boolean;
    /** `input` is a preview: the line reads from it, the body waits for the whole call. */
    inputDeferred?: boolean;
    /** `documents` are stubs naming their kind and path: the body waits for the whole call. */
    documentsDeferred?: boolean;
    /** Fetches what the page left on the core: output, input and documents. */
    loadOutput?: () => Promise<void>;
    status: ToolStatus;
    exitCode?: number | null;
    documents?: ToolDocument[];
    /** When the card first showed up and when it stopped running, as the core stamped them. */
    startedAt?: number | null;
    finishedAt?: number | null;
    /** The work this call started still runs in the background. */
    background?: boolean;
    /** Inside an expanded group, show the individual command rather than another summary. */
    nested?: boolean;
  } = $props();

  let now = $state(Date.now());
  const hidden = $derived(page.hidden);
  // A running call ticks once a second while the page is on screen.
  $effect(() => {
    if (status !== 'running' || startedAt === null || hidden) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
  /** Shown from one second on: a quick call needs no clock. */
  let took = $derived.by(() => {
    if (startedAt === null) return '';
    const end = status === 'running' ? now : finishedAt;
    if (end === null || end === undefined) return '';
    const spent = end - startedAt;
    return spent >= 1000 ? elapsed(spent) : '';
  });

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
  let part = $derived<ToolPart>({ type: 'tool', toolId: '', name, input, inputText, output, status });
  let line = $derived(toolLine(part));
  let family = $derived(familyOf(part));
  let failed = $derived(status === 'error' || status === 'denied');
  let errorPreview = $derived(toolErrorPreview(part));
  let exitLabel = $derived(family === 'command' && status === 'error' && exitCode !== null
    ? fill(strings.chat.toolExitCode, { code: String(exitCode) }) : '');
  const ICONS = { command: SquareTerminal, read: FileText, edit: FilePen, write: FilePen, search: Search, fetch: Globe, web: Globe, agent: Bot, other: Wrench };
  let Glyph = $derived(ICONS[family]);

  type Diff = Extract<ToolDocument, { kind: 'diff' }>;
  /**
   * What a file change did, as a diff: the ones the driver attached, else the
   * one the edit's own input spells out (an agent whose driver attaches none).
   * A failed or refused edit spells out what it meant to do, not what it did,
   * so nothing is inferred from it.
   */
  let diffs = $derived.by<Diff[]>(() => {
    const attached = documents.filter((doc): doc is Diff => doc.kind === 'diff');
    // A cut input would spell out a cut change.
    if (attached.length > 0 || streaming || failed || inputDeferred) return attached;
    const change = describeTool(name, input).change;
    return change ? [{ kind: 'diff', ...change }] : [];
  });
  let others = $derived(documents.filter((doc) => doc.kind !== 'diff'));
  let compact = $derived(!nested && documents.length === 0 && diffs.length === 0);
  let label = $derived(streaming ? liveLabel(part) : compact ? status === 'running' ? liveLabel(part) : runSummary([part]) : line.text);
  let counts = $derived(documentsDeferred ? { added: 0, removed: 0 } : diffs.reduce((sum, doc) => {
    const one = diffCounts(diffRows(doc.oldText, doc.newText));
    return { added: sum.added + one.added, removed: sum.removed + one.removed };
  }, { added: 0, removed: 0 }));
  /**
   * One file needs no heading of its own when the line already names it. A
   * command's line is the command, which may not.
   */
  let headless = $derived(new Set(diffs.map((doc) => doc.path)).size <= 1 && line.text.includes(fileName(diffs[0]?.path ?? '')));

  // Input stays behind the disclosure while it arrives. A successful edit opens
  // on its diff, unless the diff stayed on the core: a heavy one waits for a click.
  let toggled = $state<boolean | null>(null);
  let shown = $derived(toggled ?? (diffs.length > 0 && !failed && !documentsDeferred));
  let chip = $derived(shown ? '' : documentsDeferred ? chipFor(documents) : others.length > 0 ? chipFor(others) : '');
  let deferred = $derived(outputDeferred || inputDeferred || documentsDeferred);

  let inputJson = $derived(streaming ? '' : json(input));
  /**
   * A parsed input past six lines opens cut, with one ghost button under it. A
   * streaming one is never cut: the block cursor rides its last line.
   */
  let clamped = $derived(!streaming && !showAll && inputJson.split('\n').length > CLAMP_LINES);

  // The body is built on the first open and folds from then on, so a timeline of
  // closed cards costs nothing and an open one animates its height both ways.
  let built = $state(false);
  let attempted = false;
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  $effect(() => {
    if (!deferred) attempted = false;
    if (shown) built = true;
    if (!shown || !deferred || !loadOutput || attempted) return;
    attempted = true;
    loading = true;
    void loadOutput().catch(reason => { loadError = reason instanceof Error ? reason.message : String(reason); }).finally(() => { loading = false; });
  });
</script>

<div class="tool" data-testid="tool-card" data-status={status} data-streaming={streaming} data-family={family}>
  <button
    type="button"
    class="ghost head"
    data-testid="tool-toggle"
    aria-expanded={shown}
    aria-label={failed ? `${line.text}, ${strings.chat.toolStatus[status]}` : undefined}
    onclick={() => { if (!shown) { attempted = false; loadError = null; } toggled = !shown; }}
  >
    <span class="glyph"><Glyph size={15} strokeWidth={1.75} /></span>
    <span class="line ui-label" class:mono={!compact && line.mono} class:live={status === 'running'} title={diffs[0]?.path ?? line.title}>{label}</span>
    {#if counts.added > 0 || counts.removed > 0}
      <span class="counts" data-testid="tool-diff-counts">
        {#if counts.added > 0}<span class="added">{fill(strings.chat.diffAdded, { count: String(counts.added) })}</span>{/if}
        {#if counts.removed > 0}<span class="removed">{fill(strings.chat.diffRemoved, { count: String(counts.removed) })}</span>{/if}
      </span>
    {/if}
    {#if chip}
      <span class="chip" data-testid="tool-document-chip"><span class="ui-label">{chip}</span></span>
    {/if}
    {#if background}
      <span class="chip live" data-testid="tool-background"><span class="pulse" aria-hidden="true"></span><span class="ui-label">{strings.chat.backgroundChip}</span></span>
    {/if}
    {#if took}
      <span class="took ui-label" data-testid="tool-elapsed">{took}</span>
    {/if}
    {#if exitLabel}
      <span class="took ui-label" data-testid="tool-exit-code">{exitLabel}</span>
    {/if}
    {#if status === 'running'}
      <span class="status" title={strings.chat.toolStatus.running}><span class="spinner"></span></span>
    {:else if failed}
      <span class="status" title={strings.chat.toolStatus[status]}><X size={12} strokeWidth={2.25} /></span>
    {/if}
    <span class="fold-caret" class:open={shown} aria-hidden="true"><ChevronRight size={12} /></span>
  </button>

  <div class="fold" class:open={shown} inert={!shown}>
    <div class="clip">
      {#if built}
        <div class="body">
          {#if loading}<p data-testid="tool-output-loading">{strings.app.loading}</p>{/if}
          {#if loadError}<p class="error-preview" role="alert">{loadError}</p>{/if}
          {#if failed && errorPreview}
            <p class="error-preview" data-testid="tool-error-preview">{errorPreview}</p>
          {/if}
          {#if documentsDeferred}
            <!-- Stubs only: the body is drawn once the whole call is here. -->
          {:else if diffs.length > 0}
            <!-- A file change reads as its diff: the input only restates it. -->
            {#if failed}
              {#if !outputDeferred}<pre class="mono" data-testid="tool-output">{output ?? strings.chat.noOutput}</pre>{/if}
            {/if}
            <div class="diffs">
              {#each diffs as doc, index (index)}
                <div data-testid="tool-document" data-kind="diff"><DiffView path={doc.path} oldText={doc.oldText} newText={doc.newText} {headless} /></div>
              {/each}
            </div>
            {#if others.length > 0}
              <div class="documents">
                {#each others as doc, index (index)}
                  <DocumentView {doc} />
                {/each}
              </div>
            {/if}
          {:else}
            <div class="section-label">{strings.chat.toolInput}</div>
            {#if streaming}
              <pre
                class="mono"
                data-testid="tool-input">{inputText}<span class="cursor" aria-label={strings.chat.streaming}></span></pre>
            {:else if !inputDeferred}
              <pre class="mono" class:clamped data-testid="tool-input">{inputJson}</pre>
              {#if clamped}
                <button
                  type="button"
                  class="ghost small show-all"
                  data-testid="tool-input-show-all"
                  onclick={() => (showAll = true)}
                >
                  <span class="ui-label">{strings.chat.showAll}</span>
                </button>
              {/if}
            {/if}
            <div class="section-label">{strings.chat.toolOutput}</div>
            {#if !outputDeferred}<pre class="mono" data-testid="tool-output">{output ?? strings.chat.noOutput}</pre>{/if}
            {#if documents.length > 0}
              <div class="section-label">{strings.chat.toolDocuments}</div>
              <div class="documents">
                {#each documents as doc, index (index)}
                  <DocumentView {doc} />
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  /* No frame: a call is a line of the timeline. */
  .tool {
    max-width: 100%;
    min-width: 0;
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--activity-gap);
    width: 100%;
    min-height: var(--control);
    height: auto;
    padding: var(--activity-padding);
    border-radius: var(--radius-sm);
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    font-weight: 400;
    justify-content: flex-start;
  }

  .head:hover:not(:disabled) {
    background: var(--color-surface-2);
    color: var(--color-foreground);
  }

  /* A full width row does not shrink under the finger, it fills one step more. */
  .head:active:not(:disabled) {
    transform: none;
    background: var(--color-surface-3);
  }

  .glyph {
    display: inline-flex;
    flex: none;
    width: var(--activity-glyph);
    justify-content: center;
    color: var(--color-subtle);
  }

  .line {
    flex: 0 1 auto;
    min-width: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
  }

  /* A command is set in the code face, a step smaller so it sits on the same line height. */
  .line.mono {
    font-size: var(--text-xs);
  }

  .line.live { color: var(--color-accent); }
  .error-preview { margin: 0 0 4px; color: var(--color-danger); font-size: var(--text-xs); overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }

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

  .chip.live {
    gap: 5px;
    color: var(--color-accent);
    border-color: color-mix(in oklch, var(--color-accent) 40%, transparent);
  }

  .pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 1.6s var(--ease-out-quint) infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .3; }
  }

  .took {
    flex: none;
    color: var(--color-subtle);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .status {
    display: inline-flex;
    flex: none;
    color: var(--color-subtle);
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

  /* The body sits under the line's words, past the glyph. */
  .body {
    padding: 4px var(--activity-padding) 8px var(--activity-indent);
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

  .counts {
    display: inline-flex;
    flex: none;
    gap: 6px;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .counts .added { color: var(--color-success); }
  .counts .removed { color: var(--color-danger); }

  .diffs {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .documents {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  /* The same blinking block a streaming text part ends on, so both read as one
     thing. Not `.fold-caret`: that class is the head's chevron. */
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

  /* An endless loop stops under reduced motion; the static mark keeps its colour. */
  @media (prefers-reduced-motion: reduce) { :is(.pulse, .spinner, .cursor) { animation: none; } }
  :global(html[data-motion='reduced']) :is(.pulse, .spinner, .cursor) { animation: none; }
</style>
