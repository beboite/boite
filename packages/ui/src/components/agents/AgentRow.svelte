<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import { Clock3 } from '@lucide/svelte';
  import { fill, strings } from '../../lib/strings';
  import { ago, clockTime, elapsed, exactTime } from '../../lib/format';
  import { secondClock } from '../../lib/clock.svelte';
  import type { Machine } from '../../lib/workspace.svelte';
  import MachineIcon from '../MachineIcon.svelte';

  /**
   * An agent in the list, the way a messenger draws a chat: its robot in its
   * ring beside two lines, its name over what it does this second while it
   * works, what it waits on, else the last thing it said. The picture spans
   * both lines, so the row holds no gap under it. On the right the time it
   * has worked, the missed answers or the time of the last one, and the next
   * wake as a small clock while it rests.
   */
  let { title, open = false, unread = 0, away = false, at, now, detail = '', tone = 'idle', icon, since = null, wake = null, machine, testid, onclick, picture, aside }: {
    title: string;
    open?: boolean;
    unread?: number;
    /** Its machine is not connected: the machine icon shows its connection state. */
    away?: boolean;
    /** The row's last activity, shown when nothing is missed. */
    at: number;
    now: number;
    detail?: string;
    /** How the line under the name reads: the accent while it works, the waiting colour while it waits, danger after a failure, faded asleep. */
    tone?: 'idle' | 'working' | 'waiting' | 'error' | 'asleep';
    /** The glyph before that line: the kind of step it is on, what it waits on, a failure. */
    icon?: Component<{ size?: number; strokeWidth?: number }>;
    /** When its work started, while it works: the right side counts from it. */
    since?: number | null;
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
  /** Counting time reads the second clock, only while it works: the list's clock ticks far slower. */
  const spent = $derived(tone === 'working' && since !== null ? elapsed(Math.max(secondClock.now, now) - since) : null);
</script>

<div class="agent-row" class:open class:unread={unread > 0} class:on-machine={!!machine} data-machine-id={machine?.id} data-tone={tone}>
  <button type="button" class="ghost row" aria-current={open ? 'page' : undefined} title={title} {onclick} data-testid={testid}>
    {#if machine}
      <span class="machine" class:offline={away} title={`${machine.label} · ${strings.connection[machine.store.connection]}`} aria-label={machine.label}><MachineIcon icon={machine.icon} os={machine.store.core?.os} /></span>
    {/if}
    <span class="picture">{@render picture()}</span>
    <span class="text">
      <span class="headline">
        <span class="title">{title}</span>
        {#if aside}{@render aside()}
        {:else if spent !== null}<span class="spent" data-testid="agent-row-spent">{spent}</span>
        {:else if unread > 0}<span class="unread-count" role="img" title={missed} aria-label={missed} data-testid="agent-unread-count">{unread}</span>
        {:else if at > 0}<time class="when" datetime={new Date(at).toISOString()} title={exactTime(at)}>{ago(at, now)}</time>{/if}
      </span>
      {#if detail || wake}
        <span class="detail-line">
          {#if icon}{@const Glyph = icon}<span class="glyph" data-testid="agent-row-glyph"><Glyph size={13} strokeWidth={2} /></span>{/if}
          <span class="detail" data-testid="agent-row-detail">{detail}</span>
          {#if wake}<span class="wake" title={fill(strings.agents.nextWake, { name: wake.label, when: exactTime(wake.at) })} data-testid="agent-row-wake"><Clock3 size={11} strokeWidth={2} />{wakeText}</span>{/if}
        </span>
      {/if}
    </span>
  </button>
</div>

<style>
  .agent-row { position: relative; border-radius: var(--radius-md); transition: background var(--dur-2) var(--ease-out-quint), box-shadow var(--dur-2) var(--ease-out-quint); }
  .agent-row:hover { background: var(--color-hover); }
  /* The open row lifts: the active fill and the card shadow. */
  .agent-row.open { background: var(--color-active); box-shadow: var(--shadow-e1); }
  /* The picture spans both lines, the messenger way: one row tall, nothing under it. */
  .row { display: flex; align-items: center; width: 100%; height: auto; min-height: var(--row); padding: 7px 10px 7px 8px; gap: 10px; background: transparent; text-align: left; }
  .row:hover:not(:disabled) { background: transparent; }
  .row:active:not(:disabled) { transform: none; }
  .picture { display: inline-flex; flex: none; margin: 3px; }
  .machine { display: inline-flex; align-items: center; flex: none; margin-right: -4px; color: var(--color-muted-foreground); }
  .machine.offline { color: var(--color-danger); }
  .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .headline { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-foreground); font-weight: 500; }
  .unread .title { font-weight: 600; }
  .unread-count { flex: none; min-width: 18px; height: 18px; padding: 0 5px; display: grid; place-items: center; border-radius: 999px; background: var(--color-accent); color: var(--color-accent-ink); font-size: var(--text-xs); font-weight: 600; }
  .when { flex: none; color: var(--color-subtle); font-size: var(--text-xs); }
  .spent { flex: none; color: var(--color-accent); font-size: var(--text-xs); font-weight: 600; font-variant-numeric: tabular-nums; }
  .detail-line { display: flex; align-items: center; gap: 5px; min-width: 0; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .glyph { display: inline-flex; flex: none; }
  .detail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* An answer not read yet reads like an unread message, in the foreground; a state's own colour wins over it. */
  .unread[data-tone='idle'] .detail { color: var(--color-foreground); font-weight: 500; }
  /* Hue says status: work in the accent, its glyph breathing; the user's turn in the live colour; a failure in danger. */
  [data-tone='working'] .detail-line { color: var(--color-accent); }
  [data-tone='working'] .detail { font-weight: 500; }
  [data-tone='working'] .glyph { animation: pulse 1.6s var(--loop-ease-in-out-48) infinite var(--loops); }
  [data-tone='waiting'] .detail-line { color: var(--color-live); }
  [data-tone='waiting'] .detail { font-weight: 500; }
  [data-tone='error'] .detail-line { color: var(--color-danger); }
  [data-tone='asleep'] .detail-line { color: var(--color-subtle); }
  [data-tone='asleep'] .title { color: var(--color-muted-foreground); }
  .wake { flex: none; display: inline-flex; align-items: center; gap: 3px; color: var(--color-subtle); font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) { [data-tone='working'] .glyph { animation: none; } }
  :global(html[data-motion='reduced']) [data-tone='working'] .glyph { animation: none; }
</style>
