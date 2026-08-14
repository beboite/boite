<script lang="ts">
  import { fly } from "svelte/transition";
  import { t } from "$lib/i18n/index.svelte";
  import { logger } from "$lib/shared/services/logger.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { threadReply } from "$lib/storage/pty";
  import {
    OFFERED_REPLIES,
    phaseOf,
    phraseKeys,
    replyLabel,
    type ThreadReply,
  } from "$lib/domain/awareness";
  import { approvals } from "$lib/features/approvals/store.svelte";
  import { DUR, easeOutQuint } from "$lib/theme/motion";
  import type { Thread } from "$lib/types";

  /**
   * The answers a blocked terminal takes, without walking to the machine.
   *
   * Drawn only for `waiting`, which is the one status that means a dialog is up
   * and nothing moves until a person answers. The vocabulary is the closed one
   * from `lib/domain/awareness`, and the machine that owns the PTY checks it
   * again on arrival: what is offered here is a convenience, not the bound.
   *
   * `compact` is the phone's terminal list, where the row already names the
   * thread and there is no width for a sentence.
   */
  type Props = { thread: Thread; compact?: boolean };
  let { thread, compact = false }: Props = $props();

  let sending = $state<ThreadReply | null>(null);

  const name = $derived(thread.title || thread.label);
  const hasApproval = $derived(
    approvals.items.some(
      (item) => item.source === "agent" && item.row.threadId === thread.id,
    ),
  );
  const phase = $derived(phaseOf(thread.status, !!thread.ptyId, hasApproval));
  const headline = $derived(
    t(phraseKeys(phase).headline, { thread: name }),
  );

  async function send(answer: ThreadReply) {
    if (sending) return;
    sending = answer;
    try {
      await threadReply(thread.id, answer, thread.origin);
    } catch (err) {
      // A refusal here is a thread whose process went away between the dot
      // saying `waiting` and the tap landing, which is exactly what the user
      // needs told rather than swallowed.
      logger.warn("reply", `${thread.id}: ${answer} was not delivered`, err);
      notifications.error(t("reply.failed", { thread: name }));
    } finally {
      sending = null;
    }
  }
</script>

<div
  class="flex items-center gap-2 rounded-lg border border-warning/40 bg-[var(--color-surface-2)] px-2 py-1.5 shadow-e2"
  class:flex-wrap={compact}
  role="group"
  aria-label={t("reply.aria", { thread: name })}
  in:fly={{ y: -8, duration: DUR.base, easing: easeOutQuint }}
>
  {#if !compact}
    <span class="max-w-56 truncate pl-0.5 text-2xs text-foreground/90">{headline}</span>
    <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
  {/if}

  {#each OFFERED_REPLIES as answer (answer)}
    <!-- 44px on the phone, where this is the only way to answer and a mistap
         sends a keystroke into a terminal. 32px beside a pane, where the same
         answer is one key away on a keyboard that is already there. -->
    <button
      type="button"
      class="shrink-0 rounded-md border border-border bg-[var(--color-surface)] px-2 text-xs text-foreground/90 transition hover:bg-[var(--color-surface-3)] disabled:opacity-40 {compact
        ? 'min-h-11 min-w-11'
        : 'min-h-8 min-w-8'}"
      disabled={sending !== null}
      onclick={() => void send(answer)}
    >
      {t(replyLabel(answer))}
    </button>
  {/each}
</div>
