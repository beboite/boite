<script lang="ts">
  /**
   * A chat thread's items, oldest first, grouped into turns by what they are.
   *
   * Two things it is careful about, and both are budget lines in
   * `docs/pilot.md`. It draws the rows the viewport can see and nothing else,
   * because a two thousand item thread is two thousand bordered cards; and it
   * follows the bottom only while the user has not scrolled up, because a
   * timeline that jumps under a reader is a long thread nobody can read while
   * the agent is talking.
   *
   * The arithmetic is `virtual.ts` and the per-row decisions are `present.ts`,
   * neither of which has a DOM in it. What is here is the three things a
   * browser has to answer: how tall a row turned out to be, where the container
   * is scrolled to, and whether the tail is on screen.
   *
   * The column is capped at 72ch and centred, which is the width a paragraph is
   * read at; the rows that are not prose (tool calls, the footer, file chips)
   * share it so the eye has one left edge to come back to. The user's own line
   * is the one thing that leaves it, right-aligned as a bubble, which is what
   * makes a long thread scannable without an avatar per row.
   */
  import { editorStore } from "$lib/features/editor/store.svelte";
  import { revealEditor } from "$lib/features/editor/reveal";
  import ChatText from "$lib/shared/components/ChatText.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { log } from "$lib/shared/log";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import RequestCard from "./RequestCard.svelte";
  import { readingOrder } from "./order";
  import {
    caretOn,
    drawable,
    filePath,
    jumpVisible,
    outputOf,
    runState,
    tailOf,
    textOf,
    toolKind,
    toolName,
    toolSummary,
  } from "./present";
  import { atBottom, windowFor } from "./virtual";
  import type {
    PilotItemRow,
    PilotRequest,
    PilotStatus,
    PilotTurnDiff,
    PilotUsage,
  } from "./types";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Copy from "@lucide/svelte/icons/copy";
  import FilePen from "@lucide/svelte/icons/file-pen";
  import FilePlus from "@lucide/svelte/icons/file-plus";
  import FileText from "@lucide/svelte/icons/file-text";
  import SearchIcon from "@lucide/svelte/icons/search";
  import Terminal from "@lucide/svelte/icons/terminal";
  import Wrench from "@lucide/svelte/icons/wrench";

  type Props = {
    threadId: string;
    items: PilotItemRow[];
    /** The thread's worktree, which is what a diff is taken against. */
    repoPath: string | null;
    projectId: string;
    /** Busy is what tells a growing row from one a reload left open. */
    status: PilotStatus;
  };
  let { threadId, items: journal, repoPath, projectId, status }: Props = $props();

  // `turn.started` mints a turn's row before anything it produced, so the
  // footer saying what the turn cost is drawn above its own answer unless the
  // order is fixed here (`order.ts`). `drawable` then drops the rows carrying
  // nothing, which is what used to be an empty bordered bar between two cards.
  const items = $derived(drawable(readingOrder(journal)));

  let scroller: HTMLDivElement | null = $state(null);
  let scrollTop = $state(0);
  let viewport = $state(0);
  /** Measured per row, by id: the ids outlive their position in the array. */
  const measured = new Map<string, number>();
  let heightsVersion = $state(0);
  let stick = $state(true);
  /** Which cards the user has opened. Folded is the default for every one. */
  let unfolded = $state<Record<string, boolean>>({});

  const ICONS = {
    bash: Terminal,
    read: FileText,
    write: FilePlus,
    edit: FilePen,
    search: SearchIcon,
    other: Wrench,
  } as const;

  const RUN_LABEL = {
    running: "pilot.toolRunning",
    done: "pilot.toolDone",
    denied: "pilot.toolDenied",
    failed: "pilot.toolFailed",
  } as const;

  const heights = $derived.by(() => {
    // `heightsVersion` is read so a measurement re-runs this; the map itself is
    // off `$state` because writing a hundred entries a frame into one would be
    // a hundred invalidations of the list that is being measured.
    void heightsVersion;
    return items.map((item) => measured.get(item.id) ?? 0);
  });

  const win = $derived(windowFor(heights, scrollTop, viewport));
  const shown = $derived(items.slice(win.start, win.end));
  const jump = $derived(jumpVisible(stick, items.length));

  function onScroll() {
    if (!scroller) return;
    scrollTop = scroller.scrollTop;
    viewport = scroller.clientHeight;
    stick = atBottom(scrollTop, viewport, scroller.scrollHeight);
  }

  function toBottom() {
    if (!scroller) return;
    stick = true;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }

  /**
   * One row's height, once it has been laid out.
   *
   * A `ResizeObserver` per row rather than a measurement at mount: a card whose
   * text is still streaming grows, and a height taken once would leave the
   * spacer below it wrong for the rest of the thread.
   */
  function measure(el: HTMLElement, id: string) {
    const observer = new ResizeObserver(() => {
      const height = el.offsetHeight;
      if (height > 0 && measured.get(id) !== height) {
        measured.set(id, height);
        heightsVersion += 1;
      }
    });
    observer.observe(el);
    return {
      destroy() {
        observer.disconnect();
      },
    };
  }

  // Following the tail. Runs after the list has been written, and only while
  // the user is already at the bottom: this is the whole "scrolled to the
  // bottom while the user has not scrolled up" rule, in one place.
  $effect(() => {
    void items.length;
    void heightsVersion;
    if (!stick || !scroller) return;
    const el = scroller;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      scrollTop = el.scrollTop;
      viewport = el.clientHeight;
    });
  });

  $effect(() => {
    if (!scroller) return;
    viewport = scroller.clientHeight;
  });

  function safeJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  /** What a tool was handed, in full, for the opened card. */
  function inputOf(row: PilotItemRow): string {
    const value = row.body?.input ?? row.body?.command ?? null;
    if (value === null || value === undefined) return "";
    return typeof value === "string" ? value : safeJson(value);
  }

  const requestOf = (row: PilotItemRow): PilotRequest | null =>
    row.body ? (row.body as unknown as PilotRequest) : null;

  const diffOf = (row: PilotItemRow): PilotTurnDiff | null =>
    (row.body?.diff as PilotTurnDiff | undefined) ?? null;

  const usageOf = (row: PilotItemRow): PilotUsage | null =>
    (row.body?.usage as PilotUsage | undefined) ?? null;

  const seconds = (row: PilotItemRow): string => {
    const ms = row.body?.durationMs;
    return typeof ms === "number" ? (ms / 1000).toFixed(1) : "0";
  };

  /** How long the model thought, when the driver said. */
  const thoughtFor = (row: PilotItemRow): string | null => {
    const ms = row.body?.durationMs;
    return typeof ms === "number" ? (ms / 1000).toFixed(0) : null;
  };

  async function copy(value: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      notifications.success(t("pilot.copied"));
    } catch {
      // A clipboard the browser refused is not worth a toast of its own.
    }
  }

  /** The editor, on this file as the turn left it. */
  async function openChange(row: PilotItemRow) {
    const path = filePath(row);
    if (!path) return;
    const turn = row.turnId ? items.find((i) => i.id === `turn:${row.turnId}`) : null;
    const range = rangeOf(turn ?? null);
    try {
      if (repoPath && range) {
        await editorStore.openDiff({ projectId, repoPath, file: path, mode: "turn", range });
      } else {
        await editorStore.open(path, { owner: projectId });
      }
      revealEditor();
    } catch (err) {
      log.warn("pilot.timeline", "pilot.openChange.failed", {
        thread: threadId,
        reason: String(err),
      });
    }
  }

  /** The turn's own diff, opened the way the checkpoint list opens one. */
  async function openTurnDiff(row: PilotItemRow, file?: string) {
    const diff = diffOf(row);
    const range = rangeOf(row);
    if (!diff || !repoPath || !range) return;
    const first = file ?? diff.fileList?.[0]?.path;
    if (!first) return;
    try {
      await editorStore.openDiff({
        projectId,
        repoPath,
        file: first,
        mode: "turn",
        range,
      });
      revealEditor();
    } catch (err) {
      log.warn("pilot.timeline", "pilot.openTurnDiff.failed", {
        thread: threadId,
        turn: row.turnId ?? undefined,
        reason: String(err),
      });
    }
  }

  function rangeOf(row: PilotItemRow | null): { from: string; to: string } | null {
    const from = row?.body?.checkpointStart;
    const to = row?.body?.checkpointEnd;
    return typeof from === "string" && typeof to === "string" ? { from, to } : null;
  }
