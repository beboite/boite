<script lang="ts">
  import { onDestroy } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { writeText } from "$lib/platform/clipboard";
  import { registerEscape, viewportHeight } from "$lib/shared/keyboard/overlay";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import type { Commit } from "./api";

  type Props = { commits: Commit[] };
  let { commits }: Props = $props();

  interface Edge {
    fromCol: number;
    toCol: number;
    color: string;
  }
  interface RefBadge {
    ref: string;
    label: string;
    isHead: boolean;
  }
  interface Row {
    commit: Commit;
    col: number;
    before: (string | null)[];
    after: (string | null)[];
    beforeColors: string[];
    afterColors: string[];
    incoming: boolean[];
    parentEdges: Edge[];
    dotColor: string;
    refBadges: RefBadge[];
    hiddenRefs: number;
  }

  const LANE_W = 16;
  const ROW_H = 28;
  const DOT_R = 3.5;
  const STROKE = 1.5;
  const MAX_STRIP_W = 72;

  // Lane paints, all from app.css. The eight branch hues and the remote-only
  // blue used to be hex literals in no token file, and the fallback was
  // --color-muted-foreground written out by hand.
  const BASE_COLOR = "var(--color-warning)";
  const REMOTE_ONLY_COLOR = "var(--color-lane-remote)";
  const FALLBACK_COLOR = "var(--color-muted-foreground)";
  const BRANCH_COLORS = [
    "var(--color-lane-1)",
    "var(--color-lane-2)",
    "var(--color-lane-3)",
    "var(--color-lane-4)",
    "var(--color-lane-5)",
    "var(--color-lane-6)",
    "var(--color-lane-7)",
    "var(--color-lane-8)",
  ];

  const bySha = $derived(new Map(commits.map((c) => [c.sha, c])));

  const currentBranch = $derived.by((): string | null => {
    for (const c of commits) {
      const head = c.refs.find((r) => r.startsWith("HEAD -> "));
      if (head) return cleanRef(head);
    }
    return null;
  });

  const rows = $derived.by((): Row[] => {
    const out: Row[] = [];
    let prev: (string | null)[] = [];
    let prevColors: string[] = [];
    for (const c of commits) {
      const before: (string | null)[] = prev.slice();
      const beforeColors = prevColors.slice();
      let col = before.indexOf(c.sha);
      if (col === -1) {
        col = before.findIndex((s) => s === null);
        if (col === -1) {
          col = before.length;
          before.push(c.sha);
          beforeColors[col] = commitColor(c, currentBranch);
        } else {
          before[col] = c.sha;
          beforeColors[col] = commitColor(c, currentBranch);
        }
      }
      if (!beforeColors[col]) {
        beforeColors[col] = commitColor(c, currentBranch);
      }
      const incoming = before.map(
        (s, k) => s != null && k < prev.length && prev[k] === s,
      );

      const after: (string | null)[] = before.slice();
      const afterColors: string[] = beforeColors.slice();
      const dotColor = beforeColors[col] || commitColor(c, currentBranch);
      after[col] = null;
      afterColors[col] = "";
      const parentEdges: Edge[] = [];

      for (let pi = 0; pi < c.parents.length; pi++) {
        const p = c.parents[pi];
        let pCol = after.indexOf(p);
        const parentColor = pi === 0 ? dotColor : commitColorBySha(p, currentBranch);
        if (pCol === -1) {
          if (pi === 0 && after[col] === null) {
            pCol = col;
          } else {
            pCol = after.findIndex((s) => s === null);
            if (pCol === -1) {
              pCol = after.length;
              after.push(p);
              afterColors[pCol] = parentColor;
              parentEdges.push({ fromCol: col, toCol: pCol, color: parentColor });
              continue;
            }
          }
          after[pCol] = p;
          afterColors[pCol] = parentColor;
        }
        if (!afterColors[pCol]) afterColors[pCol] = parentColor;
        parentEdges.push({ fromCol: col, toCol: pCol, color: afterColors[pCol] || parentColor });
      }

      while (after.length > 0 && after[after.length - 1] === null) {
        after.pop();
        afterColors.pop();
      }

      // Badges used to be filtered from the template, once per row per render,
      // and each call allocated a fresh array. This loop already touches every
      // commit exactly once, so they ride along.
      const shown = c.refs.filter((r) => !isRemoteHeadRef(r) && !isTagRef(r));
      const refBadges: RefBadge[] = shown.slice(0, 2).map((r) => ({
        ref: r,
        label: cleanRef(r),
        isHead: r.startsWith("HEAD"),
      }));

      out.push({
        commit: c,
        col,
        before,
        after,
        beforeColors,
        afterColors,
        incoming,
        parentEdges,
        dotColor,
        refBadges,
        hiddenRefs: Math.max(0, shown.length - 2),
      });
      prev = after;
      prevColors = afterColors;
    }
    return out;
  });

  const totalCols = $derived(
    rows.reduce((m, r) => Math.max(m, r.before.length, r.after.length), 1),
  );
  const stripWidth = $derived(Math.max(totalCols, 1) * LANE_W);
  // Lane geometry is pinned to MAX_STRIP_W on every <svg>, so a commit that opens
  // a new lane no longer rewrites width and viewBox on every mounted row. Only
  // how much of that strip shows still varies, and it does so through one custom
  // property on the container. viewBox is gone on purpose: with it a narrower box
  // would scale the lanes down, where the strip has always clipped them instead.
  const stripViewportWidth = $derived(Math.min(stripWidth, MAX_STRIP_W));

  // Windowing. A full log is 1000 rows and each row is an <svg> holding a
  // handful of lanes, edges and badges, so mounting all of them costs more than
  // the panel is worth. Rows are a uniform ROW_H tall, which is what makes a
  // fixed-height window legal: the slice can be derived from scroll position
  // alone, and two spacers stand in for what isn't mounted so the scrollbar
  // still describes the whole log.
  const OVERSCAN = 6;
  // Measuring only happens after the first render, so that render needs a guess.
  // Guessing a screenful costs one extra patch when it is wrong; guessing "all
  // rows" costs the exact mount this window exists to avoid.
  const FIRST_PASS_H = 800;

  let rootEl = $state<HTMLDivElement | null>(null);
  // The scroll container belongs to the parent panel, so it is found rather
  // than owned. Null once probed means nothing scrolls us and every row must
  // render, since then no scroll event would ever widen the window.
  let scroller = $state<HTMLElement | null>(null);
  let probed = $state(false);
  let scrollTop = $state(0);
  let viewportH = $state(0);
  // Rows above our root inside the scroller (none today, but the maths must not
  // silently depend on being the first child).
  let rootOffset = $state(0);

  function findScroller(from: HTMLElement): HTMLElement | null {
    let el = from.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  $effect(() => {
    const root = rootEl;
    if (!root) return;
    const el = findScroller(root);
    probed = true;
    if (!el) return;

    const measure = () => {
      const rootRect = root.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      viewportH = elRect.height;
      rootOffset = rootRect.top - elRect.top + el.scrollTop;
      scrollTop = el.scrollTop;
    };
    const onScroll = () => {
      scrollTop = el.scrollTop;
    };

    scroller = el;
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    // A resized panel changes how many rows fit; a collapsed one reports 0 and
    // the window narrows to nothing until it comes back.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      scroller = null;
    };
  });

  const windowed = $derived(!probed || scroller !== null);
  const windowH = $derived(scroller ? viewportH : FIRST_PASS_H);
  const windowStart = $derived.by(() => {
    if (!windowed) return 0;
    const first = Math.floor((scrollTop - rootOffset) / ROW_H) - OVERSCAN;
    return Math.min(Math.max(first, 0), rows.length);
  });
  const windowEnd = $derived.by(() => {
    if (!windowed) return rows.length;
    const last = Math.ceil((scrollTop - rootOffset + windowH) / ROW_H) + OVERSCAN;
    return Math.min(Math.max(last, windowStart), rows.length);
  });
  const visibleRows = $derived(rows.slice(windowStart, windowEnd));
  const padTop = $derived(windowStart * ROW_H);
  const padBottom = $derived(Math.max(rows.length - windowEnd, 0) * ROW_H);

  function laneX(col: number): number {
    return col * LANE_W + LANE_W / 2;
  }
  function cleanRef(ref: string): string {
    return ref.replace(/^HEAD -> /, "");
  }

  function isTagRef(ref: string): boolean {
    return cleanRef(ref).startsWith("tag: ");
  }

  function isRemoteHeadRef(ref: string): boolean {
    return cleanRef(ref).endsWith("/HEAD");
  }

  function commitBranchKey(commit: Commit): string | null {
    const refs = commit.refs
      .map(cleanRef)
      .filter((r) => r && !r.startsWith("tag: ") && !r.endsWith("/HEAD"));
    const local = refs.find((r) => !r.includes("/"));
    if (local) return local;
    return refs[0] ?? null;
  }

  function hashBranch(name: string): number {
    let out = 0;
    for (let i = 0; i < name.length; i++) {
      out = (out * 31 + name.charCodeAt(i)) | 0;
    }
    return Math.abs(out);
  }

  function branchColor(branch: string | null, baseBranch: string | null): string {
    if (!branch) return FALLBACK_COLOR;
    if (baseBranch && (branch === baseBranch || branch.endsWith(`/${baseBranch}`))) {
      return BASE_COLOR;
    }
    return BRANCH_COLORS[hashBranch(branch) % BRANCH_COLORS.length];
  }

  function commitColor(commit: Commit, baseBranch: string | null): string {
    if (commit.localOnly) return BASE_COLOR;
    if (commit.remoteOnly) return REMOTE_ONLY_COLOR;
    return branchColor(commitBranchKey(commit), baseBranch);
  }

  function commitColorBySha(sha: string, baseBranch: string | null): string {
    const commit = bySha.get(sha);
    return commit ? commitColor(commit, baseBranch) : FALLBACK_COLOR;
  }

  function fmtTime(ts: number): string {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  type Popup = {
    row: Row;
    x: number;
    rowTop: number;
    rowBottom: number;
    /** Opened by focus (keyboard or tap) rather than by the cursor. The two are
     *  dismissed by different things, which is the only reason to tell them
     *  apart. */
    viaFocus: boolean;
  };

  let hovered = $state<Popup | null>(null);
  let popupEl = $state<HTMLElement | null>(null);
  let measuredH = $state(184);
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  const POPUP_W = 380;
  const HOVER_DELAY_MS = 350;
  const POPUP_ID = "git-graph-commit-details";
  const popupOpen = $derived(hovered !== null);

  // Narrow windows can't fit the full 380px popup.
  function popupWidth(): number {
    return Math.min(POPUP_W, window.innerWidth - 16);
  }

  async function copySha(sha: string) {
    try {
      await writeText(sha);
      notifications.success(t("git.shaCopied", { sha }));
    } catch {
      notifications.error(t("git.copyFailed"));
    }
  }

  function anchorTo(row: Row, target: HTMLElement, viaFocus: boolean): Popup {
    const rect = target.getBoundingClientRect();
    return {
      row,
      x: Math.max(8, Math.min(rect.left, window.innerWidth - popupWidth() - 8)),
      rowTop: rect.top,
      rowBottom: rect.bottom,
      viaFocus,
    };
  }

  function showPopup(row: Row, e: MouseEvent) {
    const next = anchorTo(row, e.currentTarget as HTMLElement, false);
    if (hoverTimer) clearTimeout(hoverTimer);
    if (hovered) {
      // A popup is already up; follow the cursor without re-delaying.
      hovered = next;
      return;
    }
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      hovered = next;
    }, HOVER_DELAY_MS);
  }

  // Author, email, date, diffstat and the full ref list live nowhere else, so
  // reaching a row has to be enough to read them. No delay here: focus is
  // deliberate in a way that passing the cursor over a row is not.
  function showPopupNow(row: Row, target: HTMLElement) {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    hovered = anchorTo(row, target, true);
  }

  function hidePopup() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    hovered = null;
  }

  /** The cursor leaving a row must not close a popup the keyboard opened. */
  function leaveRow() {
    if (hovered?.viaFocus) return;
    hidePopup();
  }

  function rowEl(sha: string): HTMLElement | null {
    return rootEl?.querySelector<HTMLElement>(`[data-sha="${CSS.escape(sha)}"]`) ?? null;
  }

  $effect(() => {
    void hovered;
    if (popupEl) measuredH = popupEl.offsetHeight;
  });

  const popupTop = $derived.by(() => {
    if (!hovered) return 0;
    // The visual viewport, not the window: a tap opens this popup now, and on a
    // phone the soft keyboard has already taken the bottom of the screen.
    const flipUp = hovered.rowBottom + measuredH + 8 > viewportHeight();
    return flipUp ? hovered.rowTop - measuredH - 4 : hovered.rowBottom + 4;
  });

  // Depends on whether a popup is open, not on which one: reading `hovered` here
  // would tear the listener down and put it back on every cursor move.
  $effect(() => {
    if (!popupOpen) return;
    const onScroll = () => {
      const open = hovered;
      if (!open) return;
      if (!open.viaFocus) {
        hidePopup();
        return;
      }
      // The row it describes is still focused and still on screen, so the popup
      // follows it rather than vanishing under the keyboard's own scrolling.
      const el = rowEl(open.row.commit.sha);
      if (!el) {
        hidePopup();
        return;
      }
      hovered = anchorTo(open.row, el, true);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  });

  // Escape closes it, through the app's one Escape stack so a context menu over
  // the graph still gets the key first.
  $effect(() => {
    if (!popupOpen) return;
    return registerEscape(hidePopup);
  });

  let activeSha = $state<string | null>(null);
  let pendingFocusSha = $state<string | null>(null);

  /**
   * Which row owns the list's single tab stop.
   *
   * Derived rather than stored, because the window unmounts rows: a tabindex
   * parked on a row that scrolled out would take the tab stop out of the DOM
   * with it. The cursor holds it while it is mounted, and the top of the window
   * holds it the rest of the time.
   */
  const tabStopSha = $derived.by(() => {
    if (activeSha && visibleRows.some((r) => r.commit.sha === activeSha)) {
      return activeSha;
    }
    return visibleRows[0]?.commit.sha ?? null;
  });

  /**
   * Move the cursor to a row that may not be mounted yet.
   *
   * The scroll is applied and read straight back into `scrollTop` so the slice
   * maths sees the new position in this same update: by the time the effect
   * below runs, the row exists and can take focus.
   */
  function focusRow(index: number) {
    const i = Math.min(Math.max(index, 0), rows.length - 1);
    const row = rows[i];
    if (!row) return;
    activeSha = row.commit.sha;
    const el = scroller;
    if (el) {
      const top = rootOffset + i * ROW_H;
      const bottom = top + ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) {
        el.scrollTop = bottom - el.clientHeight;
      }
      scrollTop = el.scrollTop;
    }
    pendingFocusSha = row.commit.sha;
  }

  $effect(() => {
    const sha = pendingFocusSha;
    if (!sha) return;
    pendingFocusSha = null;
    rowEl(sha)?.focus();
  });

  function onRowKeydown(row: Row, e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      // Space on the scroller is page-down; on a row it is the row's activate.
      e.preventDefault();
      void copySha(row.commit.shortSha);
      return;
    }
    const at = rows.findIndex((r) => r.commit.sha === row.commit.sha);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(rows.length - 1);
    }
  }

  onDestroy(() => {
    if (hoverTimer) clearTimeout(hoverTimer);
  });

  let now = $state(Date.now());

  // Every row's label reads `now`, so a tick re-patches the whole window. Past
  // an hour a label only changes on a boundary hours or days away, so the clock
  // is worth running only while something on screen is younger than that: the
  // newest visible commit decides, and once even it is stale the tick stops.
  const RECENT_S = 3600;
  const newestVisibleTime = $derived.by(() => {
    let newest = 0;
    for (const row of visibleRows) {
      if (row.commit.time > newest) newest = row.commit.time;
    }
    return newest;
  });

  $effect(() => {
    const newest = newestVisibleTime;
    if (!newest || Date.now() / 1000 - newest >= RECENT_S) return;
    const timer = setInterval(() => {
      now = Date.now();
      if (now / 1000 - newest >= RECENT_S) clearInterval(timer);
    }, 30_000);
    return () => clearInterval(timer);
  });

  function relTime(ts: number): string {
    if (!ts) return "";
    const diff = now / 1000 - ts;
    if (diff < 60) return t("git.relNow");
    if (diff < 3600) return t("git.relMinutes", { count: Math.floor(diff / 60) });
    if (diff < 86400) return t("git.relHours", { count: Math.floor(diff / 3600) });
    if (diff < 86400 * 30) return t("git.relDays", { count: Math.floor(diff / 86400) });
    if (diff < 86400 * 365) {
      return t("git.relMonths", { count: Math.floor(diff / (86400 * 30)) });
    }
    return t("git.relYears", { count: Math.floor(diff / (86400 * 365)) });
  }
