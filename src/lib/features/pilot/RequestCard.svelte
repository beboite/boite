<script lang="ts">
  /**
   * One open question, answered where it is.
   *
   * The buttons are the driver's own options in the driver's own order, and
   * their values go back untouched: `pilot.request.respond` maps them on the
   * machine holding the process (`boite_core::pilot::answer_of_option`), which
   * is the one place that may decide a string means "run it". A card that built
   * its own vocabulary would be a second idea of what the user agreed to.
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
  import type { PilotRequest, PilotRequestOutcome } from "./types";

  type Props = {
    threadId: string;
    request: PilotRequest;
    /** Set once the request has been answered: greyed, with what happened. */
    outcome?: PilotRequestOutcome | null;
    compact?: boolean;
  };
  let { threadId, request, outcome = null, compact = false }: Props = $props();

  let sending = $state(false);

  const OUTCOME = {
    allowed: "pilot.outcomeAllowed",
    denied: "pilot.outcomeDenied",
    cancelled: "pilot.outcomeCancelled",
  } as const;

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
   * nothing at all for the tool that matters.
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

  async function answer(value: string) {
    if (sending || outcome) return;
    const chosen = answerFor(options, value);
    if (!chosen) return;
    sending = true;
    try {
      await backend().pilot.respond(threadId, request.id, chosen);
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
</script>

<!-- Kept on the timeline once answered rather than removed: what was allowed is
     part of what happened in this thread, and a card that vanishes leaves the
     turn under it unexplained. -->
<div
  class="rounded-md border border-edge bg-[var(--color-surface-2)] {compact
    ? 'px-3 py-2'
    : 'px-3 py-2.5'} {outcome ? 'opacity-60' : ''}"
  data-testid="pilot-request"
  data-outcome={outcome ?? ""}
  data-compact={compact}
>
  <p class="truncate text-sm font-medium text-foreground">{title}</p>
  {#if detail && !compact}
    <pre
      class="mt-1 max-h-40 overflow-auto scroll-pane whitespace-pre-wrap break-words text-xs text-muted-foreground">{detail}</pre>
  {:else if detail}
    <p class="mt-0.5 truncate text-xs text-muted-foreground">{detail.split("\n")[0]}</p>
  {/if}

  {#if outcome}
    <p class="mt-1.5 text-xs text-muted-2" data-testid="pilot-request-answered">
      {t("pilot.requestAnswered", { outcome: t(OUTCOME[outcome]) })}
    </p>
  {:else}
    <!-- The driver's order, never sorted: it put the safe answer where it
         wanted it, and reordering is boite deciding for it. -->
    <div class="mt-2 flex flex-wrap gap-1.5">
      {#each options as option (option.value)}
        <button
          type="button"
          class="rounded-md border border-edge bg-[var(--color-surface)] px-2.5 py-1 text-sm text-foreground transition hover:bg-[var(--color-surface-3)] disabled:opacity-50"
          disabled={sending}
          onclick={() => void answer(option.value)}
          data-testid="pilot-request-option"
          data-value={option.value}
        >
          {option.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
