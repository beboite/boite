<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fill, strings } from '../../lib/strings';
  import { ago, exactTime } from '../../lib/format';
  import type { Machine } from '../../lib/workspace.svelte';
  import MachineIcon from '../MachineIcon.svelte';

  /**
   * A conversation's picture, name, unread count and last message preview.
   */
  let { title, open = false, unread = 0, away = false, at, now, detail = '', machine, testid, onclick, picture, aside }: {
    title: string;
    open?: boolean;
    unread?: number;
    /** Its machine is not connected: the machine icon shows its connection state. */
    away?: boolean;
    /** The row's last activity, shown when no messages are unread. */
    at: number;
    now: number;
    detail?: string;
    /** The machine it runs on, drawn before the picture once there are two, as on a thread's row. */
    machine?: Machine;
    testid?: string;
    onclick: () => void;
    picture: Snippet;
    /** Replaces the state on the right, for a row that is not an agent's. */
    aside?: Snippet;
  } = $props();

  const missed = $derived(fill(unread === 1 ? strings.agents.missedOne : strings.agents.missedMany, { count: String(unread) }));
</script>

<div class="agent-row" class:open class:unread={unread > 0} class:meta={!!detail} class:on-machine={!!machine} data-machine-id={machine?.id}>
  <button type="button" class="ghost row" aria-current={open ? 'page' : undefined} title={title} {onclick} data-testid={testid}>
    <span class="headline">
      {#if machine}
        <span class="machine" class:offline={away} title={`${machine.label} · ${strings.connection[machine.store.connection]}`} aria-label={machine.label}><MachineIcon icon={machine.icon} os={machine.store.core?.os} /></span>
      {/if}
      <span class="picture">{@render picture()}</span>
      <span class="title">{title}</span>
      {#if aside}{@render aside()}
      {:else}
        {#if unread > 0}<span class="unread-count" title={missed} aria-label={missed} data-testid="agent-unread-count">{unread}</span>
        {:else if at > 0}<time class="when" datetime={new Date(at).toISOString()} title={exactTime(at)}>{ago(at, now)}</time>{/if}
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
  .machine { display: inline-flex; align-items: center; flex: none; color: var(--color-muted-foreground); }
  .machine.offline { color: var(--color-danger); }
  .title { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-foreground); font-weight: 400; }
  .unread .title { font-weight: 600; }
  .unread-count { flex: none; min-width: 18px; height: 18px; padding: 0 5px; display: grid; place-items: center; border-radius: 999px; background: var(--color-accent); color: var(--color-accent-ink); font-size: var(--text-xs); font-weight: 600; }
  .when { flex: none; color: var(--color-subtle); font-size: var(--text-xs); }
  .detail { padding-left: 30px; text-align: left; font-size: var(--text-xs); color: var(--color-muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The machine's icon and its gap before the picture: the line still starts under the name. */
  .on-machine .detail { padding-left: 51px; }
</style>
