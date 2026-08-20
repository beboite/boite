<script lang="ts">
  import { untrack } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import DashboardCard from "$lib/features/project/DashboardCard.svelte";
  import { formatTokens as fmt } from "$lib/features/project/usage.svelte";
  import { pathKey } from "$lib/features/project/path";
  import { workspaceUsage } from "./usage.svelte";
  import { registerEscape } from "$lib/shared/keyboard/overlay";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Coins from "@lucide/svelte/icons/coins";
  import { activeLocale, t } from "$lib/i18n/index.svelte";
  import type { IconKey } from "$lib/types";

  const WEEKS = 53;
  const DAY_MS = 86_400_000;

  const report = $derived(workspaceUsage.report());
  const loading = $derived(workspaceUsage.loading());

  const cwds = $derived.by(() => {
    const out = new Map<string, string>();
    const add = (path: string) => {
      if (!out.has(pathKey(path))) out.set(pathKey(path), path);
    };
    for (const project of app.sortedProjects) {
      add(project.cwd);
      if (project.gitRoot) add(project.gitRoot);
      for (const thread of app.threadsByProject(project.id)) {
        if (thread.worktreePath) add(thread.worktreePath);
      }
    }
    return [...out.values()];
  });

  // The session ids the workspace stamped on its orchestrators, live or put
  // away: the split is history, and a conductor that finished still spent.
  const orchestratorSessions = $derived(
    app.threads
      .filter((thread) => thread.role === "orchestrator" && thread.sessionId)
      .map((thread) => thread.sessionId as string),
  );

  function load() {
    void workspaceUsage.load($state.snapshot(cwds), $state.snapshot(orchestratorSessions));
  }

  $effect(() => {
    void app.sortedProjects.map((p) => p.id).join("\0");
    untrack(() =>
      workspaceUsage.ensure($state.snapshot(cwds), $state.snapshot(orchestratorSessions)),
    );
  });

  const total = $derived(report?.models.reduce((sum, m) => sum + m.total, 0) ?? 0);

  function shortModel(model: string): string {
    return model
      .replace(/^(claude|anthropic)[-.]/, "")
      .replace(/-\d{8}$/, "")
      .replace(/-latest$/, "");
  }

  function providerIcon(provider: string): IconKey {
    return provider === "codex" ? "codex" : provider === "claude" ? "claude" : null;
  }

  function shade(step: number): string {
    if (step <= 0) return "var(--color-surface-3)";
    return `color-mix(in srgb, var(--color-foreground) ${step * 22}%, var(--color-surface-3))`;
  }

  type Cell = {
    day: string;
    at: number;
    total: number;
    future: boolean;
    today: boolean;
    color: string;
  };

  const cells = $derived.by(() => {
    const totals = new Map<string, number>();
    let peak = 1;
    for (const d of report?.days ?? []) {
      totals.set(d.day, d.total);
      if (d.total > peak) peak = d.total;
    }
    const ceiling = Math.log10(1 + peak);
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const endSaturday = today + (6 - new Date(today).getUTCDay()) * DAY_MS;
    const start = endSaturday - (WEEKS * 7 - 1) * DAY_MS;
    const out: Cell[] = [];
    for (let i = 0; i < WEEKS * 7; i++) {
      const at = start + i * DAY_MS;
      const day = new Date(at).toISOString().slice(0, 10);
      const value = totals.get(day) ?? 0;
      const step = value <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((Math.log10(1 + value) / ceiling) * 4)));
      out.push({
        day,
        at,
        total: value,
        future: at > today,
        today: at === today,
        color: shade(step),
      });
    }
    return out;
  });

  const monthMarks = $derived.by(() => {
    const out: (string | null)[] = [];
    let previous = -1;
    for (let w = 0; w < WEEKS; w++) {
      const at = cells[w * 7].at;
      const month = new Date(at).getUTCMonth();
      out.push(month !== previous && w > 0 ? stamp(at, { month: "short" }) : null);
      previous = month;
    }
    return out;
  });

  const weekdayMarks = $derived(
    [0, 1, 2, 3, 4, 5, 6].map((row) =>
      row % 2 === 1 ? stamp(Date.UTC(2026, 0, 4 + row), { weekday: "short" }) : null,
    ),
  );

  function stamp(at: number, options: Intl.DateTimeFormatOptions): string {
    return new Date(at).toLocaleDateString(activeLocale(), { ...options, timeZone: "UTC" });
  }

  const activeDays = $derived(cells.filter((c) => !c.future && c.total > 0));

  const missingLabel = $derived(
    (report?.missing ?? []).map((m) => m.charAt(0).toUpperCase() + m.slice(1)).join(", "),
  );

  type Hover = { cell: Cell; rect: DOMRect };
  let hovered = $state<Hover | null>(null);
  let cardEl = $state<HTMLElement | null>(null);
  let cardW = $state(150);
  let cardH = $state(48);
  let openTimer: ReturnType<typeof setTimeout> | null = null;

  const OPEN_DELAY_MS = 90;
  const GAP = 6;
  const EDGE = 8;

  const open = $derived(hovered !== null);

  function aim(target: HTMLElement, cell: Cell) {
    hovered = { cell, rect: target.getBoundingClientRect() };
  }

  function point(event: PointerEvent) {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(".cal-cell");
    if (!target) return;
    const cell = cells[Number(target.dataset.i)];
    if (!cell || cell.future) return;
    if (hovered?.cell.day === cell.day) return;
    if (hovered) {
      aim(target, cell);
      return;
    }
    if (openTimer) clearTimeout(openTimer);
    openTimer = setTimeout(() => {
      openTimer = null;
      aim(target, cell);
    }, OPEN_DELAY_MS);
  }

  function hide() {
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    hovered = null;
  }

  $effect(() => {
    void hovered;
    if (!cardEl) return;
    cardW = cardEl.offsetWidth;
    cardH = cardEl.offsetHeight;
  });

  $effect(() => () => {
    if (openTimer) clearTimeout(openTimer);
  });

  $effect(() => {
    if (!open) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  });

  $effect(() => {
    if (!open) return;
    return registerEscape(hide);
  });

  const cardTop = $derived.by(() => {
    if (!hovered) return 0;
    const above = hovered.rect.top - cardH - GAP;
    return above < EDGE ? hovered.rect.bottom + GAP : above;
  });

  const cardLeft = $derived.by(() => {
    if (!hovered) return 0;
    const centred = hovered.rect.left + hovered.rect.width / 2 - cardW / 2;
    return Math.max(EDGE, Math.min(centred, window.innerWidth - cardW - EDGE));
  });

  const cardDay = $derived(
    hovered
      ? stamp(hovered.cell.at, { weekday: "short", day: "numeric", month: "short", year: "numeric" })
      : "",
  );
