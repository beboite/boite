<script lang="ts">
  import { secondClock } from '../lib/clock.svelte';
  import { Bot, Brain, ChevronRight, FilePen, FileText, Globe, Search, ShieldCheck, ShieldX, SquareTerminal, TriangleAlert, Wrench } from '@lucide/svelte';
  import type { PermissionRequest, RequestId } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { elapsed } from '../lib/format';
  import { agentSummary, familyOf, liveLabel, pairPermissions, runSpan, runSummary, thinkingShown, ThoughtTitleScan, type ActivityPart, type PermissionStep, type ThinkingStep, type ToolPart } from '../lib/tool-groups';
  import PermissionCard from './PermissionCard.svelte';
  import ThinkingPart from './ThinkingPart.svelte';
  import ToolCard from './ToolCard.svelte';
  import type { Store } from '../lib/store.svelte';

  /*
   * A run of activity with no answer between it: calls and the reasoning around
   * them. One visible step is drawn as itself; more fold under one line, "Ran 3
   * commands and read 2 files" with the time the run took once it is done, or
   * the agent's own summary of those calls when it wrote one ("Read rules.md and
   * data.txt"); the running step's own words ("Running git", the thought it is
   * on) while one runs. The fold opens on the steps, each one the same line it
   * would be alone. Reasoning with no words that took under a second is not
   * drawn at all. A permission the agent asked is one thing with its call:
   * while it waits, its card stands for the call under the run; once answered,
   * the call's line carries the answer as a shield.
   */
  let {
    parts,
    thinkingLive = false,
    isBackground,
    loadOutput,
    permissionRequest = () => null,
    answerPermission = () => false,
    store,
    threadId
  }: {
    parts: ActivityPart[];
    /** The run's last step is reasoning that is still being written. */
    thinkingLive?: boolean;
    /** Whether the work a call started still runs in the background. */
    isBackground: (toolId: string) => boolean;
    loadOutput?: (toolId: string) => Promise<void>;
    /** What a permission asked, for its card: null once the record is gone. */
    permissionRequest?: (requestId: RequestId) => PermissionRequest | null;
    /** Sends the user's answer to a permission; false gives its buttons back. */
    answerPermission?: (requestId: RequestId, decision: 'allow' | 'deny') => unknown;
    /** The machine and thread the run belongs to, where a thread link in it starts from. */
    store?: Store;
    threadId?: string;
  } = $props();

  const ICONS = { command: SquareTerminal, read: FileText, edit: FilePen, write: FilePen, search: Search, fetch: Globe, web: Globe, agent: Bot, other: Wrench };

  const isLive = (index: number) => thinkingLive && index === parts.length - 1;
  let pairs = $derived(pairPermissions(parts));
  /** The permission each paired call was asked under, by the call's index. */
  let asked = $derived(new Map([...pairs].map(([at, call]) => [call, parts[at] as PermissionStep])));
  /** Waiting permissions: each card stands for its call, under the run. */
  let waiting = $derived(parts.filter((part): part is PermissionStep => part.type === 'permission' && part.decision === null));
  let steps = $derived(parts.flatMap((part, index): { part: ActivityPart; index: number }[] => {
    if (part.type === 'permission') return part.decision !== null && !pairs.has(index) ? [{ part, index }] : [];
    if (part.type === 'tool') return asked.get(index)?.decision === null ? [] : [{ part, index }];
    return thinkingShown(part, isLive(index)) ? [{ part, index }] : [];
  }));
  /** The run's answers on its folded line: a cross when the user refused any call. */
  let verdict = $derived.by(() => {
    const decisions = [...asked.values()].map((permission) => permission.decision);
    return decisions.includes('deny') ? 'deny' : decisions.includes('allow') ? 'allow' : null;
  });
  let tools = $derived(parts.filter((part): part is ToolPart => part.type === 'tool'));

  let open = $state(false);
  let running = $derived(tools.findLast((part) => part.status === 'running'));
  let thinking = $derived(running === undefined && thinkingLive);
  let live = $derived(running !== undefined || thinking);
  let issues = $derived(tools.filter(part => part.status === 'error' || part.status === 'denied').length);
  let said = $derived(verdict === 'allow' ? strings.chat.permissionAllowedBy : verdict === 'deny' ? strings.chat.permissionDeniedBy : null);
  let issueLabel = $derived(fill(issues === 1 ? strings.chat.toolIssueOne : strings.chat.toolIssueMany, { count: String(issues) }));
  // Live, the thought being written; otherwise the last one that has words.
  let thought = $derived(thinking ? parts.at(-1) as ThinkingStep : parts.findLast((part): part is ThinkingStep => part.type === 'thinking' && part.text.trim() !== ''));
  // A text that does not extend the last one starts the scan over: another thought needs no reset.
  const titles = new ThoughtTitleScan();
  let label = $derived(running ? liveLabel(running) : thinking || tools.length === 0 ? titles.title(thought?.text ?? '') ?? strings.chat.thinking : agentSummary(tools) ?? runSummary(tools));
  let Glyph = $derived(running ? ICONS[familyOf(running)] : thinking || tools.length === 0 ? Brain : ICONS[familyOf(tools.at(-1)!)]);
  let busy = $derived(tools.some((part) => isBackground(part.toolId)));

  // The run's clock: it ticks while a step runs and stops on the last finish.
  // Only a group of two steps or more shows it.
  let took = $derived.by(() => {
    const span = runSpan(parts);
    if (!span) return '';
    const ms = (live ? secondClock.now : span.end) - span.start;
    return live || ms >= 1000 ? elapsed(ms) : '';
  });

  // Built on the first open, then folded both ways like a single call's body.
  let built = $state(false);
  $effect(() => {
    if (open) built = true;
  });
