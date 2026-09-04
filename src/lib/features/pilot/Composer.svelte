<script lang="ts">
  /**
   * What the user says, and everything they can change about who answers it.
   *
   * One rounded surface: the box on top, then a row carrying the model chip,
   * the effort and the mode on the left and the send on the right. The
   * decisions are `keys.ts` and `slash.ts` and have no DOM in them; what is
   * here is the textarea, the growth, and the two calls.
   *
   * Sending during a turn calls `startTurn` exactly as it does when the thread
   * is idle: the backend steers a turn already in flight, so a composer that
   * queued would be a second idea of the conversation kept somewhere the
   * timeline cannot see it. The line above the row says so, quietly and in
   * place, because a modal asking "steer or queue?" is a question the backend
   * already answered.
   *
   * The send button stays drawn while a turn runs rather than being replaced:
   * steering is exactly what it does then, and the stop takes the primary slot
   * beside it. A composer whose only button became Stop would make steering a
   * keyboard-only feature, which is the phone with no way in.
   */
  import { backend } from "$lib/backend";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { log } from "$lib/shared/log";
  import { t } from "$lib/i18n/index.svelte";
  import { composerAction } from "./keys";
  import ModelPicker from "./ModelPicker.svelte";
  import { applyHint, moveHint, slashHints } from "./slash";
  import type { PilotCatalog, PilotExecMode, PilotStatus } from "./types";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Square from "@lucide/svelte/icons/square";

  type Props = {
    threadId: string;
    status: PilotStatus;
    /** False until `session.started` has named a native session. */
    open: boolean;
    onOpen: () => void;
    /** The commands the driver declared at init, for the hint row. */
    commands: readonly string[];
    catalog: PilotCatalog | null;
    driver: string;
    instance: string | null;
    model: string | null;
    mode: PilotExecMode;
  };
  let {
    threadId,
    status,
    open,
    onOpen,
    commands,
    catalog,
    driver,
    instance,
    model,
    mode,
  }: Props = $props();

  let text = $state("");
  let sending = $state(false);
  let box: HTMLTextAreaElement | null = $state(null);
  let pickerOpen = $state(false);
  let hintAt = $state(0);
  /** The last line actually sent, which is what Ctrl+Up puts back. */
  let lastSent = $state("");

  const hints = $derived(slashHints(text, commands));
  const busy = $derived(status === "busy");

  /** One line at rest, six at most, then the box scrolls. */
  const MAX_ROWS = 6;
  const LINE = 20;
  const PADDING = 16;

  async function send() {
    const line = text.trim();
    if (!line || sending) return;
    // Cleared before the call, not after: the round trip is a turn's worth of
    // latency and a box that stays full invites a second Enter.
    text = "";
    lastSent = line;
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

  function takeHint(at = hintAt) {
    const name = hints[at];
    if (!name) return;
    text = applyHint(name);
    hintAt = 0;
    box?.focus();
  }

  function onKeydown(event: KeyboardEvent) {
    const decided = composerAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        composing: event.isComposing,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      },
      text,
      status,
      hints.length > 0,
    );
    if (decided.kind === "insert") return;
    event.preventDefault();
    // Escape is also the overlay stack's key, so a turn being interrupted must
    // not also close whatever is open over the pane.
    event.stopPropagation();
    switch (decided.kind) {
      case "send":
        void send();
        break;
      case "interrupt":
        void interrupt();
        break;
      case "picker":
        pickerOpen = true;
        break;
      case "recall":
        if (lastSent) text = lastSent;
        break;
      case "hint":
        takeHint();
        break;
      case "hintMove":
        hintAt = moveHint(hintAt, decided.move, hints.length);
        break;
    }
  }

  /** Grows with the text, to six rows, then scrolls. */
  function grow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS * LINE + PADDING)}px`;
  }

  $effect(() => {
    void text;
    if (box) grow(box);
  });

  // A list that shrank under the cursor would leave Tab taking nothing.
  $effect(() => {
    if (hintAt >= hints.length) hintAt = 0;
  });
</script>

<div class="shrink-0 border-t border-border bg-[var(--color-background)] px-3 pt-2 pb-3">
  {#if !open}
    <!-- A session that is not up is not a box to type into: the sentence says
         why and the button is the way back, which is the reverse state the
         "way in needs a way out" rule asks for. -->
    <div
      class="flex items-center gap-2 rounded-xl border border-border bg-[var(--color-surface)] px-3 py-2.5"
    >
      <p class="min-w-0 flex-1 text-sm text-muted-foreground">{t("pilot.sessionClosed")}</p>
      <button
        type="button"
        class="press shrink-0 rounded-md bg-[var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[var(--color-background)] transition focus:outline-none focus-visible:focus-ring"
        onclick={onOpen}
        data-testid="chat-open-session"
      >
        {t("pilot.openSession")}
      </button>
    </div>
  {:else}
    <div class="mx-auto w-full max-w-[72ch]">
      {#if busy}
        <!-- In place and quiet: the backend steers, and a modal asking about it
             would be a question already answered. -->
        <p class="px-1 pb-1 text-xs text-muted-foreground" data-testid="chat-steering">
          {t("pilot.steering")}
        </p>
      {/if}

      {#if hints.length > 0}
        <ul
          class="pilot-rise mb-1 flex flex-wrap gap-1 rounded-lg border border-border bg-[var(--color-surface-2)] p-1.5"
          aria-label={t("pilot.slashCommands")}
          data-testid="chat-slash-hints"
        >
          {#each hints as name, at (name)}
            <li>
              <button
                type="button"
                class="press rounded px-2 py-0.5 font-mono text-xs transition focus:outline-none focus-visible:focus-ring-inset {at ===
                hintAt
                  ? 'bg-[var(--color-surface-3)] text-foreground'
                  : 'text-muted-foreground hover:text-foreground'}"
                onclick={() => takeHint(at)}
                onpointerenter={() => (hintAt = at)}
              >
                /{name}
              </button>
            </li>
          {/each}
          <li class="ml-auto self-center px-1 text-xs text-muted-foreground">
            {t("pilot.slashTab")}
          </li>
        </ul>
      {/if}

      <div
        class="flex flex-col gap-1.5 rounded-xl border border-border bg-[var(--color-surface)] px-2 pt-2 pb-1.5 transition focus-within:border-edge"
      >
        <textarea
          bind:this={box}
          bind:value={text}
          onkeydown={onKeydown}
          rows="1"
          class="max-h-[136px] min-h-0 w-full resize-none bg-transparent px-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          placeholder={t("pilot.placeholder")}
          aria-label={t("pilot.placeholder")}
          data-testid="chat-input"
        ></textarea>

        <div class="flex items-center gap-1.5">
          <ModelPicker
            {threadId}
            {catalog}
            {driver}
            {instance}
            {model}
            {mode}
            placement="up"
            align="left"
            bind:open={pickerOpen}
          />
          <div class="ml-auto flex shrink-0 items-center gap-1.5">
            {#if busy}
              <button
                type="button"
                class="press flex size-7 items-center justify-center rounded-full bg-[var(--color-surface-3)] text-foreground transition hover:bg-[var(--color-surface-2)] focus:outline-none focus-visible:focus-ring"
                onclick={() => void interrupt()}
                aria-label={t("pilot.stop")}
                title={t("pilot.stopHint")}
                data-testid="chat-stop"
              >
                <Square class="size-3 fill-current" />
              </button>
            {/if}
            <button
              type="button"
              class="press flex size-7 items-center justify-center rounded-full bg-[var(--color-foreground)] text-[var(--color-background)] transition focus:outline-none focus-visible:focus-ring disabled:opacity-40"
              disabled={sending || text.trim().length === 0}
              onclick={() => void send()}
              aria-label={busy ? t("pilot.sendSteer") : t("pilot.send")}
              title={busy ? t("pilot.sendSteer") : t("pilot.send")}
              data-testid="chat-send"
            >
              <ArrowUp class="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .pilot-rise {
    animation: pilot-rise var(--dur-2) var(--ease-out-quint);
  }
  @keyframes pilot-rise {
    from {
      opacity: 0;
      transform: translateY(3px);
    }
  }
  :global(html[data-motion="reduced"]) .pilot-rise {
    animation: none;
  }
</style>
