<script lang="ts">
  import type { ToolStatus } from '@boite/contracts';
  import { json } from '../lib/format';
  import { strings } from '../lib/strings';

  let {
    name,
    input,
    output,
    status
  }: { name: string; input: unknown; output: string | null; status: ToolStatus } = $props();

  let open = $state(false);
</script>

<div class="tool">
  <button class="quiet head" aria-expanded={open} onclick={() => (open = !open)}>
    <span class="caret" class:open>&rsaquo;</span>
    <span class="mono name">{name}</span>
    <span class="status" class:done={status === 'done'} class:running={status === 'running'} class:error={status === 'error'} class:denied={status === 'denied'}>
      {strings.chat.toolStatus[status]}
    </span>
  </button>

  {#if open}
    <div class="body">
      <div class="label">{strings.chat.toolInput}</div>
      <pre class="mono">{json(input)}</pre>
      <div class="label">{strings.chat.toolOutput}</div>
      <pre class="mono">{output ?? strings.chat.noOutput}</pre>
    </div>
  {/if}
</div>

<style>
  .tool {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel-alt);
    margin: 4px 0;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 2px 6px;
  }

  .caret {
    color: var(--muted);
    transition: transform 80ms linear;
  }

  .caret.open {
    transform: rotate(90deg);
  }

  .name {
    flex: 1;
    text-align: left;
  }

  .status {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--muted);
  }

  .status.done {
    color: var(--ok);
  }

  .status.running {
    color: var(--warn);
  }

  .status.error,
  .status.denied {
    color: var(--danger);
  }

  .body {
    border-top: 1px solid var(--border);
    padding: 6px;
  }

  .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin-bottom: 2px;
  }

  pre {
    margin: 0 0 6px;
    padding: 4px 6px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-height: 220px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  pre:last-child {
    margin-bottom: 0;
  }
</style>
