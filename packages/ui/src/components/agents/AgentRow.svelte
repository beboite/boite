<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Clock3 } from '@lucide/svelte';
  import { fill, strings } from '../../lib/strings';
  import { ago, clockTime, exactTime } from '../../lib/format';
  import type { Machine } from '../../lib/workspace.svelte';
  import MachineIcon from '../MachineIcon.svelte';

  /**
   * An agent in the list, the way a messenger draws a chat: its robot in its
   * ring, its name, and under it what it does this second while it works, what it waits
   * on, else the last thing it said. On the right the missed answers or the
   * time of the last one, and the next wake as a small clock while it rests.
   */
  let { title, open = false, unread = 0, away = false, at, now, detail = '', tone = 'idle', wake = null, machine, testid, onclick, picture, aside }: {
    title: string;
    open?: boolean;
    unread?: number;
    /** Its machine is not connected: the machine icon shows its connection state. */
    away?: boolean;
    /** The row's last activity, shown when nothing is missed. */
    at: number;
    now: number;
    detail?: string;
    /** How the line under the name reads: live while it works, the waiting colour while it waits. */
    tone?: 'idle' | 'working' | 'waiting' | 'error';
    /** When it next wakes on its own, while it rests. */
    wake?: { at: number; label: string } | null;
    /** The machine it runs on, drawn before the picture once there are two, as on a thread's row. */
    machine?: Machine;
    testid?: string;
    onclick: () => void;
    picture: Snippet;
    /** Replaces the state on the right, for a row that is not an agent's. */
    aside?: Snippet;
  } = $props();

  const missed = $derived(fill(unread === 1 ? strings.agents.missedOne : strings.agents.missedMany, { count: String(unread) }));
  /** The wake's hour today, its day and hour further out. */
  const wakeText = $derived(wake ? clockTime(wake.at, now) : '');
</script>

<div class="agent-row" class:open class:unread={unread > 0} class:meta={!!detail} class:on-machine={!!machine} data-machine-id={machine?.id} data-tone={tone}>
  <button type="button" class="ghost row" aria-current={open ? 'page' : undefined} title={title} {onclick} data-testid={testid}>
    <span class="headline">
      {#if machine}
        <span class="machine" class:offline={away} title={`${machine.label} · ${strings.connection[machine.store.connection]}`} aria-label={machine.label}><MachineIcon icon={machine.icon} os={machine.store.core?.os} /></span>
      {/if}
      <span class="picture">{@render picture()}</span>
      <span class="title">{title}</span>
      {#if aside}{@render aside()}
      {:else}
        {#if unread > 0}<span class="unread-count" role="img" title={missed} aria-label={missed} data-testid="agent-unread-count">{unread}</span>
        {:else if at > 0}<time class="when" datetime={new Date(at).toISOString()} title={exactTime(at)}>{ago(at, now)}</time>{/if}
      {/if}
    </span>
    {#if detail || wake}
      <span class="detail-line">
        <span class="detail" data-testid="agent-row-detail">{detail}</span>
        {#if wake}<span class="wake" title={fill(strings.agents.nextWake, { name: wake.label, when: exactTime(wake.at) })} data-testid="agent-row-wake"><Clock3 size={11} strokeWidth={2} />{wakeText}</span>{/if}
      </span>
    {/if}
  </button>
</div>

<style>
  .agent-row { position: relative; border-radius: var(--radius-md); transition: background var(--dur-2) var(--ease-out-quint), box-shadow var(--dur-2) var(--ease-out-quint); }
  .agent-row:hover { background: var(--color-hover); }
  /* The open row lifts: the active fill and the card shadow. */
  .agent-row.open { background: var(--color-active); box-shadow: var(--shadow-e1); }
  .row { display: flex; flex-direction: column; align-items: stretch; width: 100%; height: auto; min-height: var(--row); padding: 8px 10px; gap: 3px; background: transparent; }
  .row:hover:not(:disabled) { background: transparent; }
  .row:active:not(:disabled) { transform: none; }
  .headline { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .picture { display: inline-flex; flex: none; margin: 2px; }
  .machine { display: inline-flex; align-items: center; flex: none; color: var(--color-muted-foreground); }
  .machine.offline { color: var(--color-danger); }
  .title { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-foreground); font-weight: 500; }
  .unread .title { font-weight: 600; }
  .unread-count { flex: none; min-width: 18px; height: 18px; padding: 0 5px; display: grid; place-items: center; border-radius: 999px; background: var(--color-accent); color: var(--color-accent-ink); font-size: var(--text-xs); font-weight: 600; }
  .when { flex: none; color: var(--color-subtle); font-size: var(--text-xs); }
  /* Under the name: the picture's width and its gap to the left, so the line starts under the name. */
  .detail-line { display: flex; align-items: center; gap: 6px; min-width: 0; padding-left: 44px; }
  .on-machine .detail-line { padding-left: 67px; }
  .detail { flex: 1; min-width: 0; text-align: left; font-size: var(--text-xs); color: var(--color-muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Hue says status only: the waiting line in the live colour, a failure in danger; work reads in the foreground, its ring breathing beside it. */
  [data-tone='working'] .detail { color: var(--color-foreground); }
  [data-tone='waiting'] .detail { color: var(--color-live); }
  [data-tone='error'] .detail { color: var(--color-danger); }
  .wake { flex: none; display: inline-flex; align-items: center; gap: 3px; font-size: var(--text-xs); color: var(--color-subtle); font-variant-numeric: tabular-nums; }
</style>
