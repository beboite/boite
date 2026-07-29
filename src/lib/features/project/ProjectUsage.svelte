<script lang="ts">
  import { untrack } from "svelte";
  import { backendForPath } from "$lib/backend";
  import { app } from "$lib/app/store.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Coins from "@lucide/svelte/icons/coins";
  import { t } from "$lib/i18n/index.svelte";
  import type { UsageReport } from "$lib/backend/types";
  import type { IconKey, Project } from "$lib/types";

  /**
   * What this project's agents have spent, read out of their own transcripts.
   *
   * Boite counts nothing itself — it launches a CLI in a PTY and the CLI keeps
   * the record — so this is a read of `~/.claude/projects` and
   * `~/.codex/sessions`, done on the machine the agents ran on. It is the only
   * card here whose numbers are not already in a store, which is why it is the
   * only one with a refresh button.
   */
  type Props = { project: Project };
  let { project }: Props = $props();

  /** A year, so the calendar has the same span the one it looks like has. */
  const DAYS = 371;
  const WEEKS = 53;

  let report = $state<UsageReport | null>(null);
  let loading = $state(false);

  /**
   * Every directory this project's agents could have run in.
   *
   * The project folder is rarely one of them: since worktree isolation an
   * agent thread runs in a detached checkout somewhere else entirely, and the
   * stores key on the directory. A card that asked about the project folder
   * alone would report zero for a project that had burned millions.
   */
  const cwds = $derived.by(() => {
    const out = new Set<string>([project.cwd]);
    if (project.gitRoot) out.add(project.gitRoot);
    for (const thread of app.threadsByProject(project.id)) {
      if (thread.worktreePath) out.add(thread.worktreePath);
    }
    return [...out];
  });

  async function load() {
    if (loading) return;
    loading = true;
    try {
      report = await backendForPath(project.cwd).session.usage($state.snapshot(cwds), DAYS);
    } catch {
      // Nothing to say that an empty card does not already say: the stores are
      // read-only files that either parse or do not.
      report = { models: [], days: [], sessions: 0, missing: [] };
    } finally {
      loading = false;
    }
  }

  // Reads once per project. Nothing polls: a scan walks every transcript the
  // project has, and the answer only moves while an agent is mid-turn.
  //
  // The call is untracked. `load` reads and then writes `loading`, and reads
  // `cwds`, which moves every time a thread gets a worktree — tracked, the
  // effect would re-run on its own writes and re-scan on thread churn.
  $effect(() => {
    void project.id;
    untrack(() => void load());
  });

  const total = $derived(report?.models.reduce((sum, m) => sum + m.total, 0) ?? 0);
  const totals = $derived.by(() => {
    const acc = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    for (const m of report?.models ?? []) {
      acc.input += m.input;
      acc.output += m.output;
      acc.cacheWrite += m.cacheWrite;
      acc.cacheRead += m.cacheRead;
    }
    return acc;
  });

  function fmt(n: number): string {
    if (n >= 1_000_000) {
      const m = n / 1_000_000;
      return `${m >= 100 ? m.toFixed(0) : m.toFixed(m >= 10 ? 1 : 2)}M`;
    }
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  }

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
    // Back up to the Sunday that opens the earliest week in range, so every
    // column is seven cells and the weekday rows line up.
    const start = today - (WEEKS * 7 - 1) * DAY;
    const startSunday = start - new Date(start).getUTCDay() * DAY;
    const out: { day: string; total: number; future: boolean }[][] = [];
    for (let w = 0; w < WEEKS; w++) {
      const col: { day: string; total: number; future: boolean }[] = [];
      for (let d = 0; d < 7; d++) {
        const at = startSunday + (w * 7 + d) * DAY;
        const day = new Date(at).toISOString().slice(0, 10);
        col.push({ day, total: dayTotals.get(day) ?? 0, future: at > today });
      }
      out.push(col);
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

  const missingLabel = $derived(
    (report?.missing ?? []).map((m) => m.charAt(0).toUpperCase() + m.slice(1)).join(", "),
  );
</script>

<section class="rounded-lg border border-border bg-[var(--color-surface)] p-3">
  <header class="mb-2 flex items-center gap-1.5">
    <Coins class="size-3.5 text-muted-foreground" />
    <h2 class="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {t("project.tokens")}
    </h2>
    <span class="text-xs text-muted-foreground/70">
      {t("project.tokensRange")}
    </span>
    <span class="flex-1"></span>
    {#if total > 0}
      <span class="font-mono text-base text-foreground/90">{fmt(total)}</span>
    {/if}
    <button
      type="button"
      class="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
      onclick={load}
      disabled={loading}
      title={t("project.tokensRefresh")}
      aria-label={t("project.tokensRefresh")}
    >
      <RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
    </button>
  </header>

  {#if !report}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if total === 0}
    <p class="text-sm text-muted-foreground">{t("project.tokensNone")}</p>
    <p class="mt-1 text-xs text-muted-foreground/70">
      {missingLabel
        ? t("project.tokensMissing", { agents: missingLabel })
        : t("project.tokensOnly")}
    </p>
  {:else}
    <div class="grid gap-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <div class="min-w-0">
        <ul class="flex flex-col gap-1">
          {#each report.models as model (model.provider + model.model)}
            <li class="flex items-center gap-2">
              <ShortcutIcon iconKey={providerIcon(model.provider)} size={13} />
              <span
                class="min-w-0 flex-1 truncate text-sm text-foreground/85"
                title="{model.model} · {model.input} in · {model.output} out · {model.cacheWrite} cache written · {model.cacheRead} cache read"
              >
                {shortModel(model.model)}
              </span>
              <span
                class="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-[var(--color-surface-3)]"
              >
                <span
                  class="block h-full rounded-full bg-foreground/45"
                  style:width="{Math.max(4, Math.round((model.total / total) * 100))}%"
                ></span>
              </span>
              <span class="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {fmt(model.total)}
              </span>
            </li>
          {/each}
        </ul>

        <!-- Cache reads sit beside input rather than inside it. Folded in they
             are most of the volume and none of the work, and the card would
             read as twenty times the session that actually happened. -->
        <p class="mt-2 text-xs text-muted-foreground">
          {fmt(totals.input)} {t("project.tokensIn")} · {fmt(totals.output)}
          {t("project.tokensOut")} · {fmt(totals.cacheWrite)}
          {t("project.tokensCacheWrite")} · {fmt(totals.cacheRead)}
          {t("project.tokensCacheRead")}
        </p>
        <p class="mt-0.5 text-xs text-muted-foreground/70">
          {t("project.tokensSessions", { count: report.sessions })}
          {#if missingLabel}
            · {t("project.tokensMissing", { agents: missingLabel })}
          {/if}
        </p>
      </div>

      <div class="min-w-0 overflow-x-auto">
        <div class="flex gap-[3px]" aria-hidden="true">
          {#each weeks as week, w (w)}
            <div class="flex flex-col gap-[3px]">
              {#each week as cell (cell.day)}
                <span
                  class="size-[9px] rounded-[2px]"
                  class:invisible={cell.future}
                  style:background-color={cell.total === 0
                    ? "var(--color-surface-3)"
                    : `color-mix(in srgb, var(--color-foreground) ${level(cell.total) * 22}%, var(--color-surface-3))`}
                  title={cell.total === 0
                    ? t("project.tokensNothingOn", { day: cell.day })
                    : t("project.tokensDay", { total: fmt(cell.total), day: cell.day })}
                ></span>
              {/each}
            </div>
          {/each}
        </div>
        <div class="mt-1.5 flex items-center gap-1 text-2xs text-muted-foreground/70">
          <span>{t("project.tokensLess")}</span>
          {#each [0, 1, 2, 3, 4] as step (step)}
            <span
              class="size-[9px] rounded-[2px]"
              style:background-color={step === 0
                ? "var(--color-surface-3)"
                : `color-mix(in srgb, var(--color-foreground) ${step * 22}%, var(--color-surface-3))`}
            ></span>
          {/each}
          <span>{t("project.tokensMore")}</span>
        </div>
      </div>
    </div>
  {/if}
</section>
