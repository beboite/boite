<script lang="ts">
  import DashboardCard from "./DashboardCard.svelte";
  import { formatTokens as fmt, projectUsage } from "./usage.svelte";
  import { app } from "$lib/app/store.svelte";
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
  type Props = { project: Project; openTodos: number; commits: number };
  let { project, openTodos, commits }: Props = $props();

  const report = $derived(projectUsage.report(project.id));
  const threads = $derived(app.threadsByProject(project.id));

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

  // Two groups, because they answer different questions: what the project is,
  // and what its agents have burned reading it.
  const rows = $derived([
    { label: t("stats.threads"), value: String(threads.length) },
    { label: t("stats.openTodos"), value: String(openTodos) },
    { label: t("stats.commits"), value: commits > 0 ? String(commits) : "—" },
    { label: t("stats.sessions"), value: String(report?.sessions ?? 0) },
    { label: t("stats.models"), value: String(report?.models.length ?? 0) },
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
        <dd class="shrink-0 font-mono text-base text-foreground/90">{row.value}</dd>
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
            <dd class="shrink-0 font-mono text-sm text-foreground/85">{fmt(row.value)}</dd>
          </div>
        {/each}
      </dl>
    </div>
  {/if}
</DashboardCard>
