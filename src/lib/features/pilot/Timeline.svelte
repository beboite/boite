<script lang="ts">
  /**
   * A chat thread's items, oldest first.
   *
   * Two things it is careful about, and both are budget lines in
   * `docs/pilot.md`. It draws the rows the viewport can see and nothing else,
   * because a two thousand item thread is two thousand bordered cards; and it
   * follows the bottom only while the user has not scrolled up, because a
   * timeline that jumps under a reader is a long thread nobody can read while
   * the agent is talking.
   *
   * The arithmetic is `virtual.ts` and has no DOM in it. What is here is the
   * three things a browser has to answer: how tall a row turned out to be, where
   * the container is scrolled to, and whether the tail is on screen.
   */
  import { editorStore } from "$lib/features/editor/store.svelte";
  import { revealEditor } from "$lib/features/editor/reveal";
  import ChatText from "$lib/shared/components/ChatText.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { log } from "$lib/shared/log";
  import RequestCard from "./RequestCard.svelte";
  import { readingOrder } from "./order";
  import { atBottom, windowFor } from "./virtual";
  import type { PilotItemRow, PilotRequest, PilotTurnDiff, PilotUsage } from "./types";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";

  type Props = {
    threadId: string;
    items: PilotItemRow[];
    /** The thread's worktree, which is what a diff is taken against. */
    repoPath: string | null;
    projectId: string;
  };
  let { threadId, items: journal, repoPath, projectId }: Props = $props();

  // `turn.started` mints a turn's row before anything it produced, so the
  // footer saying what the turn cost is drawn above its own answer unless the
  // order is fixed here. See `order.ts`.
  const items = $derived(readingOrder(journal));

  let scroller: HTMLDivElement | null = $state(null);
  let scrollTop = $state(0);
  let viewport = $state(0);
  /** Measured per row, by id: the ids outlive their position in the array. */
  const measured = new Map<string, number>();
  let heightsVersion = $state(0);
  let stick = $state(true);
  /** Which reasoning cards the user has opened. Folded is the default. */
  let unfolded = $state<Record<string, boolean>>({});

  const heights = $derived.by(() => {
    // `heightsVersion` is read so a measurement re-runs this; the map itself is
    // off `$state` because writing a hundred entries a frame into one would be
    // a hundred invalidations of the list that is being measured.
    void heightsVersion;
    return items.map((item) => measured.get(item.id) ?? 0);
  });

  const win = $derived(windowFor(heights, scrollTop, viewport));
  const shown = $derived(items.slice(win.start, win.end));

  function onScroll() {
    if (!scroller) return;
    scrollTop = scroller.scrollTop;
    viewport = scroller.clientHeight;
    stick = atBottom(scrollTop, viewport, scroller.scrollHeight);
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

  const text = (row: PilotItemRow): string => {
    const value = row.body?.text;
    return typeof value === "string" ? value : "";
  };

  /** The first line of whatever a tool was handed, which is what names it. */
  function firstLine(value: unknown): string {
    if (value === undefined || value === null) return "";
    const asText = typeof value === "string" ? value : safeJson(value);
    return asText.split("\n")[0]?.slice(0, 200) ?? "";
  }

  /** The tail of an output, which is the half that says how it went. */
  function tail(value: unknown, lines = 6): string {
    if (value === undefined || value === null) return "";
    const asText = typeof value === "string" ? value : safeJson(value);
    const rows = asText.split("\n");
    return rows.slice(Math.max(0, rows.length - lines)).join("\n");
  }

  function safeJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
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

  /**
   * The file a change card names, however the driver spelled it.
   *
   * Drivers disagree about the key and always will, so the card reads the three
   * that exist rather than refusing to draw a change it cannot name.
   */
  function pathOf(row: PilotItemRow): string {
    const body = row.body ?? {};
    for (const key of ["path", "file", "file_path"]) {
      const value = body[key];
      if (typeof value === "string" && value) return value;
    }
    return "";
  }

  /** The editor, on this file as the turn left it. */
  async function openChange(row: PilotItemRow) {
    const path = pathOf(row);
    if (!path) return;
    const turn = row.turnId ? items.find((i) => i.id === `turn:${row.turnId}`) : null;
    const range = rangeOf(turn ?? null);
    try {
      if (repoPath && range) {
        await editorStore.openDiff({
          projectId,
          repoPath,
          file: path,
          mode: "turn",
          range,
        });
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
  async function openTurnDiff(row: PilotItemRow) {
    const diff = diffOf(row);
    const range = rangeOf(row);
    if (!diff || !repoPath || !range) return;
    const first = diff.fileList?.[0]?.path;
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

<div
  bind:this={scroller}
  onscroll={onScroll}
  class="min-h-0 flex-1 scroll-pane overflow-y-auto px-3 py-2"
>
  {#if items.length === 0}
    <p class="px-1 py-6 text-center text-sm text-muted-2">{t("pilot.empty")}</p>
  {:else}
    <div style:height="{win.before}px"></div>
    <ul class="flex flex-col gap-2">
      {#each shown as row (row.id)}
        <li
          use:measure={row.id}
          class="flex flex-col gap-1"
          data-testid="pilot-item"
          data-kind={row.kind}
          data-state={row.state ?? ""}
        >
          <!-- An empty bubble is drawn as a bar of surface colour with nothing
               in it, which is what a driver's own echo of the user's line looks
               like when its body carries no text. Nothing to say means no card. -->
          {#if row.kind === "assistant_text"}
            {#if text(row)}<ChatText text={text(row)} wide />{/if}
          {:else if row.kind === "user_message"}
            {#if text(row)}
              <div class="flex justify-end">
                <ChatText text={text(row)} mine />
              </div>
            {/if}
          {:else if row.kind === "reasoning"}
            <!-- Folded by default: reasoning is the longest thing a turn
                 produces and the least often read. -->
            <div class="rounded-md border border-edge bg-[var(--color-surface)] px-2.5 py-1.5">
              <button
                type="button"
                class="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground transition hover:text-foreground"
                onclick={() => (unfolded[row.id] = !unfolded[row.id])}
                aria-expanded={!!unfolded[row.id]}
              >
                <ChevronRight
                  class="size-3 shrink-0 transition-transform {unfolded[row.id]
                    ? 'rotate-90'
                    : ''}"
                />
                <span class="min-w-0 flex-1 truncate">
                  {text(row).split("\n")[0] || t("pilot.reasoning")}
                </span>
              </button>
              {#if unfolded[row.id]}
                <pre
                  class="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{text(
                    row,
                  )}</pre>
              {/if}
            </div>
          {:else if row.kind === "tool_call" || row.kind === "command"}
            <div class="rounded-md border border-edge bg-[var(--color-surface)] px-2.5 py-1.5">
              <p class="truncate text-xs font-medium text-foreground">
                {row.kind === "command"
                  ? t("pilot.command")
                  : t("pilot.toolCall", { tool: String(row.body?.name ?? row.body?.tool ?? "") })}
              </p>
              {#if firstLine(row.body?.input ?? row.body?.command)}
                <p class="truncate text-xs text-muted-foreground">
                  {firstLine(row.body?.input ?? row.body?.command)}
                </p>
              {/if}
              {#if tail(row.body?.output)}
                <pre
                  class="mt-1 max-h-32 overflow-auto scroll-pane whitespace-pre-wrap break-words text-xs text-muted-2">{tail(
                    row.body?.output,
                  )}</pre>
              {/if}
            </div>
          {:else if row.kind === "file_change"}
            <button
              type="button"
              class="w-full rounded-md border border-edge bg-[var(--color-surface)] px-2.5 py-1.5 text-left transition hover:bg-[var(--color-surface-2)]"
              onclick={() => void openChange(row)}
            >
              <p class="truncate text-xs font-medium text-foreground">
                {t("pilot.fileChange", { path: pathOf(row) })}
              </p>
              {#if firstLine(row.body?.summary)}
                <p class="truncate text-xs text-muted-foreground">
                  {firstLine(row.body?.summary)}
                </p>
              {/if}
            </button>
          {:else if row.kind === "plan"}
            <div class="rounded-md border border-edge bg-[var(--color-surface)] px-2.5 py-1.5">
              <p class="text-xs font-medium text-foreground">{t("pilot.plan")}</p>
              <pre
                class="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{text(
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
                  : (row.body?.outcome as "allowed" | "denied" | "cancelled" | undefined) ??
                    "cancelled"}
              />
            {/if}
          {:else if row.kind === "error"}
            <p class="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-sm text-danger">
              {String(row.body?.message ?? "")}
            </p>
          {:else if row.kind === "notice"}
            <p class="px-1 text-xs text-muted-2">{text(row)}</p>
          {:else if row.kind === "turn"}
            <!-- The footer under the turn it closes: what it cost and what it
                 changed, with the diff a click away. -->
            {@const diff = diffOf(row)}
            {@const usage = usageOf(row)}
            <div
              class="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-1 text-xs text-muted-2"
              data-testid="pilot-turn-footer"
            >
              {#if row.state === "running"}
                <span>{t("pilot.turnRunning")}</span>
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
                  class="rounded px-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
                  onclick={() => void openTurnDiff(row)}
                  aria-label={t("pilot.openDiff")}
                >
                  {t("pilot.turnDiff", {
                    files: String(diff.files),
                    additions: String(diff.additions),
                    deletions: String(diff.deletions),
                  })}
                </button>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <div style:height="{win.after}px"></div>
  {/if}
</div>
