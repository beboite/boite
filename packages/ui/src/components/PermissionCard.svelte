<script lang="ts">
  import { ShieldQuestion } from '@lucide/svelte';
  import type { PermissionRequest } from '@boite/contracts';
  import { json } from '../lib/format';
  import { strings } from '../lib/strings';

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
</script>

<div
  class="permission"
  class:resolved={decision !== null}
  data-testid="permission-card"
  data-decision={decision ?? 'pending'}
>
  <div class="head">
    <span class="glyph"><ShieldQuestion size={15} strokeWidth={1.75} /></span>
    <span class="muted">{strings.chat.permissionHeading}</span>
    <span class="tool">{toolName}</span>
    {#if decision !== null}
      <span class="verdict" class:denied={decision === 'deny'} data-testid="permission-verdict">
        {decision === 'allow' ? strings.chat.allowed : strings.chat.denied}
      </span>
    {/if}
  </div>

  {#if request?.description}
    <p class="muted description">{request.description}</p>
  {/if}
  {#if request}
    <pre class="mono" data-testid="permission-input">{json(request.input)}</pre>
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
    border: 1px solid var(--color-border);
    border-left: 3px solid var(--color-live);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .permission.resolved {
    border-left-color: var(--color-edge);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .glyph {
    display: inline-flex;
    color: var(--color-live);
  }

  .resolved .glyph {
    color: var(--color-subtle);
  }

  .tool {
    font-weight: 600;
  }

  .verdict {
    margin-left: auto;
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-success);
  }

  .verdict.denied {
    color: var(--color-danger);
  }

  .description {
    font-size: var(--text-sm);
  }

  pre {
    margin: 0;
    padding: 8px 10px;
    background: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    max-height: 200px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .actions {
    display: flex;
    gap: 6px;
    margin-top: 2px;
  }
</style>
