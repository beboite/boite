<script lang="ts">
  /**
   * One open question, answered where it is.
   *
   * The one card in the pane that has to be seen: a foreground border and a
   * band of surface-2 while it is open, because everything else on the timeline
   * is a hairline on the background and a question that read like a tool call
   * is a thread stopped for a reason nobody noticed.
   *
   * The buttons are the driver's own options in the driver's own order, and
   * their values go back untouched: `pilot.request.respond` maps them on the
   * machine holding the process (`boite_core::pilot::answer_of_option`), which
   * is the one place that may decide a string means "run it". A card that built
   * its own vocabulary would be a second idea of what the user agreed to. The
   * first option is the primary one for the same reason: the driver put the
   * safe answer where it wanted it, and reordering is boite deciding for it.
   *
   * Enter takes the first option and Escape the last, which is the only pair a
   * card can bind without reading the driver's vocabulary. Bound on the card
   * rather than on the window: two questions can be up at once, and a key that
   * answered whichever was rendered last would answer the wrong one.
   *
   * The same component in two places: the pane's timeline and the approvals
   * dock, `compact` being the difference. A dock card that looked different
   * from the one in the pane would be a second thing to learn about the same
   * question.
   */
  import { backend } from "$lib/backend";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { log } from "$lib/shared/log";
  import { t } from "$lib/i18n/index.svelte";
  import { answerFor } from "./selection";
  import { toolKind } from "./present";
  import type {
    PilotRequest,
    PilotRequestAnswer,
    PilotRequestOutcome,
    PilotRequestQuestion,
  } from "./types";
  import FilePen from "@lucide/svelte/icons/file-pen";
  import FilePlus from "@lucide/svelte/icons/file-plus";
  import FileText from "@lucide/svelte/icons/file-text";
  import SearchIcon from "@lucide/svelte/icons/search";
  import Terminal from "@lucide/svelte/icons/terminal";
  import Wrench from "@lucide/svelte/icons/wrench";

  type Props = {
    threadId: string;
    request: PilotRequest;
    /** Set once the request has been answered: greyed, with what happened. */
    outcome?: PilotRequestOutcome | null;
    compact?: boolean;
  };
  let { threadId, request, outcome = null, compact = false }: Props = $props();

  let sending = $state(false);
  let card: HTMLDivElement | null = $state(null);
  let selectedAnswers = $state<Record<string, string[]>>({});
  let customAnswers = $state<Record<string, string>>({});

  /**
   * The card takes focus when it opens, and only if nobody else has it.
   *
   * Enter and Escape are bound on the card rather than on the window because
   * two questions can be up at once; a card that never got focus would leave
   * both keys dead. Guarded on `body` being the active element so a question
   * arriving while the user is typing never eats the keystroke: their box wins,
   * and the buttons are still one Tab away.
   */
  $effect(() => {
    if (outcome || !card) return;
    const active = card.ownerDocument.activeElement;
    if (active && active !== card.ownerDocument.body) return;
    card.focus({ preventScroll: true });
  });

  const OUTCOME = {
    allowed: "pilot.outcomeAllowed",
    denied: "pilot.outcomeDenied",
    cancelled: "pilot.outcomeCancelled",
  } as const;

  const ICONS = {
    bash: Terminal,
    read: FileText,
    write: FilePlus,
    edit: FilePen,
    search: SearchIcon,
    other: Wrench,
  } as const;

  const Icon = $derived(ICONS[toolKind(request.tool_name ?? "")]);

  const title = $derived.by(() => {
    if (request.title) return request.title;
    if (request.kind === "tool_approval") {
      return t("pilot.requestTool", { tool: request.tool_name ?? "" });
    }
    return request.kind === "plan" ? t("pilot.requestPlan") : t("pilot.requestQuestion");
  });

  /**
   * The input, as one readable block.
   *
   * A tool input is whatever JSON the driver sent, so it is printed rather than
   * interpreted: a card that only understood the shapes it knew would show
   * nothing at all for the tool that matters. The one shape it does read is a
   * command, which is a line to run and belongs in mono on its own.
   */
  const detail = $derived.by(() => {
    if (typeof request.description === "string" && request.description) {
      return request.description;
    }
    if (request.input === undefined || request.input === null) return "";
    if (typeof request.input === "string") return request.input;
    try {
      return JSON.stringify(request.input, null, 2);
    } catch {
      return String(request.input);
    }
  });

  /** The command, when the driver sent one, so it is not read out of JSON. */
  const command = $derived.by(() => {
    const input = request.input;
    if (!input || typeof input !== "object") return "";
    const value = (input as Record<string, unknown>).command;
    return typeof value === "string" ? value : "";
  });

  /**
   * The options, or the two boite always understands.
   *
   * A driver that offered none still has to be answerable: the host maps
   * `allow` and `deny` whatever the driver called them, and a card with no
   * buttons is a thread blocked with no way out.
   */
  const options = $derived(
    request.options && request.options.length > 0
      ? request.options
      : [
          { value: "allow", label: t("pilot.requestAllow") },
          { value: "deny", label: t("pilot.requestDeny") },
        ],
  );

  const questions = $derived(request.questions ?? []);

  function answerValues(question: PilotRequestQuestion): string[] {
    const custom = customAnswers[question.id]?.trim();
    return custom ? [custom] : (selectedAnswers[question.id] ?? []);
  }

  const structuredAnswer = $derived.by(() => {
    if (questions.length === 0) return null;
    const answers: Record<string, string[]> = {};
    for (const question of questions) {
      const values = answerValues(question);
      if (values.length === 0) return null;
      answers[question.id] = values;
    }
    return { answers } satisfies Extract<PilotRequestAnswer, object>;
  });

  function toggleOption(question: PilotRequestQuestion, value: string) {
    customAnswers[question.id] = "";
    const current = selectedAnswers[question.id] ?? [];
    selectedAnswers[question.id] = question.multi_select
      ? current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value]
      : [value];
  }

  function setCustom(question: PilotRequestQuestion, value: string) {
    customAnswers[question.id] = value;
    if (value.trim()) selectedAnswers[question.id] = [];
  }

  async function send(answer: PilotRequestAnswer) {
    if (sending || outcome) return;
    sending = true;
    try {
      await backend().pilot.respond(threadId, request.id, answer);
    } catch (err) {
      log.warn("pilot.request", "pilot.respond.failed", {
        thread: threadId,
        request: request.id,
        reason: String(err),
      });
      notifications.error(t("pilot.respondFailed"));
    } finally {
      sending = false;
    }
  }

  async function answer(value: string) {
    if (sending || outcome) return;
    const chosen = answerFor(options, value);
    if (!chosen) return;
    await send(chosen);
  }

  async function answerQuestions() {
    if (!structuredAnswer) return;
    await send(structuredAnswer);
  }

  function onKeydown(event: KeyboardEvent) {
    if (outcome || sending) return;
    if (questions.length > 0) return;
    if (event.key === "Enter" && options[0]) {
      event.preventDefault();
      event.stopPropagation();
      void answer(options[0].value);
      return;
    }
    if (event.key === "Escape" && options.length > 1) {
      event.preventDefault();
      event.stopPropagation();
      void answer(options[options.length - 1].value);
    }
  }
