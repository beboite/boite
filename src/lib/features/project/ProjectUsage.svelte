<script module lang="ts">
  const stampers = new Map<string, Intl.DateTimeFormat>();

  function stamper(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = `${locale}:${JSON.stringify(options)}`;
    let fmt = stampers.get(key);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
      stampers.set(key, fmt);
    }
    return fmt;
  }
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { app } from "$lib/app/store.svelte";
  import DashboardCard from "./DashboardCard.svelte";
  import { formatTokens as fmt, projectUsage } from "./usage.svelte";
  import { pathKey } from "./path";
  import { registerEscape } from "$lib/shared/keyboard/overlay";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Coins from "@lucide/svelte/icons/coins";
  import { activeLocale, t } from "$lib/i18n/index.svelte";
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
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
  /**
   * `hideCalendar` is the page saying the card is too narrow for a year: a
   * 53-column grid under 400px is a smear, not a picture, and the figures on
   * the line above it are the part that still reads.
   */
  type Props = { project: Project; hideCalendar?: boolean; class?: string };
  let { project, hideCalendar = false, class: klass = "" }: Props = $props();

  const WEEKS = 53;
  const DAY_MS = 86_400_000;

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
  // `cwds.length` is tracked so a thread that gains a worktree after arrival
  // asks again. The store write stays untracked: it writes the report this
  // effect also reads, and without the untrack that write would re-scan.
  $effect(() => {
    void project.id;
    void cwds.length;
    untrack(() => projectUsage.ensure(project, $state.snapshot(cwds)));
  });

  // totals() is the models sum, and that is the headline: the rows below are
  // the same number broken up, and a second figure taken off the squares
  // would make the two disagree. Days older than the grid still sit in it
  // (the scan windows by mtime); they are dropped from peak and from the
  // map so they cannot dim a year they are not on. The calendar is a window
  // of this number, not a second total.
  const total = $derived(projectUsage.totals(project.id).total);

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

  /** Four filled levels on a log scale, as a background. Linear, a single
      overnight run makes every other day on the calendar the same empty square
      — token days differ by orders of magnitude, not by percentages. */
  function shade(step: number): string {
    if (step <= 0) return "var(--color-surface-3)";
    return `color-mix(in srgb, var(--color-foreground) ${step * 22}%, var(--color-surface-3))`;
  }

  type Cell = {
    /** `YYYY-MM-DD`, UTC, and the key of the each block. */
    day: string;
    at: number;
    total: number;
    /** Past the end of the current week: drawn to keep the grid square, and
        never lit or hoverable. */
    future: boolean;
    today: boolean;
    color: string;
  };

  /**
   * The whole year, as one flat list in the order the grid fills.
   *
   * Flat and precomputed, both for the same reason: this is 371 cells, and
   * anything left as an expression on the cell is 371 calls every time
   * something on this card moves. The colour was one, and the tooltip text was
   * two more — a `t()` lookup and an interpolation per square, eagerly, for the
   * one square the cursor was over.
   *
   * Built in UTC because the backend buckets in UTC: it takes the date off the
   * transcript's own ISO timestamp rather than converting it, and a grid built
   * in local time would look up days that store never wrote.
   *
   * `relativeClock.now` is the day, not `new Date()`. The parent tree already
   * ticks that clock; a snapshot of wall time left "today" sitting on yesterday
   * after UTC midnight until something else reran this derived.
   */
  const cells = $derived.by(() => {
    const now = new Date(relativeClock.now);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    // The last column is the week we are in, whole. Anchoring the span on today
    // and only then backing up to a Sunday dropped the rest of the current week
    // off the right edge, so on a Tuesday the calendar stopped four days ago and
    // today's own square was not on it.
    const endSaturday = today + (6 - new Date(today).getUTCDay()) * DAY_MS;
    const start = endSaturday - (WEEKS * 7 - 1) * DAY_MS;
    const firstDay = new Date(start).toISOString().slice(0, 10);
    const totals = new Map<string, number>();
    let peak = 1;
    for (const d of report?.days ?? []) {
      // The scan windows transcripts by file mtime, so a file touched this
      // week can carry a day from last year. Those days never land on a
      // square; counting them in peak dims every visible one against a day
      // nobody can see.
      if (d.day < firstDay) continue;
      totals.set(d.day, d.total);
      if (d.total > peak) peak = d.total;
    }
    const ceiling = Math.log10(1 + peak);
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

  /**
   * A name over the column each month opens in. The label is wider than the
   * column it sits in and is allowed to spill to the right, the way every
   * contribution calendar's is.
   */
  const monthMarks = $derived.by(() => {
    const out: (string | null)[] = [];
    let previous = -1;
    for (let w = 0; w < WEEKS; w++) {
      const at = cells[w * 7].at;
      const month = new Date(at).getUTCMonth();
      // Skipped for the first column: a label there is half a month's worth of
      // days claiming the whole column.
      out.push(month !== previous && w > 0 ? stamp(at, { month: "short" }) : null);
      previous = month;
    }
    return out;
  });

  /**
   * Monday, Wednesday and Friday down the left edge.
   *
   * Three rather than seven, because seven labels in rows nine pixels apart is
   * a wall of text beside the picture it is meant to be indexing. The dates are
   * a week in 2026 that starts on a Sunday, so the row order matches the grid's.
   */
  const weekdayMarks = $derived(
    [0, 1, 2, 3, 4, 5, 6].map((row) =>
      row % 2 === 1 ? stamp(Date.UTC(2026, 0, 4 + row), { weekday: "short" }) : null,
    ),
  );

  function stamp(at: number, options: Intl.DateTimeFormatOptions): string {
    return stamper(activeLocale(), options).format(at);
  }

  /**
   * The same year of data as a list, for anything that cannot read a grid of
   * coloured squares.
   *
   * Only the days that carry usage: an empty square says nothing a missing row
   * does not, and 371 "nothing on" rows would bury the handful that matter.
   */
  const activeDays = $derived(cells.filter((c) => !c.future && c.total > 0));

  /**
   * A year of empty squares is not a picture of anything.
   *
   * With one coloured cell in it the calendar was still the largest element on
   * the dashboard of a project that had been run twice, and every square in it
   * was an assertion that nothing happened that day, made 370 times. Under two
   * the card keeps its totals and offers the year rather than insisting on it.
   */
  const sparse = $derived(activeDays.length < 2);
  let showYear = $state(false);
  const calendar = $derived(!hideCalendar && (!sparse || showYear));

  const missingLabel = $derived(
    (report?.missing ?? []).map((m) => m.charAt(0).toUpperCase() + m.slice(1)).join(", "),
  );

  // ------------------------------------------------------------ the hover card

  /**
   * Which square the cursor is on, and where that square is.
   *
   * This used to be the browser's own `title` tooltip, which is the one popup
   * on screen nothing here could do anything about: it appears when the OS says
   * so — the better part of a second — it is styled by the OS and not by this
   * app, and it cannot show the day and the figure as two lines. It also cost
   * 371 interpolated strings on every render to describe the one square being
   * pointed at.
   */
  type Hover = { cell: Cell; rect: DOMRect };
  let hovered = $state<Hover | null>(null);
  let cardEl = $state<HTMLElement | null>(null);
  let cardW = $state(150);
  let cardH = $state(48);
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let sizeKey = "";

  /**
   * Long enough not to fire on a cursor crossing the calendar on its way
   * somewhere else, short enough to read as no delay at all — and paid once.
   * Moving from square to square inside the grid re-aims a card that is already
   * up, which is the motion this thing is actually used with: a heat map is
   * read by sweeping it, and re-arming a timer per square is what made the
   * native tooltip unusable for that.
   */
  const OPEN_DELAY_MS = 90;
  const GAP = 6;
  const EDGE = 8;

  const open = $derived(hovered !== null);

  function aim(target: HTMLElement, cell: Cell) {
    hovered = { cell, rect: target.getBoundingClientRect() };
  }

  function point(event: PointerEvent) {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(".cal-cell");
    // The 2px gutters between squares are the grid itself. Crossing one is not
    // leaving the calendar, so it must not close what is open.
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

  function down(event: PointerEvent) {
    // A mouse down still dismisses, the way a click on a hover card does.
    // Pointerdown on touch used to fire the same hide and kill the tap that
    // had just opened it; a tap now toggles, and pointerleave is ignored for
    // the same pointers so lifting the finger does not close it.
    if (event.pointerType === "mouse") {
      hide();
      event.preventDefault();
      return;
    }
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(".cal-cell");
    if (!target) return;
    const cell = cells[Number(target.dataset.i)];
    if (!cell || cell.future) return;
    if (hovered?.cell.day === cell.day) {
      hide();
      return;
    }
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    aim(target, cell);
  }

  function leave(event: PointerEvent) {
    if (event.pointerType !== "mouse") return;
    hide();
  }

  function onCellFocus(event: FocusEvent) {
    const target = event.currentTarget as HTMLElement;
    const cell = cells[Number(target.dataset.i)];
    if (!cell || cell.future) return;
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    aim(target, cell);
  }

  function onCellBlur(event: FocusEvent) {
    const next = event.relatedTarget as HTMLElement | null;
    if (next?.closest(".cal-grid")) return;
    hide();
  }

  // A pending open outlives the pane it was armed in otherwise: leaving the
  // project page mid-sweep left a timer that fired into a component nobody was
  // looking at.
  $effect(() => () => {
    if (openTimer) clearTimeout(openTimer);
  });

  // The card is positioned against a rectangle read when the cursor arrived, so
  // anything that moves the page underneath it makes that rectangle a lie.
  // Closing is the honest answer: the cursor is still over a square and the
  // next move re-aims immediately.
  $effect(() => {
    if (!open) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  });

  // Through the app's one Escape stack, so a menu over this card still gets the
  // key first.
  $effect(() => {
    if (!open) return;
    return registerEscape(hide);
  });

  /** Above the square, and below it when there is no room above. */
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

  // The card's size only moves with the day string and whether that day spent
  // anything. Sweeping the heat map used to reread offsetWidth on every square
  // for a number that had not changed.
  $effect(() => {
    if (!hovered || !cardEl) {
      sizeKey = "";
      return;
    }
    const key = `${cardDay.length}:${hovered.cell.total > 0 ? 1 : 0}`;
    if (key === sizeKey) return;
    sizeKey = key;
    cardW = cardEl.offsetWidth;
    cardH = cardEl.offsetHeight;
  });
</script>

<DashboardCard title={t("project.tokens")} class={klass}>
  {#snippet icon()}<Coins class="size-3.5" />{/snippet}
  {#snippet actions()}
    <button
      type="button"
      class="rounded-sm p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
      onclick={load}
      disabled={loading}
      use:tip={t("project.tokensRefresh")}
      aria-label={t("project.tokensRefresh")}
    >
      <RefreshCw class={["size-3.5", loading && "animate-spin"]} />
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
    <p class="mt-1 text-xs text-muted-2">
      {t("project.tokensUnreachableHint")}
    </p>
  {:else if total === 0}
    <p class="text-sm text-muted-foreground">{t("project.tokensNone")}</p>
    <p class="mt-1 text-xs text-muted-2">
      {missingLabel
        ? t("project.tokensMissing", { agents: missingLabel })
        : t("project.tokensOnly")}
    </p>
  {:else}
    <!-- The total on its own line rather than in a column beside the models:
         one short number next to eight rows left a third of the card empty and
         put the headline figure at the bottom of the hole. -->
    <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <p class="font-semibold tabular-nums text-2xl leading-none text-foreground">{fmt(total)}</p>
      <p class="text-xs text-muted-2">{t("project.tokensRange")}</p>
      <span class="flex-1"></span>
      {#if report.sessions > 0}
        <p class="tabular-nums text-xs text-muted-2">
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
            class="w-24 shrink-0 truncate text-sm text-foreground"
            use:tip={model.model}
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

    <!-- The year as rows, for anything that cannot point at a square. The grid
         itself is now a tab stop: a keyboard opens the same card the cursor
         does, so this list is no longer the only path without a pointer. -->
    <ul class="sr-only" aria-label={t("project.tokensCalendar")}>
      {#each activeDays as day (day.day)}
        <li>{t("project.tokensDay", { total: fmt(day.total), day: day.day })}</li>
      {/each}
    </ul>

    {#if sparse && !hideCalendar}
      <button
        type="button"
        class="mt-2 text-xs text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
        onclick={() => (showYear = !showYear)}
        aria-expanded={showYear}
      >
        {showYear ? t("project.tokensHideYear") : t("project.tokensShowYear")}
      </button>
    {/if}

    {#if calendar}
    <!-- Sized by the card, not by the year: every column is a fraction of the
         width, so the calendar ends where the card does. -->
    <div class="cal mt-3">
      <span></span>
      <div class="cal-months" aria-hidden="true">
        {#each monthMarks as label, w (w)}
          <span class="text-2xs whitespace-nowrap text-muted-2">{label ?? ""}</span>
        {/each}
      </div>
      <div class="cal-weekdays" aria-hidden="true">
        {#each weekdayMarks as label, row (row)}
          <span class="text-2xs leading-none text-muted-2">{label ?? ""}</span>
        {/each}
      </div>
      <!-- One listener for the year rather than 371. `pointerover` fires once
           per square entered, which is the event this needs; a move handler
           would fire per pixel for the same answer. -->
      <div
        class="cal-grid"
        role="group"
        aria-label={t("project.tokensCalendar")}
        onpointerover={point}
        onpointerleave={leave}
        onpointerdown={down}
      >
        {#each cells as cell, i (cell.day)}
          {#if cell.future}
            <span class="cal-cell invisible" data-i={i} style:background-color={cell.color}></span>
          {:else}
            <button
              type="button"
              class={[
                "cal-cell",
                cell.today && "cal-today",
                hovered?.cell.day === cell.day && "cal-on",
              ]}
              data-i={i}
              style:background-color={cell.color}
              aria-label={t("project.tokensDay", { total: fmt(cell.total), day: cell.day })}
              onfocus={onCellFocus}
              onblur={onCellBlur}
            ></button>
          {/if}
        {/each}
      </div>
    </div>
    <div
      class="mt-1.5 flex items-center justify-end gap-1 text-2xs text-muted-2"
      aria-hidden="true"
    >
      <span>{t("project.tokensLess")}</span>
      {#each [0, 1, 2, 3, 4] as step (step)}
        <span class="size-[9px] rounded-[2px]" style:background-color={shade(step)}></span>
      {/each}
      <span>{t("project.tokensMore")}</span>
    </div>
    {/if}
    {#if missingLabel}
      <p class="mt-1 text-xs text-muted-2">
        {t("project.tokensMissing", { agents: missingLabel })}
      </p>
    {/if}
  {/if}
</DashboardCard>

{#if hovered}
  <!-- Outside the card, because the card is inside a scroller and a popup
       clipped by the thing it hangs off is worse than no popup. -->
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
  /* The gutter of weekday names, then everything that spans the year. Both rows
     share one column track, so a month name and a square in the same week line
     up without either of them knowing the gutter's width. */
  .cal {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 4px 5px;
  }
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
    width: 100%;
    padding: 0;
    border: 0;
    margin: 0;
    display: block;
    appearance: none;
    font: inherit;
    /* Only the ring moves, so pointing at a square never reflows the grid. */
    box-shadow: 0 0 0 0 transparent;
    transition: box-shadow 80ms ease-out;
  }
  .cal-cell:focus {
    outline: none;
  }
  .cal-today {
    box-shadow: 0 0 0 1px var(--color-muted-foreground);
  }
  .cal-on {
    box-shadow: 0 0 0 1.5px var(--color-foreground);
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
  /* The same seven rows as the grid, so a name sits on the row it names. */
  .cal-weekdays {
    display: grid;
    grid-template-rows: repeat(7, minmax(0, 1fr));
    gap: 2px;
    align-items: center;
    justify-items: end;
  }
</style>