</script>

<DashboardCard title={t("home.tokens")}>
  {#snippet icon()}<Coins class="size-3.5" />{/snippet}
  {#snippet actions()}
    <button
      type="button"
      class="rounded-sm p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
      onclick={load}
      disabled={loading}
      title={t("project.tokensRefresh")}
      aria-label={t("project.tokensRefresh")}
    >
      <RefreshCw class={["size-3.5", loading && "animate-spin"]} />
    </button>
  {/snippet}

  {#if !report}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if report.unreachable}
    <p class="text-sm text-muted-foreground">{t("project.tokensUnreachable")}</p>
    <p class="mt-1 text-xs text-muted-foreground/70">
      {t("project.tokensUnreachableHint")}
    </p>
  {:else if total === 0}
    <p class="text-sm text-muted-foreground">{t("home.empty")}</p>
    <p class="mt-1 text-xs text-muted-foreground/70">
      {missingLabel
        ? t("project.tokensMissing", { agents: missingLabel })
        : t("project.tokensOnly")}
    </p>
  {:else}
    <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <p class="font-semibold tabular-nums text-2xl leading-none text-foreground">{fmt(total)}</p>
      <p class="text-xs text-muted-foreground/70">{t("project.tokensRange")}</p>
      <span class="flex-1"></span>
      {#if report.sessions > 0}
        <p class="tabular-nums text-xs text-muted-foreground/70">
          {t("project.tokensSessions", { count: report.sessions })}
        </p>
      {/if}
    </div>
    <!-- The conductor's share next to the workers', in the same card: two
         cards would invite adding them up, and they are one spend. -->
    {#if report.orchestratorTotal > 0}
      <p class="mt-1 tabular-nums text-xs text-muted-foreground/70">
        {t("home.tokensSplit", {
          workers: fmt(Math.max(0, total - report.orchestratorTotal)),
          orchestrator: fmt(report.orchestratorTotal),
          transcripts: report.orchestratorSessions,
        })}
      </p>
    {/if}

    <ul class="mt-2.5 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
      {#each report.models as model (model.provider + model.model)}
        <li class="flex min-w-0 items-center gap-2">
          <ShortcutIcon iconKey={providerIcon(model.provider)} size={13} />
          <span
            class="w-24 shrink-0 truncate text-sm text-foreground/85"
            title={model.model}
            aria-hidden="true"
          >
            {shortModel(model.model)}
          </span>
          <span class="sr-only">
            {model.model} · {model.input}
            {t("project.tokensIn")} · {model.output}
            {t("project.tokensOut")} · {model.cacheWrite}
            {t("project.tokensCacheWrite")} · {model.cacheRead}
            {t("project.tokensCacheRead")}
          </span>
          <span
            class="h-1.5 min-w-6 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]"
            aria-hidden="true"
          >
            <span
              class="block h-full rounded-full bg-foreground/45"
              style:width="{Math.max(2, Math.round((model.total / total) * 100))}%"
            ></span>
          </span>
          <span class="w-11 shrink-0 text-right tabular-nums text-xs text-muted-foreground">
            {fmt(model.total)}
          </span>
        </li>
      {/each}
    </ul>

    <ul class="sr-only" aria-label={t("project.tokensCalendar")}>
      {#each activeDays as day (day.day)}
        <li>{t("project.tokensDay", { total: fmt(day.total), day: day.day })}</li>
      {/each}
    </ul>

    <div class="cal mt-3" aria-hidden="true">
      <span></span>
      <div class="cal-months">
        {#each monthMarks as label, w (w)}
          <span class="text-2xs whitespace-nowrap text-muted-foreground/60">{label ?? ""}</span>
        {/each}
      </div>
      <div class="cal-weekdays">
        {#each weekdayMarks as label, row (row)}
          <span class="text-2xs leading-none text-muted-foreground/60">{label ?? ""}</span>
        {/each}
      </div>
      <div
        class="cal-grid"
        role="presentation"
        onpointerover={point}
        onpointerleave={hide}
        onpointerdown={hide}
      >
        {#each cells as cell, i (cell.day)}
          <span
            class={[
              "cal-cell",
              cell.future && "invisible",
              cell.today && "cal-today",
              hovered?.cell.day === cell.day && "cal-on",
            ]}
            data-i={i}
            style:background-color={cell.color}
          ></span>
        {/each}
      </div>
    </div>
    <div
      class="mt-1.5 flex items-center justify-end gap-1 text-2xs text-muted-foreground/70"
      aria-hidden="true"
    >
      <span>{t("project.tokensLess")}</span>
      {#each [0, 1, 2, 3, 4] as step (step)}
        <span class="size-[9px] rounded-[2px]" style:background-color={shade(step)}></span>
      {/each}
      <span>{t("project.tokensMore")}</span>
    </div>
    {#if missingLabel}
      <p class="mt-1 text-xs text-muted-foreground/70">
        {t("project.tokensMissing", { agents: missingLabel })}
      </p>
    {/if}
  {/if}
</DashboardCard>

{#if hovered}
  <div
    bind:this={cardEl}
    role="tooltip"
    class="surface-popover pointer-events-none fixed z-[var(--z-popover)] px-2.5 py-1.5"
    style:top="{cardTop}px"
    style:left="{cardLeft}px"
  >
    <p class="whitespace-nowrap text-2xs text-muted-foreground">{cardDay}</p>
    <p class="whitespace-nowrap tabular-nums text-sm font-medium text-foreground">
      {hovered.cell.total > 0
        ? t("project.tokensSpent", { total: fmt(hovered.cell.total) })
        : t("project.tokensQuiet")}
    </p>
  </div>
{/if}

<style>
  .cal {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 5px;
  }
  .cal-grid {
    display: grid;
    grid-auto-flow: column;
    grid-template-rows: repeat(7, minmax(0, 1fr));
    grid-auto-columns: minmax(0, 1fr);
    gap: 2px;
  }
  .cal-cell {
    aspect-ratio: 1;
    border-radius: 2px;
    min-width: 0;
    box-shadow: 0 0 0 0 transparent;
    transition: box-shadow 80ms ease-out;
  }
  .cal-today {
    box-shadow: 0 0 0 1px var(--color-muted-foreground);
  }
  .cal-on {
    box-shadow: 0 0 0 1.5px var(--color-foreground);
  }
  .cal-months {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    gap: 2px;
    overflow: hidden;
  }
  .cal-weekdays {
    display: grid;
    grid-template-rows: repeat(7, minmax(0, 1fr));
    gap: 2px;
    align-items: center;
    justify-items: end;
  }
</style>
