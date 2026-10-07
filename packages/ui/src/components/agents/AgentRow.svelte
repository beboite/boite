<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ThreadSummary } from '@boite/contracts';
  import { fill, strings } from '../../lib/strings';
  import ThreadState from '../ThreadState.svelte';

  /**
   * One row of the agents list, cut like a thread's row in the thread list:
   * the picture where the provider's logo goes, the name, the state on the
   * right (the same words and colours as a thread: working with its time,
   * needs you, or when it last moved), and one muted line under it.
   */
  let { title, open = false, unread = 0, live = null, waiting = false, at, now, detail = '', testid, onclick, picture, aside }: {
    title: string;
    open?: boolean;
    unread?: number;
    /** The thread its agent works in now, whose state the row reads. */
    live?: ThreadSummary | null;
    /** Something waits on the user here even with no turn running: a decision, a result to review. */
    waiting?: boolean;
    /** The row's last activity, read when nothing runs. */
    at: number;
    now: number;
    detail?: string;
    testid?: string;
    onclick: () => void;
    picture: Snippet;
    /** Replaces the state on the right, for a row that is not an agent's. */
    aside?: Snippet;
  } = $props();

  const shown = $derived({
    status: waiting ? ('waiting' as const) : (live?.status ?? ('idle' as const)),
    unread: false,
    runningSince: live?.runningSince ?? null,
    backgroundWork: null,
    lastUserMessageAt: at,
    createdAt: at
  });
</script>

<div class="agent-row" class:open class:unread={unread > 0} class:meta={!!detail}>
  <button type="button" class="ghost row" aria-current={open ? 'page' : undefined} title={title} {onclick} data-testid={testid}>
    <span class="headline">
      <span class="picture">{@render picture()}</span>
      <span class="title">{title}</span>
      {#if aside}{@render aside()}
      {:else}
        {#if unread > 0 && !waiting && !live}<span class="unread-count" role="img" aria-label={fill(strings.agents.unread, { count: String(unread) })}>{unread}</span>{/if}
        <ThreadState thread={shown} {now} />
      {/if}
    </span>
    {#if detail}<span class="detail">{detail}</span>{/if}
  </button>
</div>

<style>
  .agent-row { position: relative; border-radius: var(--radius-md); transition: background var(--dur-2) var(--ease-out-quint); }
  .agent-row:hover { background: var(--color-hover); }
  .agent-row.open { background: var(--color-active); }
  .row { display: flex; flex-direction: column; align-items: stretch; width: 100%; height: auto; min-height: var(--row); padding: 8px 10px; gap: 4px; background: transparent; }
  .row:hover:not(:disabled) { background: transparent; }
  .row:active:not(:disabled) { transform: none; }
  .headline { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .picture { display: inline-flex; flex: none; }
  .title { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-foreground); font-weight: 400; }
  .unread .title { font-weight: 600; }
  .unread-count { flex: none; min-width: 18px; height: 18px; padding: 0 5px; display: grid; place-items: center; border-radius: 999px; background: var(--color-accent); color: var(--color-accent-ink); font-size: var(--text-xs); font-weight: 600; }
  .detail { padding-left: 30px; text-align: left; font-size: var(--text-xs); color: var(--color-muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
