<script lang="ts">
  import { onDestroy } from "svelte";
  import type { Commit } from "./api";

  type Props = { commits: Commit[] };
  let { commits }: Props = $props();

  interface Edge {
    fromCol: number;
    toCol: number;
    color: string;
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
  }

  const LANE_W = 16;
  const ROW_H = 28;
  const DOT_R = 3.5;
  const STROKE = 1.5;
  const MAX_STRIP_W = 72;

  const BASE_COLOR = "var(--color-warning)";
  const REMOTE_ONLY_COLOR = "#38bdf8";
  const FALLBACK_COLOR = "#a1a1aa";
  const BRANCH_COLORS = [
    "#f472b6",
    "#86efac",
    "#a78bfa",
    "#fb7185",
    "#2dd4bf",
    "#f97316",
    "#60a5fa",
    "#c084fc",
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
  const stripViewportWidth = $derived(Math.min(stripWidth, MAX_STRIP_W));

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
    if (commit.localOnly) return "var(--color-warning)";
    if (commit.remoteOnly) return REMOTE_ONLY_COLOR;
    return branchColor(commitBranchKey(commit), baseBranch);
  }

  function commitColorBySha(sha: string, baseBranch: string | null): string {
    const commit = bySha.get(sha);
    return commit ? commitColor(commit, baseBranch) : FALLBACK_COLOR;
  }

  function rowRefs(refs: string[]): string[] {
    return refs.filter((r) => !isRemoteHeadRef(r) && !isTagRef(r)).slice(0, 2);
  }

  function hiddenRefCount(refs: string[]): number {
    return Math.max(0, refs.filter((r) => !isRemoteHeadRef(r) && !isTagRef(r)).length - 2);
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

  let hovered = $state<{ row: Row; x: number; rowTop: number; rowBottom: number } | null>(null);
  let popupEl = $state<HTMLElement | null>(null);
  let measuredH = $state(184);
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  const POPUP_W = 380;
  const HOVER_DELAY_MS = 350;

  function showPopup(row: Row, e: MouseEvent) {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const x = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - POPUP_W - 8),
    );
    if (hoverTimer) clearTimeout(hoverTimer);
    const next = { row, x, rowTop: rect.top, rowBottom: rect.bottom };
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

  function hidePopup() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    hovered = null;
  }

  $effect(() => {
    void hovered;
    if (popupEl) measuredH = popupEl.offsetHeight;
  });

  const popupTop = $derived.by(() => {
    if (!hovered) return 0;
    const flipUp = hovered.rowBottom + measuredH + 8 > window.innerHeight;
    return flipUp ? hovered.rowTop - measuredH - 4 : hovered.rowBottom + 4;
  });

  $effect(() => {
    if (!hovered) return;
    window.addEventListener("scroll", hidePopup, true);
    return () => window.removeEventListener("scroll", hidePopup, true);
  });

  onDestroy(() => {
    if (hoverTimer) clearTimeout(hoverTimer);
  });

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  function relTime(ts: number): string {
    if (!ts) return "";
    const diff = now / 1000 - ts;
    if (diff < 60) return "now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
    if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo`;
    return `${Math.floor(diff / (86400 * 365))}y`;
  }
</script>

<div class="flex min-w-0 flex-col">
  {#each rows as row (row.commit.sha)}
    {@const dotColor = row.dotColor}
    {@const isMerge = row.commit.parents.length > 1}
    {@const visibleRefs = rowRefs(row.commit.refs)}
    {@const hiddenRefs = hiddenRefCount(row.commit.refs)}
    <div
      class="flex min-w-0 items-stretch transition hover:bg-[var(--color-surface-2)]"
      style:height="{ROW_H}px"
      onmouseenter={(e) => showPopup(row, e)}
      onmouseleave={hidePopup}
      role="presentation"
    >
      <svg
        class="shrink-0"
        width={stripViewportWidth}
        height={ROW_H}
        viewBox="0 0 {stripViewportWidth} {ROW_H}"
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
        <span class="min-w-0 flex-1 truncate text-[11.5px] text-foreground/85">
          {row.commit.summary}
        </span>
        {#each visibleRefs as r (r)}
          {@const clean = cleanRef(r)}
          {@const isHead = r.startsWith("HEAD")}
          <span
            class="shrink-0 rounded px-1 py-px font-mono text-[9px] {isHead
              ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
              : 'bg-[var(--color-surface-3)] text-muted-foreground'}"
          >
            {clean}
          </span>
        {/each}
        {#if hiddenRefs > 0}
          <span class="shrink-0 rounded bg-[var(--color-surface-3)] px-1 py-px font-mono text-[9px] text-muted-foreground/70">
            +{hiddenRefs}
          </span>
        {/if}
        <span
          class="shrink-0 font-mono text-[9.5px] text-muted-foreground/55"
        >
          {relTime(row.commit.time)}
        </span>
      </div>
    </div>
  {/each}
</div>

{#if hovered}
  {@const c = hovered.row.commit}
  <div
    bind:this={popupEl}
    class="pointer-events-none fixed z-50 rounded-md border border-border bg-[var(--color-surface-3)] p-2.5 shadow-xl"
    style:left="{hovered.x}px"
    style:top="{popupTop}px"
    style:width="{POPUP_W}px"
  >
    <div
      class="whitespace-pre-wrap break-words text-[12px] font-medium leading-snug text-foreground"
    >
      {c.summary}
    </div>
    <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px]">
      <span class="font-mono text-foreground/75">{c.shortSha}</span>
      <span class="text-muted-foreground/40">·</span>
      <span class="text-muted-foreground/85">{c.author}</span>
      {#if c.email}
        <span class="font-mono text-muted-foreground/55">&lt;{c.email}&gt;</span>
      {/if}
    </div>
    <div class="mt-1 text-[10.5px] text-muted-foreground/65">
      {fmtTime(c.time)}
    </div>
    <div class="mt-2 flex items-center gap-2 font-mono text-[10.5px]">
      <span class={c.additions > 0 ? "text-[var(--color-success)]" : "text-muted-foreground/45"}>
        +{c.additions}
      </span>
      <span class={c.deletions > 0 ? "text-danger" : "text-muted-foreground/45"}>
        -{c.deletions}
      </span>
    </div>
    {#if c.localOnly}
      <div class="mt-1.5 flex items-center gap-1 text-[10px] text-[var(--color-warning)]">
        <span class="inline-block size-1.5 rounded-full bg-[var(--color-warning)]"></span>
        Local — not pushed
      </div>
    {/if}
    {#if c.refs.length > 0}
      <div class="mt-2 flex flex-wrap gap-1">
        {#each c.refs as r (r)}
          {@const clean = r.replace(/^HEAD -> /, "")}
          {@const isHead = r.startsWith("HEAD")}
          <span
            class="rounded px-1 py-px font-mono text-[9.5px] {isHead
              ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
              : 'bg-[var(--color-surface-2)] text-muted-foreground'}"
          >
            {clean}
          </span>
        {/each}
      </div>
    {/if}
  </div>
{/if}
