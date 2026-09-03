<script lang="ts">
  import DashboardCard from "./DashboardCard.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { formatTokens as fmt, projectUsage } from "./usage.svelte";
  import ChartNoAxesColumn from "@lucide/svelte/icons/chart-no-axes-column";
  import { t } from "$lib/i18n/index.svelte";
  import type { Project } from "$lib/types";

  /**
   * The figures, away from the picture.
   *
   * They used to live under the token calendar as two paragraphs of running
   * text — "1.2M in · 340k out · 8M cache written · 60M cache read · 42
   * sessions" — which is a card asking to be read word by word to answer
   * questions that are each one number. Same numbers, one per row, and the
   * calendar next door is left saying the one thing it says well.
   *
   * Nothing here is fetched: the usage store is already loaded by the card
   * beside this one, and the rest is counted off state the app holds.
   */
  type Props = {
    project: Project;
    openTodos: number;
    commits: number;
    /** The same list the Threads card draws, settled ones already gone. */
    threadCount: number;
    gitLoaded: boolean;
    gitIsRepo: boolean;
  };
  let { project, openTodos, commits, threadCount, gitLoaded, gitIsRepo }: Props = $props();

  const report = $derived(projectUsage.report(project.id));

  const totals = $derived.by(() => {
    const acc = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
    for (const m of report?.models ?? []) {
      acc.input += m.input;
      acc.output += m.output;
      acc.cacheWrite += m.cacheWrite;
      acc.cacheRead += m.cacheRead;
      acc.total += m.total;
    }
    return acc;
  });

  // The transcripts were never read, so the two rows that come out of them
  // have no number behind them. A missing report is the same unknown as an
  // unreachable one: `0` is a count we never made, and the first scan used
  // to print that fake zero until the usage card landed.
  const unread = $derived(!report || report.unreachable);
  const unreadHint = $derived(unread ? t("project.tokensUnreachable") : null);

  // Two groups, because they answer different questions: what the project is,
  // and what its agents have burned reading it. A real empty repo has zero
  // commits; the dash is for when we have not read one, not for a count of
  // zero.
  const rows = $derived([
    { label: t("stats.threads"), value: String(threadCount), hint: null },
    { label: t("stats.openTodos"), value: String(openTodos), hint: null },
    {
      label: t("stats.commits"),
      value: gitLoaded && gitIsRepo ? String(commits) : "—",
      hint: null,
    },
    {
      label: t("stats.sessions"),
      value: unread ? "—" : String(report?.sessions ?? 0),
      hint: unreadHint,
    },
    {
      label: t("stats.models"),
      value: unread ? "—" : String(report?.models.length ?? 0),
      hint: unreadHint,
    },
  ]);

  // Cache reads sit beside input rather than inside it. Folded in they are most
  // of the volume and none of the work, and the card would read as twenty times
  // the session that actually happened.
  const tokenRows = $derived([
    { label: t("project.tokensIn"), value: totals.input },
    { label: t("project.tokensOut"), value: totals.output },
    { label: t("project.tokensCacheWrite"), value: totals.cacheWrite },
    { label: t("project.tokensCacheRead"), value: totals.cacheRead },
  ]);
</script>

<DashboardCard title={t("stats.title")}>
  {#snippet icon()}<ChartNoAxesColumn class="size-3.5" />{/snippet}

  <dl class="flex flex-col">
    {#each rows as row (row.label)}
      <div
        class="flex items-baseline justify-between gap-3 border-b border-border/60 py-1 last:border-0"
      >
        <dt class="truncate text-sm text-muted-foreground">{row.label}</dt>
        <!-- The hint is only ever on a dash, and only when the dash stands for
             a read that never happened. Absent otherwise, so nothing here
             grows a tooltip that says what the number already says. -->
        <dd class="shrink-0 font-medium tabular-nums text-base text-foreground" use:tip={row.hint}>
          {row.value}
        </dd>
      </div>
    {/each}
  </dl>

  {#if totals.total > 0}
    <div class="mt-2.5 rounded-md bg-[var(--color-surface-2)] px-2.5 py-2">
      <p class="section-label mb-1">{t("stats.tokenBreakdown")}</p>
      <dl class="flex flex-col gap-0.5">
        {#each tokenRows as row (row.label)}
          <div class="flex items-baseline justify-between gap-3">
            <dt class="truncate text-sm text-muted-foreground">{row.label}</dt>
            <dd class="shrink-0 font-medium tabular-nums text-sm text-foreground">{fmt(row.value)}</dd>
          </div>
        {/each}
      </dl>
    </div>
  {/if}
</DashboardCard>
