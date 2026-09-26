<script lang="ts">
  import type { Account, ProviderSummary } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import type { Choice } from '../lib/store.svelte';

  /**
   * The accounts of the provider the model picker shows, as a segmented control
   * under its name. Only drawn when there is more than one to pick from.
   */
  let {
    shown,
    seats,
    shownAccountId,
    choice,
    locked,
    onpick
  }: {
    shown: ProviderSummary | null;
    seats: Account[];
    shownAccountId: string | null;
    choice: Choice | null;
    locked: boolean;
    /** A seat that can be taken and is not the choice already. */
    onpick: (seat: Account) => void;
  } = $props();

  /** What keeps an account chip from being clicked, or null. */
  function seatReason(seat: Account): string | null {
    if (!shown) return null;
    const hints: string[] = [];
    if (!shown.available) hints.push(strings.composer.unavailable);
    if (seat.status === 'unauthenticated') hints.push(strings.accounts.status.unauthenticated);
    return hints.join(', ') || null;
  }

  function seatHeld(seat: Account): boolean {
    return locked && !(choice?.providerId === shown?.id && choice?.accountId === seat.id);
  }

  function seatTitle(seat: Account): string {
    if (seatHeld(seat)) return strings.composer.lockedHint;
    const reason = seatReason(seat);
    return reason === null ? (seat.identity ?? seat.label) : `${seat.label}, ${reason}`;
  }

  function pickSeat(seat: Account) {
    if (!shown || seatHeld(seat) || !shown.available) return;
    if (choice?.providerId === shown.id && choice.accountId === seat.id) return;
    onpick(seat);
  }
</script>

{#if seats.length > 1}
  <div class="seats" role="group" aria-label={strings.accounts.heading}>
    {#each seats as seat (seat.id)}
      <button
        type="button"
        class="seat"
        disabled={seatHeld(seat) || !(shown?.available ?? false)}
        data-seat
        data-instance="{shown?.id}::{seat.id}"
        aria-pressed={seat.id === shownAccountId}
        title={seatTitle(seat)}
        onclick={() => pickSeat(seat)}
      >
        {seat.label}
      </button>
    {/each}
  </div>
{/if}

<style>
  .seats {
    display: flex;
    gap: 2px;
    align-self: flex-start;
    flex-shrink: 0;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 2px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    min-width: 0;
  }

  .seat {
    height: var(--control-sm);
    min-height: var(--control-sm);
    flex-shrink: 0;
    max-width: 150px;
    padding: 0 7px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
    transition:
      background var(--dur-2) var(--ease-out-quint),
      color var(--dur-2) var(--ease-out-quint);
  }

  .seat:hover:not(:disabled),
  .seat:focus-visible {
    background: var(--color-surface-3);
    color: var(--color-foreground);
    outline: none;
  }

  .seat[aria-pressed='true'] {
    background: var(--color-surface-3);
    color: var(--color-foreground);
    box-shadow: var(--shadow-e1);
  }

  @media (max-width: 720px) {
    .seat { height: var(--touch-target); min-height: var(--touch-target); }
  }
</style>
