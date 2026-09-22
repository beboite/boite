<script lang="ts">
  import { ChevronRight, ShieldCheck, ShieldQuestion, ShieldX } from '@lucide/svelte';
  import type { PermissionRequest } from '@boite/contracts';
  import { json } from '../lib/format';
  import { strings } from '../lib/strings';
  import { describeTool, permissionSentence } from '../lib/tool-summary';
  import DiffView from './DiffView.svelte';

  let {
    toolName,
    decision,
    request,
    answer
  }: {
    toolName: string;
    decision: 'allow' | 'deny' | null;
    request: PermissionRequest | null;
    answer: (decision: 'allow' | 'deny') => void;
  } = $props();

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
    <span class="sentence" data-testid="permission-sentence" title={described.subject || toolName}>{sentence}</span>
    {#if decision !== null}
      <span class="verdict" class:denied={decision === 'deny'} data-testid="permission-verdict">
        {decision === 'allow' ? strings.chat.allowed : strings.chat.denied}
      </span>
    {/if}
  </div>

  {#if decision === null}
    {#if subjectBlock}
      <pre class="mono subject" data-testid="permission-subject">{subjectBlock}</pre>
    {/if}
    {#if described.change}
      <DiffView path={described.change.path} oldText={described.change.oldText} newText={described.change.newText} />
    {/if}
    {#if request?.description && request.description !== subjectBlock}
      <p class="muted description">{request.description}</p>
    {/if}
  {/if}
  {#if request}
    <details class="technical">
      <summary><ChevronRight size={12} strokeWidth={2} />{strings.chat.permissionTechnical}</summary>
      <p class="tool mono">{toolName}</p>
      <pre class="mono" data-testid="permission-input">{json(request.input)}</pre>
    </details>
  {/if}

  {#if decision === null}
    <div class="actions">
      <button type="button" class="primary" data-testid="permission-allow" onclick={() => answer('allow')}>
        {strings.chat.allow}
      </button>
      <button type="button" class="danger" data-testid="permission-deny" onclick={() => answer('deny')}>
        {strings.chat.deny}
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

  /* Answered, it stops outranking the tool cards around it: one muted line. */
  .permission.resolved {
    border-color: var(--color-border);
    background: transparent;
    box-shadow: none;
    padding: 4px 10px;
    gap: 2px;
    color: var(--color-muted-foreground);
  }

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

  .technical summary {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    color: var(--color-subtle);
    cursor: pointer;
    list-style: none;
  }

  .technical summary::-webkit-details-marker { display: none; }
  .technical summary :global(svg) { transition: transform var(--dur-2) var(--ease-out-quint); }
  .technical[open] summary :global(svg) { transform: rotate(90deg); }
  .technical .tool { margin: 6px 0 4px; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .resolved .technical { display: none; }

  .actions {
    display: flex;
    gap: 6px;
  }
</style>