</script>

<!-- Kept on the timeline once answered rather than removed: what was allowed is
     part of what happened in this thread, and a card that vanishes leaves the
     turn under it unexplained. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="pilot-card rounded-lg {compact ? 'px-2.5 py-2' : 'px-3 py-2.5'} {outcome
    ? 'border border-border bg-[var(--color-surface)] opacity-70'
    : 'border border-[var(--color-foreground)] bg-[var(--color-surface-2)]'}"
  bind:this={card}
  role="group"
  tabindex="-1"
  onkeydown={onKeydown}
  aria-label={title}
  data-testid="pilot-request"
  data-outcome={outcome ?? ""}
  data-compact={compact}
>
  <div class="flex items-center gap-1.5">
    <Icon class="size-3.5 shrink-0 text-muted-foreground" />
    <p class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</p>
  </div>

  {#if command}
    <pre
      class="mt-1.5 max-h-40 scroll-pane overflow-auto rounded bg-[var(--color-surface)] px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words text-foreground">{command}</pre>
  {:else if detail && !compact}
    <pre
      class="mt-1.5 max-h-40 scroll-pane overflow-auto font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">{detail}</pre>
  {:else if detail}
    <p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">{detail.split("\n")[0]}</p>
  {/if}

  {#if outcome}
    <p class="mt-1.5 text-xs text-muted-foreground" data-testid="pilot-request-answered">
      {t("pilot.requestAnswered", { outcome: t(OUTCOME[outcome]) })}
    </p>
  {:else if questions.length > 0}
    <div class="mt-2 flex flex-col gap-3" data-testid="pilot-request-questions">
      {#each questions as question (question.id)}
        <fieldset class="min-w-0">
          <legend class="text-xs font-medium text-foreground">{question.header}</legend>
          <p class="mt-0.5 text-xs text-muted-foreground">{question.question}</p>
          {#if question.options && question.options.length > 0}
            <div class="mt-1.5 flex flex-col gap-1 sm:flex-row sm:flex-wrap">
              {#each question.options as option (option.value)}
                <button
                  type="button"
                  class="press rounded-md border px-2.5 py-1.5 text-left text-xs transition focus:outline-none focus-visible:focus-ring disabled:opacity-50 {selectedAnswers[
                    question.id
                  ]?.includes(option.value)
                    ? 'border-[var(--color-foreground)] bg-[var(--color-foreground)] text-[var(--color-background)]'
                    : 'border-border bg-[var(--color-surface)] text-foreground hover:bg-[var(--color-surface-3)]'}"
                  disabled={sending}
                  aria-pressed={selectedAnswers[question.id]?.includes(option.value) ?? false}
                  onclick={() => toggleOption(question, option.value)}
                  data-testid="pilot-question-option"
                  data-question={question.id}
                  data-value={option.value}
                >
                  {option.label}
                </button>
              {/each}
            </div>
          {/if}
          {#if question.allow_custom_answer || !question.options || question.options.length === 0}
            <input
              type={question.secret ? "password" : "text"}
              class="mt-1.5 w-full rounded-md border border-border bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:focus-ring"
              value={customAnswers[question.id] ?? ""}
              placeholder={t("pilot.requestCustomAnswer")}
              aria-label={t("pilot.requestCustomAnswer")}
              autocomplete="off"
              disabled={sending}
              oninput={(event) => setCustom(question, event.currentTarget.value)}
              data-testid="pilot-question-custom"
              data-question={question.id}
            />
          {/if}
        </fieldset>
      {/each}
      <button
        type="button"
        class="press self-start rounded-md bg-[var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[var(--color-background)] transition focus:outline-none focus-visible:focus-ring disabled:opacity-50"
        disabled={sending || !structuredAnswer}
        onclick={() => void answerQuestions()}
        data-testid="pilot-question-submit"
      >
        {t("pilot.requestSubmitAnswers")}
      </button>
    </div>
  {:else}
    <!-- The driver's order, never sorted. Full width on a phone, where a row of
         three small buttons is three targets nobody can hit. -->
    <div class="mt-2 flex flex-col gap-1.5 sm:flex-row sm:flex-wrap">
      {#each options as option, at (option.value)}
        <button
          type="button"
          class="press rounded-md px-3 py-1.5 text-sm transition focus:outline-none focus-visible:focus-ring disabled:opacity-50 {at ===
          0
            ? 'bg-[var(--color-foreground)] font-medium text-[var(--color-background)]'
            : 'border border-border bg-[var(--color-surface)] text-foreground hover:bg-[var(--color-surface-3)]'}"
          disabled={sending}
          onclick={() => void answer(option.value)}
          data-testid="pilot-request-option"
          data-value={option.value}
        >
          {option.label}
        </button>
      {/each}
      <p class="hidden items-center gap-1 self-center text-xs text-muted-foreground sm:flex">
        <kbd class="kbd">{t("pilot.keyEnter")}</kbd>
        {options[0]?.label ?? ""}
        {#if options.length > 1}
          <kbd class="kbd ml-1">{t("pilot.keyEsc")}</kbd>
          {options[options.length - 1]?.label ?? ""}
        {/if}
      </p>
    </div>
  {/if}
</div>

<style>
  .pilot-card {
    animation: pilot-card var(--dur-2) var(--ease-out-quint);
  }
  @keyframes pilot-card {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  :global(html[data-motion="reduced"]) .pilot-card {
    animation: none;
  }
</style>
