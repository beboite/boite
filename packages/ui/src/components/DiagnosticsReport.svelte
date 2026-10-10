<script lang="ts">
  import { tick } from 'svelte';
  import type { DiagnosticsIssue } from '@boite/contracts';
  import { Closing } from '../lib/closing.svelte';
  import { mobileOverlay } from '../lib/mobile-history';
  import { focusedElement, restoreFocus } from '../lib/focus';
  import { openExternal } from '../lib/links';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * "Report a problem": the user's words, the anonymized logs if they agree,
   * a preview of the body the core drafted, then either the issue created
   * through the machine's `gh` login or GitHub's own form opened in the
   * system browser with the export file to drag into it.
   */
  let { store, onclose }: { store: Store; onclose: () => void } = $props();
  const uid = $props.id();
  const s = $derived(strings.diagnostics);
  const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

  const overlay = new Closing();
  let card = $state<HTMLDivElement>();
  let title = $state('');
  let description = $state('');
  let includeLogs = $state(true);
  let draft = $state<DiagnosticsIssue | null>(null);
  let created = $state<string | null>(null);
  let opened = $state(false);
  let busy = $state(false);
  let error = $state('');
  const previous = focusedElement();

  let valid = $derived(title.trim().length >= 4 && title.trim().length <= 200 && description.trim().length > 0 && description.trim().length <= 20_000);
  let exportFile = $derived(draft?.exportPath ? draft.exportPath.split(/[\\/]/).pop() ?? null : null);

  overlay.show();
  $effect(() => mobileOverlay(close));
  $effect(() => { void tick().then(() => card?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true })); });

  function close() {
    overlay.hide();
    restoreFocus(previous);
    onclose();
  }

  /** A changed field outdates the preview: what goes out is always what was shown. */
  function edited() {
    draft = null;
    opened = false;
    error = '';
  }

  async function ask(submit: boolean) {
    const client = store.client;
    if (!client || busy || !valid) return;
    busy = true;
    error = '';
    try {
      const result = await client.call('diagnostics.issue', { title: title.trim(), description: description.trim(), includeLogs, submit });
      if (store.client !== client) return;
      draft = result;
      if (submit) {
        if (result.url) created = result.url;
        else error = result.error ?? '';
      }
    } catch (cause) {
      if (store.client === client) error = cause instanceof Error ? cause.message : String(cause);
    } finally { busy = false; }
  }

  async function openForm() {
    if (!draft) return;
    try { await openExternal(draft.prefillUrl); opened = true; }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab' && card) {
      const stops = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = stops[0];
      const last = stops.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey ? active !== first : active !== last) return;
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
    }
  }
</script>

{#if overlay.shown}
  <div class="scrim" class:closing={overlay.closing} role="presentation" use:overlay.attach onanimationend={overlay.end}
    onclick={event => { if (event.target === event.currentTarget) close(); }}>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="dialog" class:closing={overlay.closing} role="dialog" aria-modal="true" aria-labelledby="{uid}-heading" tabindex="-1" bind:this={card} {onkeydown} data-testid="diagnostics-report-dialog">
      <h2 id="{uid}-heading">{s.report}</h2>
      <p class="hint">{s.reportHint}</p>

      {#if created}
        <p class="done" data-testid="diagnostics-issue-created">{s.created} <a href={created} target="_blank" rel="noopener noreferrer">{created}</a></p>
        <div class="actions"><button type="button" class="primary" onclick={close}><span class="ui-label">{s.close}</span></button></div>
      {:else}
        <label class="field" for="{uid}-title">{s.title}
          <input id="{uid}-title" data-testid="diagnostics-issue-title" bind:value={title} oninput={edited} maxlength="200" placeholder={s.titlePlaceholder} autocomplete="off" />
        </label>
        <label class="field" for="{uid}-description">{s.description}
          <textarea id="{uid}-description" data-testid="diagnostics-issue-description" bind:value={description} oninput={edited} rows="5" maxlength="20000" placeholder={s.descriptionPlaceholder}></textarea>
        </label>
        <label for="{uid}-logs" class="switch-row">
          <span id="{uid}-logs-name">{s.includeLogs}</span>
          <input id="{uid}-logs" aria-labelledby="{uid}-logs-name" type="checkbox" role="switch" data-testid="diagnostics-issue-logs" bind:checked={includeLogs} onchange={edited} />
        </label>

        {#if draft}
          <div class="preview">
            <p class="label">{s.preview} · {draft.repository}</p>
            <p class="hint">{s.previewHint}</p>
            <pre data-testid="diagnostics-issue-preview">{draft.body}</pre>
          </div>
          {#if draft.gh !== 'ready'}
            <p class="hint" data-testid="diagnostics-issue-gh">{exportFile ? fill(s.ghMissing, { file: exportFile }) : s.ghMissingNoFile}</p>
          {/if}
          {#if opened}<p class="hint">{s.opened}</p>{/if}
        {/if}
        {#if error}<p class="alert" role="alert">{error}</p>{/if}

        <div class="actions">
          <button type="button" class="ghost" onclick={close}><span class="ui-label">{s.cancel}</span></button>
          {#if !draft}
            <button type="button" class="primary" data-testid="diagnostics-issue-preview-button" disabled={!valid || busy} onclick={() => void ask(false)}><span class="ui-label">{s.preview}</span></button>
          {:else if draft.gh === 'ready'}
            <button type="button" class="primary" data-testid="diagnostics-issue-submit" disabled={!valid || busy} onclick={() => void ask(true)}><span class="ui-label">{s.submit}</span></button>
          {:else}
            <button type="button" class="primary" data-testid="diagnostics-issue-open" disabled={busy} onclick={() => void openForm()}><span class="ui-label">{s.openGithub}</span></button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: var(--color-scrim); animation: fade var(--dur-2) var(--ease-out-quint); }
  .scrim.closing { animation-name: fade-out; pointer-events: none; }
  .dialog { display: grid; gap: 10px; width: min(620px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; padding: 18px; background: var(--color-surface); border: 1px solid var(--color-edge); border-radius: var(--radius-xl); box-shadow: var(--shadow-e3); animation: pop var(--dur-2) var(--ease-out-quint); }
  .dialog.closing { animation-name: pop-out; }
  h2 { font-size: var(--text-md); }
  .hint { color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; overflow-wrap: anywhere; }
  .field { display: grid; gap: 6px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .field input, .field textarea { width: 100%; min-width: 0; color: var(--color-foreground); font-size: var(--text-base); }
  textarea { resize: vertical; min-height: 96px; font: inherit; }
  .switch-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 6px 0; }
  .preview { display: grid; gap: 4px; }
  .label { font-size: var(--text-xs); color: var(--color-muted-foreground); }
  pre { max-height: 240px; overflow: auto; margin: 4px 0 0; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-code-background); color: var(--color-code-foreground); font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  .alert { color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .done { overflow-wrap: anywhere; }
  .actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  @media (prefers-reduced-motion: reduce) { .scrim, .dialog { animation: none; } }
</style>
