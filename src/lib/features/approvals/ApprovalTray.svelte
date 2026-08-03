<script lang="ts">
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { app } from "$lib/app/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { approvals } from "./store.svelte";

  // Bottom-left, opposite the toasts. These are not notifications: a toast says
  // what happened and leaves, and one of these waits for an answer, so putting
  // them in the same corner would mean an agent's request sliding away under a
  // stack of finished ones.
  const mobile = $derived(settings.state.mobileLayout);

  const projectName = (id: string) =>
    app.projects.find((p) => p.id === id)?.name ?? id;

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
</script>

{#if approvals.pending.length > 0}
  <div
    class="tray fixed z-[var(--z-toast)] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1.5"
    class:tray-top={mobile}
  >
    {#each approvals.pending as item (item.id)}
      <div
        class="card"
        animate:flip={{ duration: 150 }}
        transition:fly={{ y: mobile ? -8 : 8, duration: 150 }}
        role="alertdialog"
        aria-label={t("approval.title")}
      >
        <p class="who">
          {threadName(item.threadId)}
          <span class="where">{projectName(item.projectId)}</span>
        </p>
        <p class="what">{sentence(item.action, item.detail)}</p>
        <div class="row">
          <button
            type="button"
            class="btn refuse"
            disabled={approvals.deciding.includes(item.id)}
            onclick={() => approvals.decide(item.id, false)}
          >
            {t("approval.refuse")}
          </button>
          <button
            type="button"
            class="btn allow"
            disabled={approvals.deciding.includes(item.id)}
            onclick={() => approvals.decide(item.id, true)}
          >
            {t("approval.allow")}
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .tray {
    left: 1rem;
    bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
  }
  .tray.tray-top {
    bottom: auto;
    top: calc(1rem + env(safe-area-inset-top, 0px));
  }
  .card {
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-elevated, var(--bg));
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
    padding: 0.625rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .who {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text);
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .where {
    font-weight: 400;
    color: var(--text-muted);
  }
  .what {
    font-size: 0.8125rem;
    color: var(--text);
    line-height: 1.35;
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 0.375rem;
  }
  .btn {
    font-size: 0.75rem;
    padding: 0.25rem 0.625rem;
    border-radius: 0.375rem;
    border: 1px solid var(--border);
    color: var(--text);
  }
  .btn:disabled {
    opacity: 0.5;
  }
  .btn.allow {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg, #fff);
  }
  .btn:hover:not(:disabled) {
    filter: brightness(1.1);
  }
</style>