</script>

<div class="relative min-h-0 flex-1">
  <div
    bind:this={scroller}
    onscroll={onScroll}
    class="h-full scroll-pane overflow-y-auto px-3 py-3"
  >
    {#if items.length === 0}
      <p class="px-1 py-6 text-center text-sm text-muted-foreground">{t("pilot.empty")}</p>
    {:else}
      <div style:height="{win.before}px"></div>
      <ul class="mx-auto flex w-full max-w-[72ch] flex-col gap-3">
        {#each shown as row (row.id)}
          <li
            use:measure={row.id}
            class="flex flex-col"
            data-testid="pilot-item"
            data-kind={row.kind}
            data-state={row.state ?? ""}
          >
            {#if row.kind === "assistant_text"}
              <ChatText text={textOf(row)} plain caret={caretOn(row, status === "busy")} />
            {:else if row.kind === "user_message"}
              <!-- The one row that leaves the column, so a long thread can be
                   scanned for "what did I ask" without an avatar per line. -->
              <div class="flex justify-end pt-1">
                <div
                  class="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--color-surface-2)] px-3 py-1.5 text-sm whitespace-pre-wrap break-words text-foreground"
                >
                  {textOf(row)}
                </div>
              </div>
            {:else if row.kind === "reasoning"}
              <!-- Folded by default: reasoning is the longest thing a turn
                   produces and the least often read. -->
              <div>
                <button
                  type="button"
                  class="flex items-center gap-1 rounded text-xs text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:focus-ring"
                  onclick={() => (unfolded[row.id] = !unfolded[row.id])}
                  aria-expanded={!!unfolded[row.id]}
                >
                  <ChevronRight
                    class="size-3 shrink-0 transition-transform {unfolded[row.id]
                      ? 'rotate-90'
                      : ''}"
                  />
                  <span>
                    {thoughtFor(row)
                      ? t("pilot.thoughtFor", { seconds: thoughtFor(row) ?? "" })
                      : t("pilot.thought")}
                  </span>
                </button>
                {#if unfolded[row.id]}
                  <pre
                    class="mt-1 border-l border-border pl-2.5 text-xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">{textOf(
                      row,
                    )}</pre>
                {/if}
              </div>
            {:else if row.kind === "tool_call" || row.kind === "command"}
              {@const kind = toolKind(toolName(row.body) || row.kind)}
              {@const Icon = ICONS[kind]}
              {@const state = runState(row)}
              {@const summary = toolSummary(row.body)}
              {@const output = outputOf(row.body)}
              <div class="rounded-lg border border-border bg-[var(--color-surface)]">
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-[var(--color-surface-2)] focus:outline-none focus-visible:focus-ring-inset"
                  onclick={() => (unfolded[row.id] = !unfolded[row.id])}
                  aria-expanded={!!unfolded[row.id]}
                  data-testid="pilot-tool"
                  data-tool={kind}
                  data-run={state}
                >
                  <Icon class="size-3.5 shrink-0 text-muted-foreground" />
                  <span class="shrink-0 text-xs font-medium text-foreground">
                    {toolName(row.body) || t("pilot.command")}
                  </span>
                  {#if summary}
                    <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                      {summary}
                    </span>
                  {:else}
                    <span class="flex-1"></span>
                  {/if}
                  <span
                    class="size-1.5 shrink-0 rounded-full {state === 'running'
                      ? 'pilot-pulse bg-[var(--color-warning)]'
                      : state === 'failed'
                        ? 'bg-[var(--color-danger)]'
                        : state === 'denied'
                          ? 'bg-[var(--color-muted-foreground)]'
                          : 'bg-[var(--color-success)]'}"
                    role="img"
                    aria-label={t(RUN_LABEL[state])}
                  ></span>
                </button>
                {#if unfolded[row.id]}
                  <div class="border-t border-border px-2.5 py-1.5">
                    {#if inputOf(row)}
                      <pre
                        class="max-h-40 scroll-pane overflow-auto font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">{inputOf(
                          row,
                        )}</pre>
                    {/if}
                    {#if output}
                      <div class="mt-1.5 flex items-start gap-1.5">
                        <pre
                          class="max-h-48 min-w-0 flex-1 scroll-pane overflow-auto font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">{tailOf(
                            output,
                          )}</pre>
                        <button
                          type="button"
                          class="press shrink-0 rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground focus:outline-none focus-visible:focus-ring"
                          onclick={() => void copy(output)}
                          aria-label={t("pilot.copyOutput")}
                        >
                          <Copy class="size-3" />
                        </button>
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {:else if row.kind === "file_change"}
              <div>
                <button
                  type="button"
                  class="press inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-[var(--color-surface)] px-2.5 py-1 text-xs transition hover:bg-[var(--color-surface-2)] focus:outline-none focus-visible:focus-ring"
                  onclick={() => void openChange(row)}
                >
                  <FilePen class="size-3 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 truncate font-mono text-foreground">{filePath(row)}</span>
                </button>
              </div>
            {:else if row.kind === "plan"}
              <div class="rounded-lg border border-border bg-[var(--color-surface)] px-2.5 py-2">
                <p class="text-xs font-medium text-foreground">{t("pilot.plan")}</p>
                <pre
                  class="mt-1 text-xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">{textOf(
                    row,
                  ) || safeJson(row.body)}</pre>
              </div>
            {:else if row.kind === "request"}
              {@const request = requestOf(row)}
              {#if request}
                <RequestCard
                  {threadId}
                  {request}
                  outcome={row.state === "open"
                    ? null
                    : ((row.body?.outcome as "allowed" | "denied" | "cancelled" | undefined) ??
                      "cancelled")}
                />
              {/if}
            {:else if row.kind === "error"}
              <p
                class="rounded-lg border border-[var(--color-danger)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-danger)]"
              >
                {String(row.body?.message ?? "")}
              </p>
            {:else if row.kind === "notice"}
              <p class="px-1 text-xs text-muted-foreground">
                {typeof row.body?.model === "string"
                  ? t("pilot.noticeModel", { model: String(row.body.model) })
                  : textOf(row)}
              </p>
            {:else if row.kind === "turn"}
              <!-- The footer under the turn it closes: what it cost and what it
                   changed, with the diff a click away and the files under it. -->
              {@const diff = diffOf(row)}
              {@const usage = usageOf(row)}
              <div
                class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-1.5 text-xs text-muted-foreground"
                data-testid="pilot-turn-footer"
              >
                {#if row.state === "running"}
                  <span class="flex items-center gap-1.5">
                    <span
                      class="pilot-pulse size-1.5 rounded-full bg-[var(--color-warning)]"
                      aria-hidden="true"
                    ></span>
                    {t("pilot.turnRunning")}
                  </span>
                {:else}
                  <span>{t("pilot.turnDuration", { seconds: seconds(row) })}</span>
                {/if}
                {#if usage}
                  <span data-testid="pilot-turn-tokens">
                    {t("pilot.turnTokens", {
                      input: String(usage.input_tokens ?? 0),
                      output: String(usage.output_tokens ?? 0),
                    })}
                  </span>
                {/if}
                {#if diff}
                  <button
                    type="button"
                    class="rounded underline decoration-dotted underline-offset-2 transition hover:text-foreground focus:outline-none focus-visible:focus-ring"
                    onclick={() => void openTurnDiff(row)}
                    aria-label={t("pilot.openDiff")}
                  >
                    {t("pilot.turnDiff", {
                      files: String(diff.files),
                      additions: String(diff.additions),
                      deletions: String(diff.deletions),
                    })}
                  </button>
                  {#if diff.fileList && diff.fileList.length > 0}
                    <button
                      type="button"
                      class="rounded transition hover:text-foreground focus:outline-none focus-visible:focus-ring"
                      onclick={() => (unfolded[row.id] = !unfolded[row.id])}
                      aria-expanded={!!unfolded[row.id]}
                    >
                      {unfolded[row.id] ? t("pilot.hideFiles") : t("pilot.showFiles")}
                    </button>
                  {/if}
                {/if}
              </div>
              {#if diff && unfolded[row.id]}
                <div class="mt-1.5 flex flex-wrap gap-1">
                  {#each diff.fileList as file (file.path)}
                    <button
                      type="button"
                      class="press inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-[var(--color-surface)] px-2 py-0.5 text-xs transition hover:bg-[var(--color-surface-2)] focus:outline-none focus-visible:focus-ring"
                      onclick={() => void openTurnDiff(row, file.path)}
                    >
                      <span class="min-w-0 truncate font-mono text-foreground">{file.path}</span>
                      <span class="shrink-0 text-muted-foreground">
                        {t("pilot.fileCounts", {
                          additions: String(file.additions),
                          deletions: String(file.deletions),
                        })}
                      </span>
                    </button>
                  {/each}
                </div>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
      <div style:height="{win.after}px"></div>
    {/if}
  </div>

  {#if jump}
    <button
      type="button"
      class="pilot-rise press absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-[var(--color-surface-2)] px-3 py-1 text-xs text-foreground shadow-[var(--shadow-e2)] transition hover:bg-[var(--color-surface-3)] focus:outline-none focus-visible:focus-ring"
      onclick={toBottom}
      data-testid="pilot-jump"
    >
      <ArrowDown class="size-3" />
      {t("pilot.jumpLatest")}
    </button>
  {/if}
</div>

<style>
  .pilot-pulse {
    animation: pilot-pulse 1.6s var(--ease-in-out-quad) infinite;
  }
  @keyframes pilot-pulse {
    50% {
      opacity: 0.35;
    }
  }
  .pilot-rise {
    animation: pilot-rise var(--dur-2) var(--ease-out-quint);
  }
  @keyframes pilot-rise {
    from {
      opacity: 0;
      transform: translate(-50%, 6px);
    }
  }
  :global(html[data-motion="reduced"]) .pilot-pulse,
  :global(html[data-motion="reduced"]) .pilot-rise {
    animation: none;
  }
</style>
