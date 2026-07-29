<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { DUR, easeOutQuint, easeSpring } from "$lib/theme/motion";
  import { todoAnnouncer } from "./announce.svelte";
  import type { TodoChange } from "./diff";
  import { t } from "$lib/i18n/index.svelte";
  import type { MessageKey } from "$lib/i18n/messages";
  import Check from "@lucide/svelte/icons/check";
  import Plus from "@lucide/svelte/icons/plus";
  import HandHeart from "@lucide/svelte/icons/hand-heart";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  /**
   * The card that appears when an agent changes the todo list.
   *
   * A toast would have been the obvious place and the wrong one: a toast is the
   * app talking about itself, in a corner, at 11px. This is the other thing
   * happening in the room — an agent has finished something and is waiting on
   * you — and it gets the middle of the window for two seconds and then leaves.
   *
   * Spring on the way in, plain fade on the way out. Something arriving is
   * allowed to overshoot; something leaving that bounced would be asking to be
   * looked at again on its way out.
   */
  const current = $derived(todoAnnouncer.current);

  const TONE: Record<TodoChange, { key: MessageKey; color: string }> = {
    claimed: { key: "todo.announceClaimed", color: "var(--color-warning)" },
    done: { key: "todo.announceDone", color: "var(--color-success)" },
    added: { key: "todo.announceAdded", color: "var(--color-awake)" },
    reopened: { key: "todo.announceReopened", color: "var(--color-muted-foreground)" },
    removed: { key: "todo.announceRemoved", color: "var(--color-muted-foreground)" },
  };
</script>

{#if current}
  <!-- Keyed on the announcement rather than on the todo: the same card changing
       twice has to play twice, and reusing the element would leave the second
       change sharing the first one's timer and transition. -->
  {#key current.key}
    <div
      class="wrap"
      transition:fade={{ duration: DUR.base, easing: easeOutQuint }}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        class="card"
        style:--tone={TONE[current.change].color}
        in:scale={{
          start: 0.9,
          duration: DUR.celebrate,
          easing: easeSpring,
          opacity: 0,
        }}
        onclick={() => todoAnnouncer.dismiss()}
      >
        <span class="badge">
          {#if current.change === "claimed"}
            <HandHeart class="size-[18px]" />
          {:else if current.change === "done"}
            <Check class="size-[18px]" />
          {:else if current.change === "added"}
            <Plus class="size-[18px]" />
          {:else if current.change === "reopened"}
            <RotateCcw class="size-[18px]" />
          {:else}
            <Trash2 class="size-[18px]" />
          {/if}
        </span>
        <span class="min-w-0 text-left">
          <span class="block text-2xs font-semibold uppercase tracking-[0.14em]">
            {t(TONE[current.change].key)}
          </span>
          <span class="block truncate text-md font-medium text-foreground">
            {current.todo.title}
          </span>
          {#if current.change === "claimed" && current.todo.claimedBy}
            <span class="block truncate text-xs text-muted-foreground">
              {t("todo.announceBy", { agent: current.todo.claimedBy })}
            </span>
          {/if}
        </span>
      </button>
    </div>
  {/key}
{/if}

<style>
  /* Above the panes and below the confirm dialog: this is news, and news must
     not sit on top of a question the user is being asked. */
  .wrap {
    position: absolute;
    top: 18%;
    left: 50%;
    transform: translateX(-50%);
    z-index: 40;
    pointer-events: none;
    display: flex;
    justify-content: center;
  }
  .card {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: min(460px, 70vw);
    padding: 14px 22px 14px 16px;
    border: 1px solid color-mix(in srgb, var(--tone) 35%, var(--color-border));
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--color-surface-2) 92%, var(--tone));
    box-shadow:
      var(--shadow-e4),
      0 0 24px -6px color-mix(in srgb, var(--tone) 40%, transparent);
    backdrop-filter: blur(10px);
    text-align: left;
    cursor: pointer;
  }
  .badge {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--tone) 18%, transparent);
    color: var(--tone);
  }
  .card :global(.uppercase) {
    color: var(--tone);
  }
</style>