</script>


{#snippet step(part: ActivityPart, index: number, nested = false)}
  {#if part.type === 'permission'}
    {@render ask(part)}
  {:else if part.type === 'thinking'}
    <ThinkingPart text={part.text} live={isLive(index)} startedAt={part.startedAt ?? null} finishedAt={part.finishedAt ?? null} {store} {threadId} />
  {:else}
    <ToolCard
      name={part.name}
      input={part.input}
      inputText={part.inputText}
      output={part.output}
      outputDeferred={part.outputDeferred ?? false}
      inputDeferred={part.inputDeferred ?? false}
      documentsDeferred={part.documentsDeferred ?? false}
      loadOutput={loadOutput ? () => loadOutput!(part.toolId) : undefined}
      status={part.status}
      exitCode={part.exitCode}
      documents={part.documents ?? []}
      startedAt={part.startedAt ?? null}
      finishedAt={part.finishedAt ?? null}
      background={isBackground(part.toolId)}
      permission={asked.get(index)?.decision ?? null}
      {nested}
      {store}
      {threadId}
    />
  {/if}
{/snippet}

{#snippet ask(part: PermissionStep)}
  <PermissionCard
    toolName={part.toolName}
    decision={part.decision}
    request={permissionRequest(part.requestId)}
    answer={(decision) => answerPermission(part.requestId, decision)}
  />
{/snippet}

{#if steps.length === 1 && steps[0]}
  {@render step(steps[0].part, steps[0].index)}
{:else if steps.length > 1}
  <div class="group" data-testid="tool-group" data-count={steps.length} data-live={live}>
    <button
      type="button"
      class="ghost head"
      data-testid="tool-group-toggle"
      aria-expanded={open}
      title={open ? strings.chat.toolRunHide : strings.chat.toolRunShow}
      aria-label={said || issues ? [label, said, issues ? issueLabel : null].filter(Boolean).join(', ') : undefined}
      onclick={() => (open = !open)}
    >
      <span class="glyph"><Glyph size={15} strokeWidth={1.75} /></span>
      <span class="label ui-label" class:shimmer={live} data-testid="tool-group-label" title={label}>{label}</span>
      {#if took}<span class="took ui-label" data-testid="tool-group-elapsed">{took}</span>{/if}
      {#if busy}
        <span class="pulse" aria-hidden="true"></span>
      {/if}
      {#if running}
        <span class="spinner" aria-hidden="true"></span>
      {/if}
      {#if verdict}
        <span class="verdict" class:denied={verdict === 'deny'} data-testid="tool-group-permission" data-decision={verdict} title={said} aria-label={said}>
          {#if verdict === 'allow'}<ShieldCheck size={13} strokeWidth={2} />{:else}<ShieldX size={13} strokeWidth={2} />{/if}
        </span>
      {/if}
      {#if issues}
        <span class="status" data-testid="tool-group-issues" title={issueLabel}><TriangleAlert size={12} strokeWidth={1.75} /><span class="ui-label">{issues}</span></span>
      {/if}
      <span class="fold-caret" class:open aria-hidden="true"><ChevronRight size={12} /></span>
    </button>
    <div class="disclosure-fold" class:open inert={!open}>
      <div>
        {#if built}
          <div class="calls">
            {#each steps as { part, index } (part.type === 'tool' ? part.toolId : `thinking-${index}`)}
              {@render step(part, index, true)}
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
{#each waiting as part (part.requestId)}
  <div class="waiting" class:after={steps.length > 0}>{@render ask(part)}</div>
{/each}

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

  .status {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    flex: none;
    color: var(--color-subtle);
    font-size: var(--text-xs);
  }

  .verdict {
    display: inline-flex;
    flex: none;
    color: var(--color-success);
  }

  .verdict.denied { color: var(--color-danger); }

  .waiting.after { margin-top: var(--chat-part-gap); }

  .label {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }

  /* A light passing over the words while a call runs. It moves in 33 steps a
     sweep, one every fourth tick of the loops' 60 Hz grid (app.css): the text
     clipped gradient repaints on each step, not on every frame. */
  .label.shimmer {
    background: linear-gradient(90deg, var(--color-muted-foreground) 35%, var(--color-foreground) 50%, var(--color-muted-foreground) 65%) 0 0 / 300% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: shimmer 2.2s steps(33) infinite var(--loops);
  }

  @keyframes shimmer {
    from { background-position: 100% 0; }
    to { background-position: 0 0; }
  }

  .took {
    flex: none;
    color: var(--color-subtle);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .pulse {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-accent);
    animation: pulse 1.6s var(--loop-ease-out-quint-48) infinite var(--loops);
  }

  .spinner {
    flex: none;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 1.5px solid var(--color-edge);
    border-top-color: var(--color-live);
    animation: spin 0.9s steps(54) infinite var(--loops);
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
