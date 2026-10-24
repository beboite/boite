<script lang="ts">
  import { KeyRound } from '@lucide/svelte';
  import type { MessagePart } from '@boite/contracts';
  import { errorText } from '../lib/errors';
  import { keepFocus } from '../lib/focus';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * A key the agent asked for with `boite secret ask`. The value goes from this
   * field to the core's vault in one call and is dropped right after: it is
   * never drawn again, kept in a draft or handed to the composer. The agent
   * only ever gets a ref.
   */
  let { store, threadId, part }: {
    /** The store of the machine that owns the thread: the answer goes to its core. */
    store: Store;
    threadId: string;
    part: Extract<MessagePart, { type: 'secret_request' }>;
  } = $props();

  const fieldId = $props.id();
  const s = strings.secrets;

  /** What is typed, held only until Save sends it. */
  let value = $state('');
  /** Starts ticked when the card replaces the kept key; unticking saves a one-off copy instead. */
  let keep = $derived(part.replace === true);
  let busy = $state(false);
  let error = $state<string | null>(null);
  /** Whether this connection may carry a value (`secrets.list`); null until it answers. */
  let encrypted = $state<boolean | null>(null);
  let now = $state(Date.now());

  const expired = $derived(part.expiresAt !== undefined && part.expiresAt <= now);
  const open = $derived(part.status === 'pending' && !expired);
  const plain = $derived(encrypted === false);
  const project = $derived((store.threads.find((thread) => thread.id === threadId)?.projectId ?? null) !== null);
  const outcome = $derived(
    part.status === 'saved' ? fill(part.kept ? s.savedKept : s.saved, { name: part.name })
      : part.status === 'declined' ? fill(s.declined, { name: part.name })
      : part.status === 'cancelled' ? fill(s.cancelled, { name: part.name })
      : fill(s.timedOut, { name: part.name })
  );

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
    if (!open || !client || store.connection !== 'ready') return;
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
    const sending = client.call('secrets.answer', { threadId, requestId: part.requestId, value, keep: project && keep });
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

{#if open}
  <div class="secret" data-testid="secret-card" data-state="pending" role="group" aria-label={s.cardLabel}>
    <div class="head">
      <span class="glyph"><KeyRound size={15} strokeWidth={1.75} /></span>
      <span class="name" data-testid="secret-name">{part.name}</span>
    </div>
    <p class="reason" data-testid="secret-reason">{part.reason}</p>
    {#if part.replace}
      <p class="muted note" data-testid="secret-replaces">{s.replaces}</p>
    {/if}
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
    {#if plain}
      <p class="warn note" data-testid="secret-plain">{s.plainLink}</p>
    {/if}
    {#if project}
      <label class="keep">
        <input type="checkbox" data-testid="secret-keep" bind:checked={keep} disabled={plain || busy} />
        <span class="keep-text">
          <span class="keep-title">{s.keep}</span>
          <span class="muted note">{part.replace ? `${s.keepHint} ${s.keepReplaceHint}` : s.keepHint}</span>
        </span>
      </label>
    {/if}
    {#if error}
      <p class="error note" role="alert" data-testid="secret-error">{error}</p>
    {/if}
    <div class="actions">
      <button type="button" class="ghost" data-testid="secret-decline" disabled={busy} onmousedown={keepFocus} onclick={decline}
        ><span class="ui-label">{s.decline}</span></button
      >
      <span class="muted never">{s.neverShown}</span>
      <button
        type="button"
        class="primary"
        data-testid="secret-save"
        disabled={plain || busy || value.length === 0}
        onmousedown={keepFocus}
        onclick={save}><span class="ui-label">{s.save}</span></button
      >
    </div>
  </div>
{:else}
  <div class="secret closed" data-testid="secret-card" data-state={part.status === 'pending' ? 'timed_out' : part.status} data-kept={part.kept ? 'true' : undefined}>
    <span class="glyph"><KeyRound size={15} strokeWidth={1.75} /></span>
    <span class="outcome ui-label" data-testid="secret-outcome" title={outcome}>{outcome}</span>
  </div>
{/if}

<style>
  .secret {
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e1);
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
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

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
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
    overflow-wrap: anywhere;
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
  }

  .field::placeholder {
    -webkit-text-security: none;
  }

  .keep {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    cursor: pointer;
  }

  .keep input {
    flex: none;
    margin: 3px 0 0;
  }

  /* The app's `label > span` is a field caption; here the span is the checkbox's own text. */
  .keep .keep-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0;
    color: var(--color-foreground);
    font-size: inherit;
    min-width: 0;
  }

  .keep-title {
    font-weight: 500;
  }

  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    margin-top: 2px;
  }

  .never {
    flex: 1;
    min-width: 0;
    font-size: var(--text-xs);
    text-align: right;
  }

  .outcome {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--text-sm);
  }
</style>
