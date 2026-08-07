<script lang="ts">
  import { untrack } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import DashboardCard from "./DashboardCard.svelte";
  import { formatTokens as fmt, projectUsage } from "./usage.svelte";
  import { pathKey } from "./path";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Coins from "@lucide/svelte/icons/coins";
  import { t } from "$lib/i18n/index.svelte";
  import type { IconKey, Project } from "$lib/types";

  /**
   * What this project's agents have spent, read out of their own transcripts.
   *
   * Boite counts nothing itself — it launches a CLI in a PTY and the CLI keeps
   * the record — so this is a read of `~/.claude/projects` and
   * `~/.codex/sessions`, done on the machine the agents ran on. It is the only
   * card here whose numbers are not already in a store, which is why it is the
   * only one with a refresh button.
   *
   * The card says one thing: how much, and on which days. The breakdown that
   * used to sit beside the calendar is a card of its own now, which is what
   * freed the calendar to take the whole width — it was a fixed 636px grid in a
   * flexible column, so a card the width of two others ended in dead space.
   */
  type Props = { project: Project };
  let { project }: Props = $props();

  const WEEKS = 53;

  const report = $derived(projectUsage.report(project.id));
  const loading = $derived(projectUsage.loading(project.id));

  /**
   * Every directory this project's agents could have run in.
   *
   * The project folder is rarely one of them: since worktree isolation an
   * agent thread runs in a detached checkout somewhere else entirely, and the
   * stores key on the directory. A card that asked about the project folder
   * alone would report zero for a project that had burned millions.
   */
  const cwds = $derived.by(() => {
    // Deduplicated on the key and collected as they were written: two spellings
    // of one directory would have every transcript in it counted twice, and a
    // key is not a path the scan could be pointed at.
    const out = new Map<string, string>();
    const add = (path: string) => {
      if (!out.has(pathKey(path))) out.set(pathKey(path), path);
    };
    add(project.cwd);
    if (project.gitRoot) add(project.gitRoot);
    for (const thread of app.threadsByProject(project.id)) {
      if (thread.worktreePath) add(thread.worktreePath);
    }
    return [...out.values()];
  });

  function load() {
    void projectUsage.load(project, $state.snapshot(cwds));
  }

  // Reads once per project. Nothing polls: a scan walks every transcript the
  // project has, and the answer only moves while an agent is mid-turn.
  //
  // The call is untracked. It reads `cwds`, which moves every time a thread gets
  // a worktree, and writes the store it also reads — tracked, the effect would
  // re-scan on its own writes and on thread churn.
  $effect(() => {
    void project.id;
    untrack(() => projectUsage.ensure(project, $state.snapshot(cwds)));
  });

  const total = $derived(report?.models.reduce((sum, m) => sum + m.total, 0) ?? 0);

  /**
   * A model string down to the part that tells two of them apart. The stores
   * write the full deployment id — `claude-opus-5-20260114`, `gpt-5-codex` —
   * and the date suffix is the same width as the name in a card this size.
   */
  function shortModel(model: string): string {
    return model
      .replace(/^(claude|anthropic)[-.]/, "")
      .replace(/-\d{8}$/, "")
      .replace(/-latest$/, "");
  }

  function providerIcon(provider: string): IconKey {
    return provider === "codex" ? "codex" : provider === "claude" ? "claude" : null;
  }

  const dayTotals = $derived.by(() => {
    const map = new Map<string, number>();
    for (const d of report?.days ?? []) map.set(d.day, d.total);
    return map;
  });

  /**
   * The grid, as whole weeks ending on the one we are in.
   *
   * Built in UTC because the backend buckets in UTC: it takes the date off the
   * transcript's own ISO timestamp rather than converting it, and a grid built
   * in local time would look up days that store never wrote.
   */
  const weeks = $derived.by(() => {
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const DAY = 86_400_000;
    // The last column is the week we are in, whole. Anchoring the span on today
    // and only then backing up to a Sunday dropped the rest of the current week
    // off the right edge, so on a Tuesday the calendar stopped four days ago and
    // today's own square was not on it.
    const endSaturday = today + (6 - new Date(today).getUTCDay()) * DAY;
    const startSunday = endSaturday - (WEEKS * 7 - 1) * DAY;
    const out: { day: string; total: number; future: boolean; at: number }[][] = [];
    for (let w = 0; w < WEEKS; w++) {
      const col: { day: string; total: number; future: boolean; at: number }[] = [];
      for (let d = 0; d < 7; d++) {
        const at = startSunday + (w * 7 + d) * DAY;
        const day = new Date(at).toISOString().slice(0, 10);
        col.push({ day, total: dayTotals.get(day) ?? 0, future: at > today, at });
      }
      out.push(col);
    }
    return out;
  });

  /**
   * A name over the column each month opens in. The label is wider than the
   * column it sits in and is allowed to spill to the right, the way every
   * contribution calendar's is.
   */
  const monthMarks = $derived.by(() => {
    const out: (string | null)[] = [];
    let previous = -1;
    for (const week of weeks) {
      const month = new Date(week[0].at).getUTCMonth();
      // Skipped for the first column: a label there is half a month's worth of
      // days claiming the whole column.
      out.push(month !== previous && out.length > 0 ? monthName(week[0].at) : null);
      previous = month;
    }
    return out;
  });

  function monthName(at: number): string {
    return new Date(at).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
  }

  /**
   * The same year of data as a list, for anything that cannot read a grid of
   * coloured squares.
   *
   * Only the days that carry usage: an empty square says nothing a missing row
   * does not, and 371 "nothing on" rows would bury the handful that matter.
   */
  const activeDays = $derived.by(() => {
    const out: { day: string; total: number }[] = [];
    for (const week of weeks) {
      for (const cell of week) {
        if (!cell.future && cell.total > 0) out.push({ day: cell.day, total: cell.total });
      }
    }
    return out;
  });

  const peak = $derived(Math.max(1, ...(report?.days ?? []).map((d) => d.total)));

  /**
   * Four filled levels on a log scale. Linear, a single overnight run makes
   * every other day on the calendar the same empty square — token days differ
   * by orders of magnitude, not by percentages.
   */
  function level(value: number): number {
    if (value <= 0) return 0;
    const ratio = Math.log10(1 + value) / Math.log10(1 + peak);
    return Math.min(4, Math.max(1, Math.ceil(ratio * 4)));
  }

  function cellColor(total: number): string {
    if (total === 0) return "var(--color-surface-3)";
    return `color-mix(in srgb, var(--color-foreground) ${level(total) * 22}%, var(--color-surface-3))`;
  }

  const missingLabel = $derived(
    (report?.missing ?? []).map((m) => m.charAt(0).toUpperCase() + m.slice(1)).join(", "),
  );
