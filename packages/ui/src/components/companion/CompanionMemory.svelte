<!--
  Settings, Companion: what the companion remembers about the user and the
  reminders it will ring (`lib/companion/memory.ts`). Both live on this
  computer; the companion's window adds to them as the user talks to it.
  A change to the memory goes to the agent with the next request, in the same
  conversation (`lib/companion/priming.ts`).
-->
<script lang="ts">
  import { Plus, X } from '@lucide/svelte';
  import InfoTip from '../InfoTip.svelte';
  import { fill, strings } from '../../lib/strings';
  import { formatLocale } from '../../lib/i18n.svelte';
  import { clearMemory, forgetFact, readMemory, readReminders, remember, removeReminder, subscribeCompanionData, type MemoryFact, type Reminder } from '../../lib/companion/memory';

  const copy = $derived(strings.companion.settings);

  let facts = $state.raw<MemoryFact[]>(readMemory());
  let reminders = $state.raw<Reminder[]>(readReminders());
  let fact = $state('');
  let confirming = $state(false);

  $effect(() =>
    subscribeCompanionData(() => {
      facts = readMemory();
      reminders = readReminders();
    })
  );

  const when = $derived(new Intl.DateTimeFormat(formatLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));

  function add(event: SubmitEvent) {
    event.preventDefault();
    if (!fact.trim()) return;
    remember(fact);
    fact = '';
  }

  function drop(id: string) {
    forgetFact(id);
  }

  function forgetAll() {
    clearMemory();
    confirming = false;
  }
</script>

<section class="card" data-testid="companion-memory">
  <h2 class="ui-label-box"><span class="ui-label">{copy.memory}</span><InfoTip topic={copy.memory} text={copy.memoryHint} /></h2>
  {#if facts.length === 0}
    <p class="hint">{copy.memoryEmpty}</p>
  {:else}
    <ul class="list">
      {#each facts as entry (entry.id)}
        <li>
          <span class="item">{entry.text}</span>
          <button class="ghost icon" aria-label={copy.forgetFact} title={copy.forgetFact} onclick={() => drop(entry.id)}><X size={14} /></button>
        </li>
      {/each}
    </ul>
  {/if}
  <form class="add" onsubmit={add}>
    <input type="text" bind:value={fact} placeholder={copy.memoryAdd} aria-label={copy.memoryAddLabel} maxlength="200" autocomplete="off" />
    <button type="submit" class="ghost" disabled={!fact.trim()}><Plus size={14} />{copy.add}</button>
  </form>
  {#if facts.length > 0}
    {#if confirming}
      <div class="confirm" role="alert">
        <p class="hint">{facts.length === 1 ? copy.forgetAllOne : fill(copy.forgetAllConfirm, { count: String(facts.length) })}</p>
        <div class="actions">
          <button class="ghost" onclick={() => (confirming = false)}>{strings.common.cancel}</button>
          <button class="danger" onclick={forgetAll} data-testid="companion-forget-all-confirm">{copy.forget}</button>
        </div>
      </div>
    {:else}
      <div class="actions more">
        <button class="ghost" onclick={() => (confirming = true)} data-testid="companion-forget-all">{copy.forgetAll}</button>
      </div>
    {/if}
  {/if}
</section>

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
  .add {
    display: flex;
    gap: 6px;
    margin-top: 12px;
  }
  .more {
    margin-top: 12px;
  }
  .add input {
    flex: 1;
    min-width: 0;
  }
  .confirm {
    margin-top: 12px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
</style>
