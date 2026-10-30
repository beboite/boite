<script lang="ts">
  import { ShieldCheck, ShieldQuestion, ShieldX } from '@lucide/svelte';
  import type { PermissionRequest } from '@boite/contracts';
  import { json } from '../lib/format';
  import { strings } from '../lib/strings';
  import { describeTool, permissionSentence } from '../lib/tool-summary';
  import Deferred, { parts } from './Deferred.svelte';

  let {
    toolName,
    decision,
    request,
    answer
  }: {
    toolName: string;
    decision: 'allow' | 'deny' | null;
    request: PermissionRequest | null;
    /** False, or a promise of false, gives the buttons back: the answer did not reach the core. */
    answer: (decision: 'allow' | 'deny') => unknown;
  } = $props();

  /**
   * The decision out to the core: both buttons stay down until it lands, so a
   * second tap sends nothing and the card shows its answer was taken.
   */
  let sending = $state<'allow' | 'deny' | null>(null);

  async function choose(choice: 'allow' | 'deny'): Promise<void> {
    if (sending !== null || decision !== null || (choice === 'allow' && previewMissing)) return;
    sending = choice;
    if ((await answer(choice)) === false) sending = null;
  }

  /**
   * One sentence says what the agent wants to do; under it, the thing itself
   * (the command, the change as a diff, the address) and the agent's reason.
   * The raw input stays one click away for whoever wants it. The state reads
   * from the shield: a question while it waits, a check or a cross once answered.
   */
  let described = $derived(describeTool(toolName, request?.input ?? null));
  let sentence = $derived(permissionSentence(toolName, request?.input ?? null));
  let subjectBlock = $derived(
    described.change === null && (described.family === 'command' || described.family === 'fetch' || described.family === 'search' || described.family === 'web')
      ? described.subject
      : ''
  );
  // A change is approved on what it shows: Allow waits for the diff's chunk, which says
  // it is loading or offers a retry meanwhile (Deferred.svelte). Deny never waits.
  let previewMissing = $derived(described.change !== null && parts.DiffView.current === undefined);
</script>

<div
  class="permission"
  class:resolved={decision !== null}
  data-testid="permission-card"
  data-decision={decision ?? 'pending'}
  data-family={described.family}
>
  <div class="head">
    <span class="glyph" class:denied={decision === 'deny'} class:allowed={decision === 'allow'}>
      {#if decision === 'allow'}<ShieldCheck size={15} strokeWidth={1.75} />{:else if decision === 'deny'}<ShieldX size={15} strokeWidth={1.75} />{:else}<ShieldQuestion size={15} strokeWidth={1.75} />{/if}
    </span>
    <span class="sentence ui-label" data-testid="permission-sentence" title={described.subject || toolName}>{sentence}</span>
    {#if decision !== null}
      <span class="verdict ui-label" class:denied={decision === 'deny'} data-testid="permission-verdict">
        {decision === 'allow' ? strings.chat.allowed : strings.chat.denied}
      </span>
    {/if}
  </div>

  {#if decision === null}
    {#if subjectBlock}
      <pre class="mono subject" data-testid="permission-subject">{subjectBlock}</pre>
    {/if}
    {#if described.change}
      {@const change = described.change}
      <Deferred part={parts.DiffView}>{#snippet children(DiffView)}<DiffView path={change.path} oldText={change.oldText} newText={change.newText} doc={change} />{/snippet}</Deferred>
    {/if}
    {#if request?.description && request.description !== subjectBlock}
      <p class="muted description">{request.description}</p>
    {/if}
  {/if}
  {#if request}
    <details class="technical disclosure">
      <summary><span class="ui-label">{strings.chat.permissionTechnical}</span></summary>
      <p class="tool mono">{toolName}</p>
      <pre class="mono" data-testid="permission-input">{json(request.input)}</pre>
    </details>
  {/if}

  {#if decision === null}
    <div class="actions" aria-busy={sending !== null}>
      <button type="button" class="primary" data-testid="permission-allow" disabled={sending !== null || previewMissing} onclick={() => void choose('allow')}>
        <span class="ui-label">{strings.chat.allow}</span>
      </button>
      <button type="button" class="danger" data-testid="permission-deny" disabled={sending !== null} onclick={() => void choose('deny')}>
        <span class="ui-label">{strings.chat.deny}</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .permission {
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e1);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Answered with no call to carry it, it reads as one more line of the run:
     a call's geometry, no frame. A call that has one carries the shield instead. */
  .permission.resolved {
    border-color: transparent;
    background: transparent;
    box-shadow: none;
    padding: var(--activity-padding);
    min-height: var(--control);
    justify-content: center;
    gap: 2px;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }

  .resolved .head { gap: var(--activity-gap); }
  .resolved .glyph { width: var(--activity-glyph); justify-content: center; }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .glyph {
    display: inline-flex;
    flex: none;
    color: var(--color-live);
  }

  .glyph.allowed { color: var(--color-success); }
  .glyph.denied { color: var(--color-danger); }

  .sentence {
    min-width: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .resolved .sentence { font-weight: 500; }

  .verdict {
    margin-left: auto;
    flex: none;
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-success);
  }

  .verdict.denied { color: var(--color-danger); }

  .description { font-size: var(--text-sm); }

  pre {
    margin: 0;
    padding: 8px 10px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    max-height: 200px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .subject { color: var(--color-foreground); }

  /* The shared disclosure, at the size of the card's small print. */
  .technical summary { gap: 4px; min-height: 0; font-size: var(--text-xs); font-weight: 400; color: var(--color-subtle); }
  .technical summary::before { width: 12px; height: 12px; }
  .technical .tool { margin: 6px 0 4px; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .resolved .technical { display: none; }
  @media (max-width: 720px) {
    .technical summary { min-height: var(--touch-target); }
  }

  .actions {
    display: flex;
    gap: 6px;
  }
</style>