</script>

<DashboardCard title={t("project.tokens")} class="lg:col-span-2">
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
      <RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
    </button>
  {/snippet}

  {#if !report}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if report.unreachable}
    <!-- Ahead of the empty case, which it is indistinguishable from by the
         numbers and the opposite of by meaning: no days and no models is a
         project that has spent nothing, and this is a project nobody managed
         to ask. Neither the calendar nor the model rows are drawn, because a
         year of the lightest square is an assertion about every one of those
         days. The refresh in the header is the way out and is already there. -->
    <p class="text-sm text-muted-foreground">{t("project.tokensUnreachable")}</p>
    <p class="mt-1 text-xs text-muted-foreground/70">
      {t("project.tokensUnreachableHint")}
    </p>
  {:else if total === 0}
    <p class="text-sm text-muted-foreground">{t("project.tokensNone")}</p>
    <p class="mt-1 text-xs text-muted-foreground/70">
      {missingLabel
        ? t("project.tokensMissing", { agents: missingLabel })
        : t("project.tokensOnly")}
    </p>
  {:else}
    <!-- The total on its own line rather than in a column beside the models:
         one short number next to eight rows left a third of the card empty and
         put the headline figure at the bottom of the hole. -->
    <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <p class="font-mono text-2xl leading-none text-foreground">{fmt(total)}</p>
      <p class="text-xs text-muted-foreground/70">{t("project.tokensRange")}</p>
      <span class="flex-1"></span>
      {#if report.sessions > 0}
        <p class="font-mono text-xs text-muted-foreground/70">
          {t("project.tokensSessions", { count: report.sessions })}
        </p>
      {/if}
    </div>

    <!-- One row per model, as a share of the whole rather than a second set of
         numbers: the figures are the card next door. Two columns from `sm` up,
         so eight models are four rows and the bars get the width they were
         being denied by a 16-unit cap next to a column of nothing. -->
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
          <span class="w-11 shrink-0 text-right font-mono text-xs text-muted-foreground">
            {fmt(model.total)}
          </span>
        </li>
      {/each}
    </ul>

    <!-- The grid stays hidden from assistive tech: 371 squares whose only
         label is a title read as nothing at all. This is the same year, as
         rows, and it is the only path to it without a cursor. -->
    <ul class="sr-only" aria-label={t("project.tokensCalendar")}>
      {#each activeDays as day (day.day)}
        <li>{t("project.tokensDay", { total: fmt(day.total), day: day.day })}</li>
      {/each}
    </ul>

    <!-- Sized by the card, not by the year: every column is a fraction of the
         width, so the calendar ends where the card does. -->
    <div class="mt-3" aria-hidden="true">
      <div class="cal-months mb-1">
        {#each monthMarks as label, w (w)}
          <span class="text-2xs whitespace-nowrap text-muted-foreground/60">
            {label ?? ""}
          </span>
        {/each}
      </div>
      <div class="cal-grid">
        {#each weeks as week, w (w)}
          {#each week as cell (cell.day)}
            <span
              class="cal-cell"
              class:invisible={cell.future}
              style:background-color={cellColor(cell.total)}
              title={cell.total === 0
                ? t("project.tokensNothingOn", { day: cell.day })
                : t("project.tokensDay", { total: fmt(cell.total), day: cell.day })}
            ></span>
          {/each}
        {/each}
      </div>
      <div class="mt-1.5 flex items-center justify-end gap-1 text-2xs text-muted-foreground/70">
        <span>{t("project.tokensLess")}</span>
        {#each [0, 1, 2, 3, 4] as step (step)}
          <span class="size-[9px] rounded-[2px]" style:background-color={step === 0
            ? "var(--color-surface-3)"
            : `color-mix(in srgb, var(--color-foreground) ${step * 22}%, var(--color-surface-3))`}
          ></span>
        {/each}
        <span>{t("project.tokensMore")}</span>
      </div>
    </div>
    {#if missingLabel}
      <p class="mt-1 text-xs text-muted-foreground/70">
        {t("project.tokensMissing", { agents: missingLabel })}
      </p>
    {/if}
  {/if}
</DashboardCard>

<style>
  /* One column per week, each a share of whatever the card is wide, and square
     cells derived from that. The old grid was 53 fixed 9px columns, so on a
     card wider than 636px it stopped and left a gap the size of the shortfall. */
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
  }
  /* The same columns as the grid below, so a month name sits over the week it
     opens. Labels are wider than a column and spill to the right on purpose. */
  .cal-months {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    gap: 2px;
    overflow: hidden;
  }
</style>
