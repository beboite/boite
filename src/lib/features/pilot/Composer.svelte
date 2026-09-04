<script lang="ts">
  /**
   * What the user says, and the one key that stops a turn.
   *
   * The decision is `keys.ts` and has no DOM in it; what is here is the textarea
   * and the two calls. Sending during a turn calls `startTurn` exactly as it
   * does when the thread is idle: the backend steers a turn already in flight,
   * so a composer that queued would be a second idea of the conversation kept
   * somewhere the timeline cannot see it.
   */
  import { backend } from "$lib/backend";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { log } from "$lib/shared/log";
  import { t } from "$lib/i18n/index.svelte";
  import { composerAction } from "./keys";
  import type { PilotStatus } from "./types";

  type Props = {
    threadId: string;
    status: PilotStatus;
    /** False until `session.started` has named a native session. */
    open: boolean;
    onOpen: () => void;
  };
  let { threadId, status, open, onOpen }: Props = $props();

  let text = $state("");
  let sending = $state(false);
  let box: HTMLTextAreaElement | null = $state(null);

  async function send() {
    const line = text.trim();
    if (!line || sending) return;
    // Cleared before the call, not after: the round trip is a turn's worth of
    // latency and a box that stays full invites a second Enter.
    text = "";
    sending = true;
    try {
      await backend().pilot.startTurn(threadId, line);
    } catch (err) {
      log.warn("pilot.composer", "pilot.startTurn.failed", {
        thread: threadId,
        reason: String(err),
      });
      notifications.error(t("pilot.sendFailed"));
      text = line;
    } finally {
      sending = false;
    }
  }

  async function interrupt() {
    try {
      await backend().pilot.interrupt(threadId);
    } catch (err) {
      log.warn("pilot.composer", "pilot.interrupt.failed", {
        thread: threadId,
        reason: String(err),
      });
    }
  }

  function onKeydown(event: KeyboardEvent) {
    const decided = composerAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        composing: event.isComposing,
      },
      text,
      status,
    );
    if (decided.kind === "insert") return;
    event.preventDefault();
    // Escape is also the overlay stack's key, so a turn being interrupted must
    // not also close whatever is open over the pane.
    event.stopPropagation();
    if (decided.kind === "send") void send();
    else void interrupt();
  }

  /** Grows with the text, up to a third of the pane. */
  function grow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }

  $effect(() => {
    void text;
    if (box) grow(box);
  });
</script>

<div class="shrink-0 border-t border-border bg-[var(--color-surface)] px-3 py-2">
  {#if !open}
    <!-- A session that is not up is not a box to type into: the sentence says
         why and the button is the way back, which is the reverse state the
         "way in needs a way out" rule asks for. -->
    <div class="flex items-center gap-2">
      <p class="min-w-0 flex-1 text-sm text-muted-foreground">{t("pilot.sessionClosed")}</p>
      <button
        type="button"
        class="shrink-0 rounded-md border border-edge bg-[var(--color-surface-2)] px-2.5 py-1 text-sm text-foreground transition hover:bg-[var(--color-surface-3)]"
        onclick={onOpen}
        data-testid="chat-open-session"
      >
        {t("pilot.openSession")}
      </button>
    </div>
  {:else}
    <div class="flex items-end gap-2">
      <textarea
        bind:this={box}
        bind:value={text}
        onkeydown={onKeydown}
        rows="1"
        class="min-h-0 min-w-0 flex-1 resize-none rounded-md border border-edge bg-[var(--color-surface-2)] px-2.5 py-1.5 text-sm text-foreground outline-none transition focus:border-foreground/30"
        placeholder={t("pilot.placeholder")}
        aria-label={t("pilot.placeholder")}
        data-testid="chat-input"
      ></textarea>
      {#if status === "busy"}
        <button
          type="button"
          class="shrink-0 rounded-md border border-edge bg-[var(--color-surface-2)] px-2.5 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
          onclick={() => void interrupt()}
        >
          {t("pilot.interrupt")}
        </button>
      {/if}
      <button
        type="button"
        class="shrink-0 rounded-md bg-foreground px-2.5 py-1.5 text-sm font-medium text-background transition hover:bg-foreground/90 disabled:opacity-50"
        disabled={sending || text.trim().length === 0}
        onclick={() => void send()}
        data-testid="chat-send"
      >
        {t("pilot.send")}
      </button>
    </div>
  {/if}
</div>