</script>

<div
  bind:this={rootEl}
  class="flex min-w-0 flex-col"
  style:--git-strip-w="{stripViewportWidth}px"
>
  {#if padTop > 0}
    <div class="shrink-0" style:height="{padTop}px" aria-hidden="true"></div>
  {/if}
  {#each visibleRows as row (row.commit.sha)}
    {@const dotColor = row.dotColor}
    {@const isMerge = row.commit.parents.length > 1}
    <div
      data-sha={row.commit.sha}
      class="flex min-w-0 cursor-pointer items-stretch transition hover:bg-accent focus-visible:bg-[var(--color-surface-2)]"
      style:height="{ROW_H}px"
      onmouseenter={(e) => showPopup(row, e)}
      onmouseleave={leaveRow}
      onfocusin={(e) => showPopupNow(row, e.currentTarget as HTMLElement)}
      onfocusout={hidePopup}
      onclick={() => copySha(row.commit.shortSha)}
      onkeydown={(e) => onRowKeydown(row, e)}
      role="button"
      tabindex={row.commit.sha === tabStopSha ? 0 : -1}
      aria-describedby={hovered?.row.commit.sha === row.commit.sha ? POPUP_ID : undefined}
      use:tip={t("git.clickToCopy", { sha: row.commit.shortSha })}
    >
      <svg
        class="shrink-0"
        style="width: var(--git-strip-w)"
        width={MAX_STRIP_W}
        height={ROW_H}
        aria-hidden="true"
      >
        {#each row.before as sha, k (k)}
          {#if sha != null && row.incoming[k]}
            {#if k === row.col}
              <line
                x1={laneX(k)}
                y1={0}
                x2={laneX(row.col)}
                y2={ROW_H / 2}
                stroke={row.beforeColors[row.col] || dotColor}
                stroke-width={STROKE}
                stroke-linecap="round"
              />
            {:else}
              <line
                x1={laneX(k)}
                y1={0}
                x2={laneX(k)}
                y2={ROW_H / 2}
                stroke={row.beforeColors[k] || FALLBACK_COLOR}
                stroke-width={STROKE}
                stroke-linecap="round"
                opacity="0.65"
              />
            {/if}
          {/if}
        {/each}

        {#each row.after as sha, k (k)}
          {#if sha != null && k !== row.col && row.before[k] === sha}
            <line
              x1={laneX(k)}
              y1={ROW_H / 2}
              x2={laneX(k)}
              y2={ROW_H}
              stroke={row.afterColors[k] || row.beforeColors[k] || FALLBACK_COLOR}
              stroke-width={STROKE}
              stroke-linecap="round"
              opacity="0.65"
            />
          {/if}
        {/each}

        {#each row.parentEdges as e, i (i)}
          {#if e.fromCol === e.toCol}
            <line
              x1={laneX(e.fromCol)}
              y1={ROW_H / 2}
              x2={laneX(e.toCol)}
              y2={ROW_H}
              stroke={e.color}
              stroke-width={STROKE}
              stroke-linecap="round"
            />
          {:else}
            <path
              d="M{laneX(e.fromCol)} {ROW_H / 2} Q{laneX(e.fromCol)} {ROW_H}, {laneX(
                e.toCol,
              )} {ROW_H}"
              stroke={e.color}
              stroke-width={STROKE}
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
          {/if}
        {/each}

        {#if isMerge}
          <circle
            cx={laneX(row.col)}
            cy={ROW_H / 2}
            r={DOT_R + 3}
            fill="none"
            stroke={dotColor}
            stroke-width="1"
            opacity="0.8"
          />
        {/if}
        <circle
          cx={laneX(row.col)}
          cy={ROW_H / 2}
          r={isMerge ? DOT_R + 0.75 : DOT_R}
          fill={dotColor}
          stroke="var(--color-background)"
          stroke-width={isMerge ? 2 : 1}
        />
      </svg>

      <div
        class="flex min-w-0 flex-1 items-center gap-1.5 pl-1 pr-2"
      >
        <span class="min-w-0 flex-1 truncate text-sm text-foreground">
          {row.commit.summary}
        </span>
        {#each row.refBadges as badge (badge.ref)}
          <span
            class="shrink-0 rounded px-1.5 py-px text-2xs font-medium {badge.isHead
              ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
              : 'bg-[var(--color-surface-3)] text-muted-foreground'}"
          >
            {badge.label}
          </span>
        {/each}
        {#if row.hiddenRefs > 0}
          <span class="shrink-0 rounded bg-[var(--color-surface-3)] px-1.5 py-px tabular-nums text-2xs font-medium text-muted-2">
            +{row.hiddenRefs}
          </span>
        {/if}
        <span
          class="shrink-0 tabular-nums text-2xs text-muted-2"
        >
          {relTime(row.commit.time)}
        </span>
      </div>
    </div>
  {/each}
  {#if padBottom > 0}
    <div class="shrink-0" style:height="{padBottom}px" aria-hidden="true"></div>
  {/if}
</div>

{#if hovered}
  {@const c = hovered.row.commit}
  <div
    bind:this={popupEl}
    id={POPUP_ID}
    role="tooltip"
    class="surface-popover pointer-events-none fixed z-[var(--z-popover)] p-2.5"
    style:left="{hovered.x}px"
    style:top="{popupTop}px"
    style:width="{popupWidth()}px"
  >
    <div
      class="whitespace-pre-wrap break-words text-sm font-medium leading-snug text-foreground"
    >
      {c.summary}
    </div>
    <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      <span class="tabular-nums font-medium text-muted-foreground">{c.shortSha}</span>
      <span class="text-muted-2">·</span>
      <span class="text-muted-2">{c.author}</span>
      {#if c.email}
        <span class="text-muted-2">&lt;{c.email}&gt;</span>
      {/if}
    </div>
    <div class="mt-1 text-xs text-muted-2">
      {fmtTime(c.time)}
    </div>
    <div class="mt-2 flex items-center gap-2 tabular-nums text-xs font-medium">
      <span class={c.additions > 0 ? "text-[var(--color-success)]" : "text-muted-2"}>
        +{c.additions}
      </span>
      <span class={c.deletions > 0 ? "text-danger" : "text-muted-2"}>
        -{c.deletions}
      </span>
    </div>
    {#if c.localOnly}
      <div class="mt-1.5 flex items-center gap-1 text-2xs text-[var(--color-warning)]">
        <span class="inline-block size-1.5 rounded-full bg-[var(--color-warning)]"></span>
        {t("git.localNotPushed")}
      </div>
    {/if}
    {#if c.refs.length > 0}
      <div class="mt-2 flex flex-wrap gap-1">
        {#each c.refs as r (r)}
          {@const clean = r.replace(/^HEAD -> /, "")}
          {@const isHead = r.startsWith("HEAD")}
          <span
            class="rounded px-1.5 py-px text-2xs font-medium {isHead
              ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
              : 'bg-[var(--color-surface-3)] text-muted-foreground'}"
          >
            {clean}
          </span>
        {/each}
      </div>
    {/if}
  </div>
{/if}
