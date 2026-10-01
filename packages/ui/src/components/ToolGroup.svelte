<script lang="ts">
  import { Bot, ChevronRight, FilePen, FileText, Globe, Search, SquareTerminal, Wrench, X } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  import { familyOf, liveLabel, runSummary, type ToolPart } from '../lib/tool-groups';
  import ToolCard from './ToolCard.svelte';

  /*
   * A run of tool calls with nothing between them. One call is its own line;
   * two or more fold under one sentence: "Ran 3
   * commands and read 2 files" once they are done, the running call's own
   * words ("Running git") while one runs. The fold opens on the calls, each
   * one the same line it would be alone.
   */
  let {
    parts,
    isBackground
  }: {
    parts: ToolPart[];
    /** Whether the work a call started still runs in the background. */
    isBackground: (toolId: string) => boolean;
  } = $props();

  const ICONS = { command: SquareTerminal, read: FileText, edit: FilePen, write: FilePen, search: Search, fetch: Globe, web: Globe, agent: Bot, other: Wrench };

  let open = $state(false);
  let live = $derived(parts.findLast((part) => part.status === 'running'));
  let last = $derived(parts.at(-1));
  /** The mark follows the latest call: an early miss the agent recovered from is no alarm. */
  let failed = $derived(!live && (last?.status === 'error' || last?.status === 'denied'));
  let label = $derived(live ? liveLabel(live) : runSummary(parts));
  let Glyph = $derived(ICONS[familyOf(live ?? last ?? parts[0]!)]);
  let busy = $derived(parts.some((part) => isBackground(part.toolId)));

  // Built on the first open, then folded both ways like a single call's body.
  let built = $state(false);
  $effect(() => {
    if (open) built = true;
  });
</script>

{#snippet call(part: ToolPart, nested = false)}
  <ToolCard
    name={part.name}
    input={part.input}
    inputText={part.inputText}
    output={part.output}
    status={part.status}
    exitCode={part.exitCode}
    documents={part.documents ?? []}
    startedAt={part.startedAt ?? null}
    finishedAt={part.finishedAt ?? null}
    background={isBackground(part.toolId)}
    {nested}
  />
{/snippet}

{#if parts.length === 1 && parts[0]}
  {@render call(parts[0])}
{:else}
  <div class="group" data-testid="tool-group" data-count={parts.length} data-live={live !== undefined}>
    <button
      type="button"
      class="ghost head"
      data-testid="tool-group-toggle"
      aria-expanded={open}
      title={open ? strings.chat.toolRunHide : strings.chat.toolRunShow}
      aria-label={failed ? `${label}, ${strings.chat.toolFailed}` : undefined}
      onclick={() => (open = !open)}
    >
      <span class="glyph" class:failed><Glyph size={15} strokeWidth={1.75} /></span>
      <span class="label" class:shimmer={live !== undefined} data-testid="tool-group-label">{label}</span>
      {#if busy}
        <span class="pulse" aria-hidden="true"></span>
      {/if}
      {#if live}
        <span class="spinner" aria-hidden="true"></span>
      {:else if failed}
        <span class="status"><X size={12} strokeWidth={2.25} /></span>
      {/if}
      <span class="caret" class:open aria-hidden="true"><ChevronRight size={12} strokeWidth={2} /></span>
    </button>
    <div class="fold" class:open inert={!open}>
      <div class="clip">
        {#if built}
          <div class="calls">
            {#each parts as part (part.toolId)}
              {@render call(part, true)}
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .group {
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

  .glyph.failed,
  .status {
    color: var(--color-danger);
  }

  .status {
    display: inline-flex;
    flex: none;
  }

  .label {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }

  /* A light passing over the words while a call runs. */
  .label.shimmer {
    background: linear-gradient(90deg, var(--color-muted-foreground) 35%, var(--color-foreground) 50%, var(--color-muted-foreground) 65%) 0 0 / 300% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: shimmer 2.2s linear infinite;
  }

  @keyframes shimmer {
    from { background-position: 100% 0; }
    to { background-position: 0 0; }
  }

  .caret {
    display: inline-flex;
    flex: none;
    color: var(--color-subtle);
    transition: transform var(--dur-2) var(--ease-out-quint);
  }

  .caret.open {
    transform: rotate(90deg);
  }

  .pulse {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-accent);
    animation: pulse 1.6s var(--ease-out-quint) infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .3; }
  }

  .spinner {
    flex: none;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 1.5px solid var(--color-edge);
    border-top-color: var(--color-live);
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

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

  /* The calls hang off a hairline under the summary's glyph. */
  .calls {
    display: flex;
    flex-direction: column;
    gap: var(--chat-part-gap);
    margin: 4px 0 8px calc(var(--activity-padding) + var(--activity-glyph) / 2);
    padding-left: var(--activity-gap);
    border-left: 1px solid var(--color-border);
  }

  @media (prefers-reduced-motion: reduce) { :is(.pulse, .spinner, .label.shimmer) { animation: none; } .label.shimmer { color: var(--color-muted-foreground); background: none; } }
  :global(html[data-motion='reduced']) :is(.pulse, .spinner, .label.shimmer) { animation: none; }
  :global(html[data-motion='reduced']) .label.shimmer { color: var(--color-muted-foreground); background: none; }
</style>
