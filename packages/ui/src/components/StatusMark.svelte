<script lang="ts">
  import type { ThreadStatus } from '@boite/contracts';
  import { strings } from '../lib/strings';

  let {
    status,
    unread = false,
    testid
  }: { status: ThreadStatus; unread?: boolean; testid?: string } = $props();

  let label = $derived(unread && status === 'idle' ? strings.sidebar.unread : strings.threadStatus[status]);
</script>

<span
  class="mark {status}"
  class:unread={unread && status === 'idle'}
  title={label}
  aria-label={label}
  data-testid={testid}
  data-status={status}
></span>

<style>
  .mark {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
    background: transparent;
    border: 1.5px solid var(--color-edge);
    transition: background var(--dur-2) var(--ease-out-quint);
  }

  .mark.unread {
    background: var(--color-foreground);
    border-color: var(--color-foreground);
  }

  .mark.running {
    background: var(--color-live);
    border-color: var(--color-live);
    animation: pulse 1.6s ease-in-out infinite;
  }

  .mark.waiting {
    background: transparent;
    border-color: var(--color-live);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-live) 35%, transparent);
  }

  .mark.queued {
    border-color: var(--color-muted-foreground);
    border-style: dashed;
  }

  .mark.error {
    background: var(--color-danger);
    border-color: var(--color-danger);
  }

  /* An endless loop stops under reduced motion; the static mark keeps its colour. */
  @media (prefers-reduced-motion: reduce) { .mark.running { animation: none; } }
  :global(html[data-motion='reduced']) .mark.running { animation: none; }
</style>
