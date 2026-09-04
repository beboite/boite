<script lang="ts">
  /**
   * A pilot thread, drawn.
   *
   * Three parts and nothing else: the header with the status and the chip, the
   * timeline, the composer. Git, explorer, editor and terminal are panes to
   * open beside it, which is the point of a thread with no shell of its own.
   *
   * The header and the composer draw the same `ModelPicker`, one compact and
   * one not: what a thread is running on is the thing a chat pane is switched
   * on for, and two components saying it would be two things to keep matching.
   *
   * Behind `import()` from `PaneContentView`, so none of this is in the graph
   * the window fetches before it can paint: a boite with the experiment off
   * never downloads the chunk at all.
   */
  import { onDestroy } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { backend } from "$lib/backend";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { paneStore } from "$lib/features/panes/store.svelte";
  import { threadCwd } from "$lib/features/thread/cwd";
  import { log } from "$lib/shared/log";
  import { t } from "$lib/i18n/index.svelte";
  import Composer from "./Composer.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import Timeline from "./Timeline.svelte";
  import { shortSession } from "./present";
  import { openPilotSession, pilotSessionOpenedHere } from "./session";
  import { load, pilotThread, release } from "./store.svelte";
  import type { PilotCatalog } from "./types";
  import Copy from "@lucide/svelte/icons/copy";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import X from "@lucide/svelte/icons/x";

  type Props = { threadId: string; projectId: string; paneId: string };
  let { threadId, projectId, paneId }: Props = $props();

  let catalog = $state<PilotCatalog | null>(null);
  let opening = $state(false);
  /** True until the first read of the timeline has come back. */
  let loading = $state(true);

  const thread = $derived(app.threadById(threadId));
  const view = $derived(pilotThread(threadId));
  const project = $derived(app.projectById(projectId));
  const repoPath = $derived(thread ? threadCwd(thread, project) : null);

  const STATUS = {
    busy: "pilot.statusBusy",
    waiting: "pilot.statusWaiting",
    idle: "pilot.statusIdle",
  } as const;

  /**
   * The eight characters that tell one session from another.
   *
   * A uuid at full length is a line of its own in a header that has three other
   * things to say, and nobody reads one; the copy button is what makes the
   * short form enough.
   */
  const short = $derived(shortSession(view.nativeSessionId));

  const instanceName = $derived.by(() => {
    const raw = thread?.pilotInstance;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { type?: string; provider?: string; model?: string };
      return parsed.type === "fastpick"
        ? `fastpick:${parsed.provider}:${parsed.model}`
        : "native";
    } catch {
      return raw;
    }
  });

  const mode = $derived.by(() => {
    const raw = thread?.pilotOptions;
    if (!raw) return view.mode;
    try {
      const parsed = JSON.parse(raw) as { mode?: string };
      return parsed.mode === "yolo" || parsed.mode === "edit_alone" || parsed.mode === "ask"
        ? parsed.mode
        : view.mode;
    } catch {
      return view.mode;
    }
  });

  const driver = $derived(thread?.pilotDriver ?? "claude");
  const model = $derived(view.model ?? thread?.pilotModel ?? null);
  /**
   * The branch this thread's worktree is standing on, when it is on one.
   *
   * Asked once per mount and only for a thread that has a worktree of its own:
   * `worktree.list` spawns git, and the header is not worth a poll. Boite opens
   * every worktree detached, so the usual answer is null and the header draws
   * nothing rather than a placeholder saying so.
   */
  let branch = $state<string | null>(null);
  /** A fresh thread: a session is up and nothing has been said in it. */
  const fresh = $derived(!loading && view.items.length === 0 && view.nativeSessionId !== null);

  // The timeline first, then the catalog: one is what the pane is for and the
  // other only fills a menu nobody has opened yet.
  $effect(() => {
    void load(threadId).finally(() => {
      loading = false;
    });
  });

  $effect(() => {
    const own = thread?.worktreePath;
    const repo = project?.cwd;
    if (!own || !repo) return;
    void backend()
      .worktree.list(repo)
      .then((entries) => {
        branch = entries.find((entry) => entry.path === own)?.branch ?? null;
      })
      .catch(() => {
        // A repository git refused to describe is not worth a line in a header.
      });
  });

  $effect(() => {
    void backend()
      .pilot.catalog()
      .then((answer) => {
        catalog = answer;
      })
      .catch((err: unknown) => {
        log.warn("pilot.pane", "pilot.catalog.failed", {
          thread: threadId,
          reason: String(err),
        });
      });
  });

  /**
   * A row whose session is not running gets it back when its pane opens.
   *
   * Which is what "open the thread" means for a chat thread: the child is gone
   * after an auto-sleep, a stop or a restart, and the conversation is not.
   * `pilot.open` resumes off the native id the row kept, so the timeline
   * already on screen goes on rather than starting again.
   *
   * Guarded four ways, because `Runtime::open` stops whatever it finds first:
   * once per mount, never on a row this window already opened (a launch does it
   * before the pane exists), never when this pane has already seen a session
   * start, and never while the row is mid-turn. Without those, mounting a pane
   * would kill the child answering in it.
   */
  let resumed = false;
  $effect(() => {
    if (resumed) return;
    const row = app.threadById(threadId);
    if (!row || row.runtime !== "pilot") return;
    if (pilotSessionOpenedHere(threadId) || view.nativeSessionId) return;
    if (row.status === "running" || row.status === "waiting") return;
    resumed = true;
    void openSession();
  });

  // The host keeps pushing at a device that asked for a thread until it says
  // otherwise, so a pane that goes has to say so.
  onDestroy(() => release(threadId));

  async function openSession() {
    if (opening) return;
    opening = true;
    try {
      await openPilotSession(threadId);
    } finally {
      opening = false;
    }
  }

  async function copySession() {
    if (!view.nativeSessionId) return;
    try {
      await navigator.clipboard.writeText(view.nativeSessionId);
      notifications.success(t("pilot.sessionCopied"));
    } catch {
      // A clipboard the browser refused is not worth a toast of its own.
    }
  }
