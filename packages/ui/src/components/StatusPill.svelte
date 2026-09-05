<script lang="ts">
  import type { ThreadStatus } from '@boite/contracts';
  import { strings } from '../lib/strings';

  let { status, testid }: { status: ThreadStatus; testid?: string } = $props();
</script>

<span class="pill {status}" data-testid={testid} data-status={status}>
  {strings.threadStatus[status]}
</span>

<style>
  .pill {
    font-size: 10px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    padding: 0 5px;
    border-radius: 2px;
    border: 1px solid var(--border-strong);
    color: var(--muted);
    background: var(--panel-alt);
    white-space: nowrap;
  }

  .running {
    border-color: var(--ok);
    color: var(--ok);
    background: transparent;
  }

  .queued {
    border-color: var(--border-strong);
    color: var(--muted);
  }

  .waiting {
    border-color: var(--warn);
    color: var(--warn);
    background: transparent;
  }

  .error {
    border-color: var(--danger);
    color: var(--danger);
    background: transparent;
  }
</style>
