<script lang="ts">
  import { MessageCircleQuestionMark } from '@lucide/svelte';
  import type { QuestionAnswer, QuestionOption } from '@boite/contracts';
  import { strings } from '../lib/strings';

  let {
    text,
    options,
    allowText,
    multiple,
    async = false,
    answer,
    pending,
    submit
  }: {
    text: string;
    options: QuestionOption[];
    allowText: boolean;
    multiple: boolean;
    /** Asked with `boite ask`: the agent did not stop for it and the answer reaches it later. */
    async?: boolean;
    answer: QuestionAnswer | null;
    /** False on a card whose turn ended before anyone answered: nothing to press. */
    pending: boolean;
    /** False when the answer did not reach the core: the card is given back to answer again. */
    submit: (optionIds: string[], text: string) => unknown;
  } = $props();

  let picked = $state<string[]>([]);
  let typed = $state('');
  let sent = $state(false);

  const ready = $derived(picked.length > 0 || typed.trim().length > 0);

  function toggle(id: string): void {
    if (multiple) {
      picked = picked.includes(id) ? picked.filter((one) => one !== id) : [...picked, id];
      return;
    }
    picked = picked[0] === id ? [] : [id];
  }

  async function send(): Promise<void> {
    if (!ready || sent) return;
    sent = true;
    if ((await submit(picked, typed.trim())) === false) sent = false;
  }

  /** What the folded card says: the labels picked, then whatever was typed. */
  function summary(given: QuestionAnswer): string {
    const labels = given.optionIds.map((id) => options.find((one) => one.id === id)?.label ?? id);
    const written = given.text ?? '';
    if (labels.length > 0 && written.length > 0) return `${labels.join(', ')}: ${written}`;
    return labels.length > 0 ? labels.join(', ') : written;
  }
</script>

<div
  class="question"
  class:resolved={answer !== null}
  class:async
  data-testid="question-card"
  data-async={async ? 'true' : undefined}
  data-state={answer !== null ? 'answered' : pending ? 'pending' : 'cancelled'}
>
  <div class="head">
    <span class="glyph"><MessageCircleQuestionMark size={15} strokeWidth={1.75} /></span>
    <span class="muted">{async ? strings.chat.questionAsyncHeading : strings.chat.questionHeading}</span>
    {#if answer !== null}
      <span class="verdict" data-testid="question-verdict">{strings.chat.questionAnswered}</span>
    {/if}
  </div>

  <p class="prompt" data-testid="question-text">{text}</p>
  {#if async && answer === null && pending}
    <p class="muted description" data-testid="question-async-hint">{strings.chat.questionAsyncHint}</p>
  {/if}

  {#if answer !== null}
    <p class="given" data-testid="question-answer">{summary(answer)}</p>
  {:else}
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
      <label class="field">
        <span class="muted section-label">{strings.chat.questionTextLabel}</span>
        <input
          type="text"
          bind:value={typed}
          placeholder={strings.chat.questionTextPlaceholder}
          data-testid="question-text-input"
          disabled={!pending || sent}
        />
      </label>
    {/if}

    {#if pending}
      <div class="actions">
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

  /* Answered, it drops to a collapsed tool card's weight: the question and what went back. */
  .question.resolved {
    border-color: var(--color-border);
    background: transparent;
    box-shadow: none;
    padding: 4px 10px;
    gap: 2px;
    color: var(--color-muted-foreground);
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
    margin-left: auto;
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-success);
  }

  .prompt {
    margin: 0;
    font-weight: 600;
  }

  .given {
    margin: 0;
    font-size: var(--text-sm);
  }

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

  .actions {
    display: flex;
    gap: 6px;
    margin-top: 2px;
  }
</style>
