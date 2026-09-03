<script lang="ts">
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import { app } from "$lib/app/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { DUR, easeOutQuint } from "$lib/theme/motion";
  import { approvals, MAX_VISIBLE, type ApprovalItem } from "./store.svelte";

  // Bottom centre, arriving from off-screen. The corners are taken: toasts own
  // the right one and the keyboard FAB the left, and both of those are things
  // that leave on their own. These do not leave until they are answered, so
  // they get the one place nothing else is parked and the one entrance that
  // reads as "this is waiting for you" rather than "this happened".
  //
  // The phone keeps the top instead: the bottom of that screen is the key bar
  // and the FAB, and a card sitting on them swallows every tap meant for the
  // only way to raise the keyboard.
  const mobile = $derived(settings.state.mobileLayout);

  const shown = $derived(approvals.items.slice(0, MAX_VISIBLE));
  const hidden = $derived(Math.max(0, approvals.items.length - shown.length));

  // Through the index, never `projects.find`. See `.claude/rules/performance.md`.
  const projectName = (id: string) => app.projectById(id)?.name ?? id;

  const threadName = (id: string) => {
    const thread = app.threadById(id);
    return thread?.title || thread?.label || id.slice(0, 8);
  };

  // Spelled out rather than built into a key, so a message the dictionary does
  // not have cannot be produced. An action this build has never heard of still
  // draws a card: the user has to answer it either way, and a request nobody
  // can see is worse than one worded generically.
  const ACTIONS = {
    "thread.move": "approval.action.thread.move",
    "project.create": "approval.action.project.create",
    "thread.spawn": "approval.action.thread.spawn",
  } as const;

  const sentence = (action: string, detail: string) => {
    const key = ACTIONS[action as keyof typeof ACTIONS];
    return key ? t(key, { detail }) : t("approval.action.other", { action, detail });
  };

  /** The words a card shows, from whichever half of the store it came from. */
  function view(item: ApprovalItem) {
    if (item.source === "agent") {
      return {
        title: threadName(item.row.threadId),
        where: projectName(item.row.projectId),
        message: sentence(item.row.action, item.row.detail),
        // Only an agent is told its call is queued rather than refused, so
        // only an agent card explains that nothing is stuck behind this.
        note: t("approval.agentNote"),
        tone: "normal" as const,
        allowLabel: t("approval.allow"),
        refuseLabel: t("approval.refuse"),
      };
    }
    return {
      title: item.ask.title,
      where: item.ask.where ?? "",
      message: item.ask.message,
      note: "",
      tone: item.ask.tone ?? ("normal" as const),
      allowLabel: item.ask.allowLabel ?? t("approval.allow"),
      refuseLabel: item.ask.refuseLabel ?? t("approval.refuse"),
    };
  }
</script>

{#if approvals.items.length > 0}
  <div
    class="dock pointer-events-none fixed z-[var(--z-toast)] flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2"
    class:dock-top={mobile}
    role="region"
    aria-label={t("approval.title")}
  >
    {#if approvals.items.length > 1}
      <!-- Only worth a row when there is a queue: one card answers itself. -->
      <div
        class="pointer-events-auto flex items-center justify-between gap-3 self-stretch px-1"
        transition:fly={{ y: mobile ? -12 : 12, duration: DUR.base, easing: easeOutQuint }}
      >
        <span class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("approval.waitingCount", { count: String(approvals.items.length) })}
        </span>
        <button
          type="button"
          class="rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition hover:bg-[var(--color-surface-3)] hover:text-foreground"
          onclick={() => void approvals.decideAll(true)}
        >
          {t("approval.allowAll")}
        </button>
      </div>
    {/if}

    {#each shown as item (item.id)}
      {@const card = view(item)}
      <div
        class="surface-dialog pointer-events-auto overflow-hidden"
        animate:flip={{ duration: DUR.base }}
        in:fly={{ y: mobile ? -24 : 24, duration: DUR.slow, easing: easeOutQuint }}
        out:fly={{ y: mobile ? -12 : 12, duration: DUR.base, easing: easeOutQuint }}
        role="alertdialog"
        aria-label={card.title}
      >
        <div class="flex gap-3 px-4 pb-3 pt-3.5">
          <span
            class="mt-px flex size-7 shrink-0 items-center justify-center rounded-full border {card.tone ===
            'danger'
              ? 'border-danger/40 bg-danger/10 text-danger'
              : 'border-border bg-[var(--color-surface-2)] text-muted-foreground'}"
          >
            <ShieldAlert class="size-3.5" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="flex items-baseline justify-between gap-2">
              <span class="truncate text-xs font-semibold text-foreground">{card.title}</span>
              {#if card.where}
                <span class="shrink-0 text-xs text-muted-foreground">{card.where}</span>
              {/if}
            </p>
            <p class="mt-1 text-sm leading-relaxed text-foreground">{card.message}</p>
            {#if card.note}
              <p class="mt-1.5 text-xs leading-snug text-muted-foreground">{card.note}</p>
            {/if}
          </div>
        </div>
        <footer
          class="flex justify-end gap-2 border-t border-border bg-[var(--color-titlebar)] px-4 py-2.5"
        >
          <button
            type="button"
            class="rounded-md border border-edge bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:opacity-50"
            disabled={approvals.deciding.includes(item.id)}
            onclick={() => void approvals.decide(item.id, false)}
          >
            {card.refuseLabel}
          </button>
          <button
            type="button"
            class="rounded-md px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 {card.tone ===
            'danger'
              ? 'bg-danger text-white hover:bg-danger/90'
              : 'bg-foreground text-background hover:bg-foreground/90'}"
            disabled={approvals.deciding.includes(item.id)}
            onclick={() => void approvals.decide(item.id, true)}
          >
            {card.allowLabel}
          </button>
        </footer>
      </div>
    {/each}

    {#if hidden > 0}
      <!-- Said rather than stacked: forty cards cover the window they are
           asking about, and answering one uncovers the next. -->
      <p class="pointer-events-none text-center text-xs text-muted-foreground">
        {t("approval.more", { count: String(hidden) })}
      </p>
    {/if}
  </div>
{/if}

<style>
  .dock {
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
  }
  /* Under the phone's top bar rather than over it: that bar is 3rem tall, it
     carries the project name and the two launch buttons, and a card parked on
     top of them hid what the request was about while asking about it. */
  .dock.dock-top {
    bottom: auto;
    top: calc(3.5rem + env(safe-area-inset-top, 0px));
  }
</style>
