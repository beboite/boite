<script lang="ts">
  import { ChevronRight, FileText, MessageCircleQuestionMark, Paperclip, X } from '@lucide/svelte';
  import type { Attachment, QuestionAnswer, QuestionOption } from '@boite/contracts';
  import { gatherAttachments } from '../lib/composer-attachments';
  import { fill, strings } from '../lib/strings';

  let {
    text,
    options,
    allowText,
    multiple,
    async = false,
    docked = false,
    answer,
    pending,
    submit,
    skip
  }: {
    text: string;
    options: QuestionOption[];
    allowText: boolean;
    multiple: boolean;
    /** Asked with `boite ask`: the agent did not stop for it and the answer reaches it later. */
    async?: boolean;
    /** Drawn inside the dock above the composer, whose own row names it: no frame, no heading. */
    docked?: boolean;
    answer: QuestionAnswer | null;
    /** False on a card whose turn ended before anyone answered: nothing to press. */
    pending: boolean;
    /**
     * False when the answer did not reach the core: the card is given back to
     * answer again. `attachments` only where the free field is allowed: the
     * core hands them to the agent as paths.
     */
    submit: (optionIds: string[], text: string, attachments: Attachment[]) => unknown;
    /** Resolve without sending an answer. A failure leaves the card usable. */
    skip?: () => unknown;
  } = $props();

  let picked = $state<string[]>([]);
  let typed = $state('');
  let sent = $state(false);
  let open = $state(false);
  let built = $state(false);
  $effect(() => { if (open) built = true; });

  /** Photos and files given with the answer, read and reduced as the composer's are. */
  let files = $state<Attachment[]>([]);
  let reading = $state(0);
  let fileError = $state<string | null>(null);
  let picker = $state<HTMLInputElement>();
  const inputId = $props.id();

  const ready = $derived((picked.length > 0 || typed.trim().length > 0 || files.length > 0) && reading === 0);

  async function take(incoming: File[]): Promise<void> {
    if (incoming.length === 0 || !allowText || !pending || sent) return;
    reading += 1;
    fileError = null;
    try {
      fileError = await gatherAttachments(incoming, {
        held: () => files,
        add: (attachment) => { files = [...files, attachment]; },
        noImages: null
      });
    } finally { reading -= 1; }
  }

  function filesOf(list: FileList | DataTransferItemList | null | undefined): File[] {
    if (!list) return [];
    if (list instanceof FileList) return Array.from(list);
    return Array.from(list).filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => file !== null);
  }

  function onpaste(event: ClipboardEvent): void {
    const pasted = filesOf(event.clipboardData?.items);
    if (pasted.length === 0) return;
    event.preventDefault();
    void take(pasted);
  }

  function ondragover(event: DragEvent): void {
    if (!allowText || !pending || answer !== null) return;
    if (!Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === 'file')) return;
    event.preventDefault();
    // The composer under the card would take the drop otherwise.
    event.stopPropagation();
  }

  function ondrop(event: DragEvent): void {
    if (!allowText || !pending || answer !== null) return;
    const dropped = filesOf(event.dataTransfer?.files);
    if (dropped.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void take(dropped);
  }

  function toggle(id: string): void {
    if (multiple) {
      picked = picked.includes(id) ? picked.filter((one) => one !== id) : [...picked, id];
      return;
    }
    picked = picked[0] === id ? [] : [id];
  }

  async function send(): Promise<void> {
    if (!pending || !ready || sent) return;
    sent = true;
    if ((await submit(picked, typed.trim(), files)) === false) sent = false;
  }

  async function pass(): Promise<void> {
    if (!pending || sent || !skip) return;
    sent = true;
    if ((await skip()) === false) sent = false;
  }

  /** What the folded card says: the labels picked, then whatever was typed, else how many files went. */
  function summary(given: QuestionAnswer): string {
    const labels = given.optionIds.map((id) => options.find((one) => one.id === id)?.label ?? id);
    const written = given.text ?? '';
    if (labels.length > 0 && written.length > 0) return `${labels.join(', ')}: ${written}`;
    const said = labels.length > 0 ? labels.join(', ') : written;
    const count = given.attachments?.length ?? 0;
    return said.length > 0 || count === 0 ? said : fill(strings.media.answerFileCount, { count: String(count) });
  }

  function fileNames(given: QuestionAnswer): string {
    return (given.attachments ?? []).map((file) => file.name ?? strings.composer.attachUnnamed).join(', ');
  }
</script>

<div
  class="question"
  class:resolved={answer !== null}
  class:async
  class:docked
  data-testid="question-card"
  data-async={async ? 'true' : undefined}
  data-state={answer !== null ? 'answered' : pending ? 'pending' : 'cancelled'}
  role="group"
  {ondragover}
  {ondrop}
>
  {#if answer !== null}
    <button type="button" class="ghost answered-row" data-testid="question-toggle" aria-expanded={open} onclick={() => (open = !open)}>
      <span class="glyph"><MessageCircleQuestionMark size={15} strokeWidth={1.75} /></span>
      <span class="verdict" data-testid="question-verdict">{strings.chat.questionAnswered}</span>
      <span class="given" data-testid="question-answer" title={summary(answer)}>{summary(answer)}</span>
      {#if answer.attachments?.length}
        <span class="given-files" data-testid="question-answer-files" title={fileNames(answer)}><Paperclip size={12} strokeWidth={2} />{answer.attachments.length}</span>
      {/if}
      <span class="caret" class:open aria-hidden="true"><ChevronRight size={12} strokeWidth={2} /></span>
    </button>
    <div class="fold" class:open inert={!open}>
      <div class="clip">
        {#if built}
          <div class="answer-detail">
            <p class="prompt" data-testid="question-text">{text}</p>
            <p>{summary(answer)}</p>
            {#if answer.attachments?.length}
              <p class="muted">{fill(strings.media.answerFiles, { names: fileNames(answer) })}</p>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {:else}
  {#if !docked}
    <div class="head">
      <span class="glyph"><MessageCircleQuestionMark size={15} strokeWidth={1.75} /></span>
      <span class="muted">{async ? strings.chat.questionAsyncHeading : strings.chat.questionHeading}</span>
    </div>
  {/if}

  <p class="prompt" data-testid="question-text">{text}</p>
  {#if async && answer === null && pending && !docked}
    <p class="muted description" data-testid="question-async-hint">{strings.chat.questionAsyncHint}</p>
  {/if}

    {#if options.length > 0}
      <div class="options" role={multiple ? 'group' : 'radiogroup'}>
        {#each options as option (option.id)}
          <button
            type="button"
            class="option"
            class:picked={picked.includes(option.id)}
            role={multiple ? 'checkbox' : 'radio'}
            aria-checked={picked.includes(option.id)}
            data-testid="question-option"
            data-option={option.id}
            disabled={!pending || sent}
            onclick={() => toggle(option.id)}
          >
            <span class="box" class:round={!multiple}></span>
            <span class="labels">
              <span class="label">{option.label}</span>
              {#if option.description}
                <span class="muted description">{option.description}</span>
              {/if}
            </span>
          </button>
        {/each}
      </div>
    {/if}

    {#if allowText}
      <div class="field">
        <label class="muted section-label" for={inputId}>{strings.chat.questionTextLabel}</label>
        <div class="entry">
          <input
            id={inputId}
            type="text"
            bind:value={typed}
            {onpaste}
            onkeydown={(event) => {
              if (event.key !== 'Enter' || event.isComposing) return;
              event.preventDefault();
              event.stopPropagation();
              void send();
            }}
            placeholder={strings.chat.questionTextPlaceholder}
            data-testid="question-text-input"
            disabled={!pending || sent}
          />
          {#if pending}
            <button
              type="button"
              class="icon attach"
              data-testid="question-attach"
              title={strings.media.answerAttach}
              aria-label={strings.media.answerAttach}
              disabled={sent}
              onclick={() => picker?.click()}
            ><Paperclip size={15} strokeWidth={1.75} /></button>
            <input
              bind:this={picker}
              type="file"
              multiple
              hidden
              data-testid="question-file"
              onchange={(event) => {
                const input = event.currentTarget;
                const chosen = Array.from(input.files ?? []);
                input.value = '';
                void take(chosen);
              }}
            />
          {/if}
        </div>
        {#if files.length > 0}
          <ul class="files" data-testid="question-files">
            {#each files as file, at (file)}
              {@const label = file.name ?? strings.composer.attachAlt}
              <li class="file" class:document={file.kind === 'file'} data-testid="question-file-item" title={label}>
                {#if file.kind === 'image'}
                  <img src="data:{file.mimeType};base64,{file.data}" alt={label} />
                {:else}
                  <FileText size={16} strokeWidth={1.5} /><span>{label}</span>
                {/if}
                <button
                  type="button"
                  class="icon small remove"
                  data-testid="question-file-remove"
                  title={fill(strings.composer.attachRemove, { name: label })}
                  aria-label={fill(strings.composer.attachRemove, { name: label })}
                  disabled={sent}
                  onclick={() => { files = files.filter((_, index) => index !== at); }}
                ><X size={12} strokeWidth={2.25} /></button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if fileError}
          <p class="file-error" role="alert" data-testid="question-file-error">{fileError}</p>
        {/if}
      </div>
    {/if}

    {#if pending}
      <div class="actions">
        {#if skip}
          <button type="button" class="ghost" data-testid="question-skip" disabled={sent} onclick={pass}>{strings.chat.questionSkip}</button>
        {/if}
        <button
          type="button"
          class="primary"
          data-testid="question-submit"
          disabled={!ready || sent}
          onclick={send}
        >
          {strings.chat.questionAnswer}
        </button>
      </div>
    {:else}
      <p class="muted description" data-testid="question-cancelled">{strings.chat.questionCancelled}</p>
    {/if}
  {/if}
</div>

<style>
  .question {
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e1);
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* Nobody waits on it: a dashed edge instead of the live one that says the agent is stopped. */
  .question.async {
    border-left-style: dashed;
  }

  /* In the dock the dock is the frame. */
  .question.docked {
    border: none;
    background: transparent;
    box-shadow: none;
    padding: 2px 8px 8px 32px;
  }

  /* Resolved questions use the same inset and touch target as tool disclosures. */
  .question.resolved {
    border: none;
    background: transparent;
    box-shadow: none;
    padding: 0;
    gap: 0;
    color: var(--color-muted-foreground);
    min-width: 0;
  }

  .question.resolved .prompt {
    font-weight: 500;
    font-size: var(--text-sm);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .glyph {
    display: inline-flex;
    color: var(--color-live);
  }

  .resolved .glyph {
    color: var(--color-subtle);
  }

  .verdict {
    flex: none;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }

  .prompt {
    margin: 0;
    font-weight: 600;
  }

  .given {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-foreground);
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .answered-row { display: flex; align-items: center; justify-content: flex-start; gap: var(--activity-gap); width: 100%; height: auto; min-height: var(--control); padding: var(--activity-padding); border-radius: var(--radius-sm); font-weight: 400; text-align: left; }
  .answered-row:hover:not(:disabled) { background: var(--color-surface-2); }
  .answered-row:active:not(:disabled) { transform: none; }
  .answered-row .glyph { flex: none; width: var(--activity-glyph); justify-content: center; }
  .caret { display: inline-flex; flex: none; color: var(--color-subtle); transition: transform var(--dur-2) var(--ease-out-quint); }
  .caret.open { transform: rotate(90deg); }
  .fold { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows var(--dur-3) var(--ease-out-quint), opacity var(--dur-3) var(--ease-out-quint); }
  .fold.open { grid-template-rows: 1fr; opacity: 1; }
  .clip { min-height: 0; overflow: hidden; }
  .answer-detail { margin: 4px 0 8px calc(var(--activity-padding) + var(--activity-glyph) / 2); padding: 4px var(--activity-padding) 4px calc(var(--activity-glyph) / 2 + var(--activity-gap)); border-left: 1px solid var(--color-border); font-size: var(--text-sm); }
  .answer-detail p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .answer-detail p + p { margin-top: 8px; color: var(--color-foreground); }

  .options {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /* The global button is one centred 28 px line; a row here is two lines tall. */
  .option {
    display: flex;
    align-items: flex-start;
    justify-content: flex-start;
    gap: 8px;
    width: 100%;
    height: auto;
    white-space: normal;
    text-align: left;
    padding: 6px 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition:
      background var(--dur-2) var(--ease-out-quint),
      border-color var(--dur-2) var(--ease-out-quint),
      transform var(--dur-1) var(--ease-out-quint);
  }

  /* The option lifts a pixel under the pointer and fills under the keyboard;
     neither one commits the pick, which is what the click is for. */
  .option:hover:not(:disabled) {
    border-color: var(--color-edge);
    transform: translateY(-1px);
  }

  .option:focus-visible {
    outline: none;
    border-color: var(--color-edge);
    background: var(--color-surface-2);
  }

  .option:active:not(:disabled) {
    transform: none;
    background: var(--color-surface-3);
  }

  .option.picked {
    border-color: var(--color-live);
  }

  .option:disabled {
    cursor: default;
  }

  .box {
    width: 12px;
    height: 12px;
    margin-top: 3px;
    flex: none;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-sm);
  }

  .box.round {
    border-radius: 50%;
  }

  .option.picked .box {
    border-color: var(--color-live);
    background: var(--color-live);
  }

  .labels {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    min-width: 0;
  }

  .description {
    font-size: var(--text-sm);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  input {
    padding: 6px 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    color: inherit;
    font: inherit;
  }

  input:focus-visible {
    outline: none;
    border-color: var(--color-live);
  }

  .entry { display: flex; align-items: center; gap: 4px; }
  .entry input { flex: 1; min-width: 0; }
  .attach { flex: none; color: var(--color-muted-foreground); }
  .attach:hover:not(:disabled) { color: var(--color-foreground); }
  .given-files { display: inline-flex; align-items: center; gap: 2px; flex: none; font-size: var(--text-xs); color: var(--color-muted-foreground); }

  /* What goes with the answer: thumbnails the size of a fingertip, each with its own way out. */
  .files { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 0; padding: 0; list-style: none; }
  .file { position: relative; width: 56px; height: 56px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface-2); overflow: hidden; animation: pop var(--dur-2) var(--ease-out-quint); }
  .file img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .file.document { width: min(200px, 100%); display: flex; align-items: center; gap: 6px; padding: 0 30px 0 8px; font-size: var(--text-sm); }
  .file.document span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file .remove { position: absolute; top: 2px; right: 2px; width: 22px; height: 22px; padding: 0; border: none; border-radius: var(--radius-sm); background: var(--color-scrim); color: var(--color-foreground); }
  .file .remove:hover:not(:disabled) { background: var(--color-danger); color: var(--color-on-danger); }
  .file-error { margin: 2px 0 0; font-size: var(--text-sm); color: var(--color-danger); }
  @media (max-width: 720px) {
    .attach { width: var(--control-touch); height: var(--control-touch); }
    .file .remove { width: 28px; height: 28px; }
  }

  .actions {
    display: flex;
    gap: 6px;
    margin-top: 2px;
  }
</style>
