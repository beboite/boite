<script lang="ts">
  /**
   * A pilot thread, drawn.
   *
   * Three parts and nothing else: the header with the status and the picker,
   * the timeline, the composer. Git, explorer, editor and terminal are panes to
   * open beside it, which is the point of a thread with no shell of its own.
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
  import { openPilotSession, pilotSessionOpenedHere } from "./session";
  import { load, pilotThread, release } from "./store.svelte";
  import type { PilotCatalog } from "./types";
  import Copy from "@lucide/svelte/icons/copy";
  import X from "@lucide/svelte/icons/x";

  type Props = { threadId: string; projectId: string; paneId: string };
  let { threadId, projectId, paneId }: Props = $props();

  let catalog = $state<PilotCatalog | null>(null);
  let opening = $state(false);

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
  const shortSession = $derived(
    view.nativeSessionId ? view.nativeSessionId.slice(0, 8) : null,
  );

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

  // The timeline first, then the catalog: one is what the pane is for and the
  // other only fills a menu nobody has opened yet.
  $effect(() => {
    void load(threadId);
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

<div class="flex h-full min-h-0 flex-col bg-[var(--color-background)]">
  <header
    class="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-[var(--color-titlebar)] px-2"
  >
    <span class="min-w-0 truncate text-xs font-medium text-foreground">
      {thread?.title ?? thread?.label ?? ""}
    </span>
    <span class="shrink-0 text-xs text-muted-foreground">{t(STATUS[view.status])}</span>
    {#if shortSession}
      <button
        type="button"
        class="flex shrink-0 items-center gap-1 rounded px-1 text-xs text-muted-2 transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
        onclick={() => void copySession()}
        aria-label={t("pilot.copySession")}
      >
        <span class="font-mono">{shortSession}</span>
        <Copy class="size-3" />
      </button>
    {:else}
      <span class="shrink-0 text-xs text-muted-2">{t("pilot.noSession")}</span>
    {/if}
    <div class="ml-auto flex shrink-0 items-center gap-1">
      <ModelPicker
        {threadId}
        {catalog}
        driver={thread?.pilotDriver ?? "claude"}
        instance={instanceName}
        model={view.model ?? thread?.pilotModel ?? null}
        {mode}
      />
      <button
        type="button"
        class="rounded p-0.5 text-muted-2 transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
        onclick={() => paneStore.closePane(paneId)}
        aria-label={t("pilot.close")}
      >
        <X class="size-3.5" />
      </button>
    </div>
  </header>

  <Timeline {threadId} items={view.items} {repoPath} {projectId} />

  <Composer
    {threadId}
    status={view.status}
    open={view.nativeSessionId !== null}
    onOpen={() => void openSession()}
  />
</div>
