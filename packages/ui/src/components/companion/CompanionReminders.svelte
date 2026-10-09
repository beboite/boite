<!--
  Settings, Companion: the reminders the companion will ring
  (`lib/companion/memory.ts`). They live on this computer; the companion's
  window adds to them when an agent's reply sets one. What the agents
  remember about the user is each agent's memory, in the Agents page.
-->
<script lang="ts">
  import { X } from '@lucide/svelte';
  import { strings } from '../../lib/strings';
  import { formatLocale } from '../../lib/i18n.svelte';
  import { readReminders, removeReminder, subscribeCompanionData, type Reminder } from '../../lib/companion/memory';

  const copy = $derived(strings.companion.settings);

  let reminders = $state.raw<Reminder[]>(readReminders());

  $effect(() => subscribeCompanionData(() => (reminders = readReminders())));

  const when = $derived(new Intl.DateTimeFormat(formatLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
</script>

<section class="card" data-testid="companion-reminders">
  <h2>{copy.reminders}</h2>
  {#if reminders.length === 0}
    <p class="hint">{copy.remindersEmpty}</p>
  {:else}
    <ul class="list">
      {#each reminders as reminder (reminder.id)}
        <li>
          <span class="item"><span class="time">{when.format(reminder.at)}</span>{reminder.text}</span>
          <button class="ghost icon" aria-label={copy.removeReminder} title={copy.removeReminder} onclick={() => removeReminder(reminder.id)}><X size={14} /></button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: var(--row);
    border-bottom: 1px solid var(--color-border);
  }
  .list li:last-child {
    border-bottom: none;
  }
  .item {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .time {
    margin-inline-end: 8px;
    color: var(--color-muted-foreground);
    font-variant-numeric: tabular-nums;
  }
  .list .icon {
    flex: none;
  }
</style>