</script>

<div
  class="flex h-full min-h-0 flex-col bg-[var(--color-background)]"
  data-testid="chat-pane"
  data-thread={threadId}
>
  <header
    class="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-[var(--color-titlebar)] px-2"
  >
    <ModelPicker
      {threadId}
      {catalog}
      {driver}
      instance={instanceName}
      {model}
      {mode}
      compact
      placement="down"
      align="left"
    />

    <!-- The status pill: one word, and the colour that says whether it is the
         thread's turn or the user's. `waiting` is the app's warning, which is
         the only one of the three worth catching an eye across a workspace. -->
    <span
      class="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs {view.status ===
      'waiting'
        ? 'bg-[var(--color-surface)] text-[var(--color-warning)]'
        : 'text-muted-foreground'}"
      data-testid="chat-status"
      data-status={view.status}
    >
      <span
        class="size-1.5 rounded-full {view.status === 'busy'
          ? 'pilot-breathe bg-[var(--color-muted-foreground)]'
          : view.status === 'waiting'
            ? 'bg-[var(--color-warning)]'
            : 'bg-[var(--color-success)]'}"
        aria-hidden="true"
      ></span>
      {t(STATUS[view.status])}
    </span>

    {#if short}
      <button
        type="button"
        class="press flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground focus:outline-none focus-visible:focus-ring"
        onclick={() => void copySession()}
        aria-label={t("pilot.copySession")}
        data-testid="chat-session"
        data-session={view.nativeSessionId}
      >
        <span class="font-mono">{short}</span>
        <Copy class="size-3" />
      </button>
    {:else}
      <span class="shrink-0 text-xs text-muted-foreground" data-testid="chat-no-session">
        {t("pilot.noSession")}
      </span>
    {/if}

    {#if branch}
      <span
        class="hidden min-w-0 shrink items-center gap-1 text-xs text-muted-foreground sm:flex"
        title={branch}
      >
        <GitBranch class="size-3 shrink-0" />
        <span class="min-w-0 truncate font-mono">{branch}</span>
      </span>
    {/if}

    <button
      type="button"
      class="press ml-auto shrink-0 rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground focus:outline-none focus-visible:focus-ring"
      onclick={() => paneStore.closePane(paneId)}
      aria-label={t("pilot.close")}
      data-testid="chat-close"
    >
      <X class="size-3.5" />
    </button>
  </header>

  {#if loading}
    <!-- A skeleton rather than a spinner on a blank page: the shape of what is
         coming is worth more than a wheel, and a thread of two thousand rows
         takes several pages to read back. -->
    <div class="min-h-0 flex-1 px-3 py-3" aria-label={t("common.loading")} aria-busy="true">
      <div class="mx-auto flex w-full max-w-[72ch] flex-col gap-3">
        <div class="pilot-skeleton h-4 w-2/5 self-end rounded-full"></div>
        <div class="pilot-skeleton h-3 w-full rounded-full"></div>
        <div class="pilot-skeleton h-3 w-4/5 rounded-full"></div>
        <div class="pilot-skeleton h-8 w-full rounded-lg"></div>
        <div class="pilot-skeleton h-3 w-3/5 rounded-full"></div>
      </div>
    </div>
  {:else if fresh}
    <!-- A fresh thread opens on the one choice that matters, large, with the
         composer already able to take a line. -->
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6">
      <ModelPicker
        {threadId}
        {catalog}
        {driver}
        instance={instanceName}
        {model}
        {mode}
        placement="down"
        align="left"
      />
      <p class="max-w-[42ch] text-center text-sm text-muted-foreground">{t("pilot.empty")}</p>
    </div>
  {:else}
    <Timeline {threadId} items={view.items} {repoPath} {projectId} status={view.status} />
  {/if}

  <Composer
    {threadId}
    status={view.status}
    open={view.nativeSessionId !== null}
    onOpen={() => void openSession()}
    commands={view.slashCommands}
    {catalog}
    {driver}
    instance={instanceName}
    {model}
    {mode}
  />
</div>

<style>
  /* A soft pulse rather than a spinner: the pane already says "Working", and a
     dot that breathes is the half of that a reader catches out of the corner of
     an eye. */
  .pilot-breathe {
    animation: pilot-breathe 1.8s var(--ease-in-out-quad) infinite;
  }
  @keyframes pilot-breathe {
    50% {
      opacity: 0.3;
    }
  }
  .pilot-skeleton {
    background: var(--color-surface-2);
    animation: pilot-breathe 1.4s var(--ease-in-out-quad) infinite;
  }
  :global(html[data-motion="reduced"]) .pilot-breathe,
  :global(html[data-motion="reduced"]) .pilot-skeleton {
    animation: none;
  }
</style>
