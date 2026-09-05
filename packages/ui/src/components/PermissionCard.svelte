<script lang="ts">
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
    <strong>{strings.chat.permissionHeading}</strong>
    <span class="muted">{strings.chat.permissionBody}</span>
    <span class="mono tool">{toolName}</span>
  </div>

  {#if request?.description}
    <p class="muted">{request.description}</p>
  {/if}
  {#if request}
    <pre class="mono" data-testid="permission-input">{json(request.input)}</pre>
  {/if}

  {#if decision === null}
    <div class="actions">
      <button class="primary" data-testid="permission-allow" onclick={() => answer('allow')}>
        {strings.chat.allow}
      </button>
      <button class="danger" data-testid="permission-deny" onclick={() => answer('deny')}>
        {strings.chat.deny}
      </button>
    </div>
  {:else}
    <div class="verdict" class:denied={decision === 'deny'} data-testid="permission-verdict">
      {decision === 'allow' ? strings.chat.allowed : strings.chat.denied}
    </div>
  {/if}
</div>

<style>
  .permission {
    border: 1px solid var(--warn);
    border-radius: var(--radius);
    background: var(--panel);
    padding: 6px 8px;
    margin: 4px 0;
  }

  .permission.resolved {
    border-color: var(--border);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }

  .tool {
    color: var(--accent);
  }

  p {
    margin: 4px 0 0;
  }

  pre {
    margin: 4px 0 0;
    padding: 4px 6px;
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-height: 160px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }

  .verdict {
    margin-top: 6px;
    font-size: 11px;
    color: var(--ok);
  }

  .verdict.denied {
    color: var(--danger);
  }
</style>
