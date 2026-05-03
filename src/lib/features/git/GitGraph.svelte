<script lang="ts">
  import type { Commit } from "./api";

  type Props = { commits: Commit[] };
  let { commits }: Props = $props();

  interface Edge {
    fromCol: number;
    toCol: number;
  }
  interface Row {
    commit: Commit;
    col: number;
    before: (string | null)[];
    after: (string | null)[];
    incoming: boolean[];
    parentEdges: Edge[];
  }

  const LANE_W = 12;
  const ROW_H = 24;
  const DOT_R = 3;
  const STROKE = 1.25;

  // Muted lane palette. Primary lane stays neutral to match boite's grayscale.
  const COLORS = [
    "#a1a1aa",
    "#86efac",
    "#fcd34d",
    "#7dd3fc",
    "#f9a8d4",
    "#c4b5fd",
    "#fda4af",
    "#fdba74",
  ];

  const rows = $derived.by((): Row[] => {
    const out: Row[] = [];
    let prev: (string | null)[] = [];
    for (const c of commits) {
      const before: (string | null)[] = prev.slice();
      let col = before.indexOf(c.sha);
      if (col === -1) {
        col = before.findIndex((s) => s === null);
        if (col === -1) {
          col = before.length;
          before.push(c.sha);
        } else {
          before[col] = c.sha;
        }
      }
      const incoming = before.map(
        (s, k) => s != null && k < prev.length && prev[k] === s,
      );

      const after: (string | null)[] = before.slice();
      after[col] = null;
      const parentEdges: Edge[] = [];

      for (let pi = 0; pi < c.parents.length; pi++) {
        const p = c.parents[pi];
        let pCol = after.indexOf(p);
        if (pCol === -1) {
          if (pi === 0 && after[col] === null) {
            pCol = col;
          } else {
            pCol = after.findIndex((s) => s === null);
            if (pCol === -1) {
              pCol = after.length;
              after.push(p);
              parentEdges.push({ fromCol: col, toCol: pCol });
              continue;
            }
          }
          after[pCol] = p;
        }
        parentEdges.push({ fromCol: col, toCol: pCol });
      }

      while (after.length > 0 && after[after.length - 1] === null) after.pop();

      out.push({ commit: c, col, before, after, incoming, parentEdges });
      prev = after;
    }
    return out;
  });

  const totalCols = $derived(
    rows.reduce((m, r) => Math.max(m, r.before.length, r.after.length), 1),
  );
  const stripWidth = $derived(Math.max(totalCols, 1) * LANE_W);

  function laneX(col: number): number {
    return col * LANE_W + LANE_W / 2;
  }
  function laneColor(col: number): string {
    return COLORS[col % COLORS.length];
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

  let hovered = $state<{ row: Row; x: number; y: number } | null>(null);
  const POPUP_W = 380;
  const POPUP_H = 160;

  function showPopup(row: Row, e: MouseEvent) {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const flipUp = rect.bottom + POPUP_H + 8 > window.innerHeight;
    const y = flipUp ? rect.top - POPUP_H - 4 : rect.bottom + 4;
    const x = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - POPUP_W - 8),
    );
    hovered = { row, x, y };
  }

  function hidePopup() {
    hovered = null;
  }

  function relTime(ts: number): string {
    if (!ts) return "";
    const diff = Date.now() / 1000 - ts;
    if (diff < 60) return "now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
    if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo`;
    return `${Math.floor(diff / (86400 * 365))}y`;
  }
</script>

<div class="flex flex-col">
  {#each rows as row (row.commit.sha)}
    <div
      class="flex items-stretch transition hover:bg-[var(--color-surface-2)]"
      style:height="{ROW_H}px"
      onmouseenter={(e) => showPopup(row, e)}
      onmouseleave={hidePopup}
      role="presentation"
    >
      <svg
        class="shrink-0"
        width={stripWidth}
        height={ROW_H}
        viewBox="0 0 {stripWidth} {ROW_H}"
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
                stroke={laneColor(row.col)}
                stroke-width={STROKE}
              />
            {:else}
              <line
                x1={laneX(k)}
                y1={0}
                x2={laneX(k)}
                y2={ROW_H / 2}
                stroke={laneColor(k)}
                stroke-width={STROKE}
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
              stroke={laneColor(k)}
              stroke-width={STROKE}
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
              stroke={laneColor(e.toCol)}
              stroke-width={STROKE}
            />
          {:else}
            <path
              d="M{laneX(e.fromCol)} {ROW_H / 2} Q{laneX(e.fromCol)} {ROW_H}, {laneX(
                e.toCol,
              )} {ROW_H}"
              stroke={laneColor(e.toCol)}
              stroke-width={STROKE}
              fill="none"
            />
          {/if}
        {/each}

        {#if row.commit.localOnly}
          <circle
            cx={laneX(row.col)}
            cy={ROW_H / 2}
            r={DOT_R}
            fill="var(--color-warning)"
            stroke="var(--color-warning)"
            stroke-width="1.5"
          />
        {:else}
          <circle
            cx={laneX(row.col)}
            cy={ROW_H / 2}
            r={DOT_R}
            fill={laneColor(row.col)}
          />
        {/if}
      </svg>

      <div
        class="flex min-w-0 flex-1 items-center gap-1.5 pl-1 pr-2"
      >
        <span class="min-w-0 flex-1 truncate text-[11.5px] text-foreground/85">
          {row.commit.summary}
        </span>
        {#each row.commit.refs as r (r)}
          {@const clean = r.replace(/^HEAD -> /, "")}
          {@const isHead = r.startsWith("HEAD")}
          <span
            class="shrink-0 rounded px-1 py-px font-mono text-[9px] {isHead
              ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
              : 'bg-[var(--color-surface-3)] text-muted-foreground'}"
          >
            {clean}
          </span>
        {/each}
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
    class="pointer-events-none fixed z-50 rounded-md border border-border bg-[var(--color-surface-3)] p-2.5 shadow-xl"
    style:left="{hovered.x}px"
    style:top="{hovered.y}px"
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
