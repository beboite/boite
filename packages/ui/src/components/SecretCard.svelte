<script lang="ts">
  import { ChevronRight, KeyRound, LockKeyhole } from '@lucide/svelte';
  import type { MessagePart } from '@boite/contracts';
  import { errorText } from '../lib/errors';
  import { keepFocus } from '../lib/focus';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { showDockedQuestion } from '../lib/question-dock.svelte';

  /**
   * A key the agent asked for with `boite secret ask`. The value goes from this
   * field to the core's memory in one call and is dropped right after: it is
   * never drawn again, kept in a draft or handed to the composer. The agent
   * only ever gets a ref.
   */
  let { store, threadId, part, docked = false }: {
    /** The store of the machine that owns the thread: the answer goes to its core. */
    store: Store;
    threadId: string;
    part: Extract<MessagePart, { type: 'secret_request' }>;
    docked?: boolean;
  } = $props();

  const fieldId = $props.id();
  const s = strings.secrets;

  /** What is typed, held only until Save sends it. */
  let value = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  /** Whether this connection may carry a value (`secrets.list`); null until it answers. */
  let encrypted = $state<boolean | null>(null);
  let now = $state(Date.now());

  const expired = $derived(part.expiresAt !== undefined && part.expiresAt <= now);
  const open = $derived(part.status === 'pending' && !expired);
  const plain = $derived(encrypted === false);
  const outcome = $derived(
    part.status === 'saved' ? fill(s.saved, { name: part.name })
      : part.status === 'declined' ? fill(s.declined, { name: part.name })
      : part.status === 'cancelled' ? fill(s.cancelled, { name: part.name })
      : fill(s.timedOut, { name: part.name })
  );

  $effect(() => {
    if (!open) value = '';
  });

  // The card stops taking an answer the moment its deadline passes, before the core says so.
  $effect(() => {
    if (part.status !== 'pending' || part.expiresAt === undefined) return;
    const left = part.expiresAt - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => (now = Date.now()), Math.min(left + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const client = store.client;
    if (!docked || !open || !client || store.connection !== 'ready') return;
    let live = true;
    client.call('secrets.list', { threadId }).then(
      (listed) => { if (live) encrypted = listed.encrypted; },
      () => { /* An older core: the answer itself says whether the link carries a value. */ }
    );
    return () => { live = false; };
  });

  async function save(): Promise<void> {
    const client = store.client;
    if (!open || plain || busy || value.length === 0 || !client) return;
    busy = true;
    error = null;
    const sending = client.call('secrets.answer', { threadId, requestId: part.requestId, value });
    value = '';
    try {
      await sending;
    } catch (failure) {
      error = errorText(failure);
    } finally {
      busy = false;
    }
  }

  async function decline(): Promise<void> {
    const client = store.client;
    if (!open || busy || !client) return;
    busy = true;
    error = null;
    value = '';
    try {
      await client.call('secrets.answer', { threadId, requestId: part.requestId, declined: true });
    } catch (failure) {
      error = errorText(failure);
    } finally {
      busy = false;
    }
  }

  /** Keys and pastes in the field are the field's: no shortcut, composer or live view sees them. */
  function own(event: Event): void {
    event.stopPropagation();
  }

  function onkeydown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void save();
    }
  }
</script>

{#if open && !docked}
  <button type="button" class="ghost pending-row" data-testid="secret-docked" title={s.cardLabel} onclick={() => showDockedQuestion(part.requestId)}>
    <KeyRound size={15} strokeWidth={1.75} />
    <span class="name ui-label" data-testid="secret-name">{part.name}</span>
    <span class="open-glyph" aria-hidden="true"><ChevronRight size={13} /></span>
  </button>
{:else if open}
  <div class="secret" data-testid="secret-card" data-state="pending" role="group" aria-label={s.cardLabel}>
    <p class="reason" data-testid="secret-reason">{part.reason}</p>
    <div class="field-row">
    <span class="field-glyph" aria-hidden="true"><LockKeyhole size={16} /></span>
    <input
      id={fieldId}
      class="field"
      data-testid="secret-field"
      type="text"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      data-1p-ignore
      data-lpignore="true"
      data-bwignore
      data-form-type="other"
      aria-label={fill(s.fieldLabel, { name: part.name })}
      placeholder={part.placeholder ?? undefined}
      disabled={plain || busy}
      bind:value
      {onkeydown}
      onkeyup={own}
      onkeypress={own}
      onpaste={own}
      oninput={own}
    />
    <button
      type="button"
      class="primary"
      data-testid="secret-save"
      disabled={plain || busy || value.length === 0}
      onmousedown={keepFocus}
      onclick={save}><span class="ui-label">{s.save}</span></button
    >
    </div>
    {#if plain}
      <p class="warn note" data-testid="secret-plain">{s.plainLink}</p>
    {/if}
    {#if error}
      <p class="error note" role="alert" data-testid="secret-error">{error}</p>
    {/if}
    <div class="actions">
      <p class="muted note" data-testid="secret-transit">{s.transit}</p>
      <button type="button" class="ghost" data-testid="secret-decline" disabled={busy} onmousedown={keepFocus} onclick={decline}
        ><span class="ui-label">{s.decline}</span></button
      >
    </div>
  </div>
{:else}
  <div class="secret closed" data-testid="secret-card" data-state={part.status === 'pending' ? 'timed_out' : part.status}>
    <span class="glyph"><KeyRound size={15} strokeWidth={1.75} /></span>
    <span class="outcome ui-label" data-testid="secret-outcome" title={outcome}>{outcome}</span>
  </div>
{/if}

<style>
  .secret {
    padding: 4px 8px 6px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  /* Closed, it is one line of the timeline, like a tool row. */
  .secret.closed {
    flex-direction: row;
    align-items: center;
    gap: var(--activity-gap);
    min-height: var(--control);
    padding: var(--activity-padding);
    border: none;
    background: transparent;
    box-shadow: none;
    color: var(--color-muted-foreground);
  }

  .glyph {
    display: inline-flex;
    flex: none;
    color: var(--color-live);
  }

  .closed .glyph {
    width: var(--activity-glyph);
    justify-content: center;
    color: var(--color-subtle);
  }

  .name {
    min-width: 0;
    font-family: var(--font-mono);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .reason {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
  }

  .warn {
    color: var(--color-live);
  }

  .error {
    color: var(--color-danger);
    overflow-wrap: anywhere;
  }

  /* Masked like a password, but a text field, so no password manager offers to save it. */
  .field {
    width: 100%;
    min-width: 0;
    font-family: var(--font-mono);
    -webkit-text-security: disc;
    padding-inline-start: 34px;
  }

  .field::placeholder {
    -webkit-text-security: none;
  }

  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    justify-content: space-between;
  }

  .actions > button { margin-inline-start: auto; color: var(--color-muted-foreground); }
  .field-row { display: flex; align-items: center; gap: 8px; position: relative; }
  .field-row > button { flex: none; }
  .field-glyph { display: flex; position: absolute; inset-inline-start: 11px; color: var(--color-muted-foreground); pointer-events: none; }
  .pending-row { display: flex; align-items: center; gap: var(--activity-gap); width: 100%; min-width: 0; min-height: var(--control); padding: var(--activity-padding); color: var(--color-muted-foreground); font-size: var(--text-sm); text-align: left; }
  .pending-row > :global(svg) { flex: none; color: var(--color-live); }
  .open-glyph { display: flex; margin-inline-start: auto; flex: none; }

  .outcome {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--text-sm);
  }
</style>
