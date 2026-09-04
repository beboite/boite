<script lang="ts">
  /**
   * The model chip, and the menu behind it.
   *
   * One component for the two places that need it, the pane header and the
   * composer, because a chip that looked different in the two would be two
   * ideas of what the thread is running on. `compact` is the header's; the
   * composer's is the resting size, and `placement` is which way the popover
   * hangs.
   *
   * What a row reads is `models.ts` and not the catalog: `pilot.catalog` hands
   * over ids, and a menu drawn straight off them listed `fable`,
   * `claude-fable-5-1` and `claude-fable-5` as three rows for what is one
   * choice. Now the four aliases lead, named after the id each resolves to
   * ("Claude Fable 5.1"), the newest family wears a badge, the first three take
   * Ctrl+1 to Ctrl+3, and every pinned id folds under one "Legacy models" row
   * that opens in place.
   *
   * The rule the menu is still built around: **it says what the click will do
   * before the click.** `selection.ts` answers that off the catalog. It is one
   * line under the search rather than a word on every row, because the answer
   * is the same for every row of an account and repeating it fifteen times said
   * nothing fifteen times. A row that cannot be clicked at all keeps its own
   * word, since that one is a reason rather than a repetition.
   *
   * The tint is the sidebar's own (`fastpick/accent.ts`): a fastpick route is
   * coloured by what is actually answering, which is the one thing a model name
   * on its own does not say.
   *
   * Keyboard: the arrows walk the enabled rows, Enter takes one, Ctrl+1 to
   * Ctrl+3 take the first three, Escape closes and hands focus back to the
   * chip. The rows are built as three ordered lists and walked as their
   * concatenation, so what a key lands on is what the eye is on.
   */
  import { backend } from "$lib/backend";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { log } from "$lib/shared/log";
  import { t } from "$lib/i18n/index.svelte";
  import { ACCENT_COLOR, modelFamily } from "$lib/features/fastpick/accent";
  import { groupModels, isCurrentModel, modelLabel, newestAlias, resolveAlias } from "./models";
  import { instancesOf, switchOutcome, type SwitchOutcome } from "./selection";
  import type {
    PilotCatalog,
    PilotInstance,
    PilotInstanceEntry,
  } from "./types";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Search from "@lucide/svelte/icons/search";

  type Props = {
    threadId: string;
    catalog: PilotCatalog | null;
    driver: string;
    /** The instance name the row carries, or null before one is known. */
    instance: string | null;
    model: string | null;
    /** The header's size. The composer takes the resting one. */
    compact?: boolean;
    /** Which way the popover hangs off the chip. */
    placement?: "up" | "down";
    /** The header aligns its menu to the right edge, the composer to the left. */
    align?: "left" | "right";
    /** Held by the pane so Ctrl+M can open this from the composer. */
    open?: boolean;
  };
  let {
    threadId,
    catalog,
    driver,
    instance,
    model,
    compact = false,
    placement = "down",
    align = "left",
    open = $bindable(false),
  }: Props = $props();

  let busy = $state(false);
  let query = $state("");
  let cursor = $state(0);
  /** Whether the pinned ids are unfolded. Folded is what the menu opens on. */
  let foldOpen = $state(false);
  let trigger: HTMLButtonElement | null = $state(null);
  let field: HTMLInputElement | null = $state(null);
  /** The chip and its menu together, so a click outside is one containment test. */
  let root: HTMLDivElement | null = $state(null);

  const drivers = $derived(catalog?.drivers ?? []);
  const capabilities = $derived(drivers.find((entry) => entry.id === driver)?.capabilities ?? null);
  const accounts = $derived(instancesOf(catalog?.instances ?? [], driver));
  const models = $derived(drivers.find((entry) => entry.id === driver)?.models ?? []);

  /**
   * The account name the row actually carries, as the catalog spells it.
   *
   * A thread row stores its instance as JSON and the pane turns a native one
   * into the word `native`, which is not what the catalog calls it. Compared
   * raw, the account the thread is already on never matches itself, and every
   * row of the menu read "restarts on the same session" including the one
   * already selected. Resolved here rather than in the pane because this is
   * the component holding the catalog.
   */
  const here = $derived.by(() => {
    if (instance !== "native") return instance;
    return accounts.find((entry) => entry.kind === "native")?.name ?? instance;
  });

  /** The tint a row wears, off the model it names. */
  const tint = (name: string | null): string | null =>
    name ? ACCENT_COLOR[modelFamily(name)] : null;

  /**
   * The chip's own label.
   *
   * A thread on the alias `fable` is on whatever `fable` answers today, so the
   * chip says that rather than the bare family name: the version is the half a
   * reader is checking when they look at it.
   */
  const label = $derived.by(() => {
    if (!model) return t("pilot.picker");
    const full = resolveAlias(model, models) ?? model;
    return modelLabel(full) ?? t("pilot.picker");
  });

  /** One choosable line of the menu: an account, a model, and what it will do. */
  interface Row {
    key: string;
    entry: PilotInstanceEntry;
    /** What a click sends. Null for an account with no model list at all. */
    model: string | null;
    label: string;
    /** The muted line under the name: the id this row names. */
    sub: string;
    group: string;
    outcome: SwitchOutcome;
    current: boolean;
    /** The newest family, which is the one row worth pointing at. */
    badge: boolean;
    /** Ctrl+1 to Ctrl+3, assigned to the first three rows a key can land on. */
    shortcut: number | null;
  }

  function outcomeOf(entry: PilotInstanceEntry): SwitchOutcome {
    return switchOutcome(
      { driver, instance: here },
      { driver: entry.driver, instance: entry.name },
      capabilities,
    );
  }

  /** A route or another driver's account: one model by construction. */
  function singleRow(entry: PilotInstanceEntry, group: string): Row {
    const id = entry.model ?? entry.name;
    return {
      key: `${entry.name}::${id}`,
      entry,
      model: id,
      label: modelLabel(id) ?? id,
      sub: id,
      group,
      outcome: outcomeOf(entry),
      current: entry.name === here,
      badge: false,
      shortcut: null,
    };
  }

  const native = $derived(accounts.filter((entry) => entry.kind === "native"));
  const routes = $derived(accounts.filter((entry) => entry.kind !== "native"));
  /**
   * Another driver is a graft and is phase 4. Its accounts are listed and
   * disabled rather than hidden: a menu that hides what it cannot do yet
   * teaches the user the driver does not exist.
   */
  const foreign = $derived((catalog?.instances ?? []).filter((entry) => entry.driver !== driver));

  const split = $derived(groupModels(models));
  const newest = $derived(newestAlias(models));

  const primaryRows = $derived.by((): Row[] => {
    const out: Row[] = [];
    for (const entry of native) {
      const outcome = outcomeOf(entry);
      if (split.primary.length === 0) {
        out.push({
          key: entry.name,
          entry,
          model: null,
          label: entry.label,
          sub: "",
          group: entry.label,
          outcome,
          current: entry.name === here,
          badge: false,
          shortcut: null,
        });
        continue;
      }
      for (const choice of split.primary) {
        out.push({
          key: `${entry.name}::${choice.id}`,
          entry,
          model: choice.id,
          label: choice.label,
          sub: choice.resolved ?? choice.id,
          group: entry.label,
          outcome,
          current: entry.name === here && isCurrentModel(choice, model),
          badge: choice.id === newest,
          shortcut: null,
        });
      }
    }
    return out;
  });

  const legacyRows = $derived.by((): Row[] => {
    const out: Row[] = [];
    for (const entry of native) {
      const outcome = outcomeOf(entry);
      for (const choice of split.legacy) {
        out.push({
          key: `${entry.name}::${choice.id}`,
          entry,
          model: choice.id,
          label: choice.label,
          sub: choice.id,
          group: entry.label,
          outcome,
          current: entry.name === here && isCurrentModel(choice, model),
          badge: false,
          shortcut: null,
        });
      }
    }
    return out;
  });

  const otherRows = $derived([
    // A route is grouped by the provider answering it, not by its own label:
    // one group per row was fifteen headings over fifteen lines.
    ...routes.map((entry) => singleRow(entry, entry.provider ?? entry.label)),
    ...foreign.map((entry) => singleRow(entry, entry.driver)),
  ]);

  const needle = $derived(query.trim().toLowerCase());
  const match = (row: Row): boolean =>
    needle.length === 0 ||
    row.label.toLowerCase().includes(needle) ||
    row.sub.toLowerCase().includes(needle) ||
    row.group.toLowerCase().includes(needle);

  const primaryShown = $derived(primaryRows.filter(match));
  const legacyMatched = $derived(legacyRows.filter(match));
  const otherShown = $derived(otherRows.filter(match));

  /**
   * The fold, open when it has to be.
   *
   * A search that matched something inside it, or a thread pinned to one of the
   * ids in it: both are cases where leaving it shut hides the very row the
   * reader came for.
   */
  const unfolded = $derived(
    foldOpen || needle.length > 0 || legacyRows.some((row) => row.current),
  );
  const legacyShown = $derived(unfolded ? legacyMatched : []);

  /** The menu in reading order, which is also the order a key walks. */
  const shown = $derived([...primaryShown, ...legacyShown, ...otherShown]);
  /** The rows a key can land on. A disabled row is read, never selected. */
  const reachable = $derived(shown.filter((row) => row.outcome.enabled));
  /** Ctrl+1 to Ctrl+3, on the first three rows a key can land on. */
  const shortcuts = $derived(reachable.slice(0, 3));
  const shortcutOf = (row: Row): number | null => {
    const at = shortcuts.indexOf(row);
    return at === -1 ? null : at + 1;
  };

  /**
   * The one line saying what a click will do.
   *
   * The cursored row's own answer, which is the row the pointer is over as well
   * as the one the arrows are on: `onpointerenter` moves the same cursor.
   */
  const hint = $derived(reachable[cursor]?.outcome ?? reachable[0]?.outcome ?? null);

  function instanceValue(entry: PilotInstanceEntry): PilotInstance {
    return entry.kind === "fastpick"
      ? { type: "fastpick", provider: entry.provider ?? "", model: entry.model ?? "" }
      : { type: "native", config_dir: entry.configDir ?? null };
  }

  function toggle() {
    open = !open;
    if (open) {
      query = "";
      cursor = 0;
      foldOpen = false;
    }
  }

  function close(focusBack = true) {
    open = false;
    if (focusBack) trigger?.focus();
  }

  async function pick(row: Row) {
    if (!row.outcome.enabled || busy) return;
    busy = true;
    try {
      await backend().pilot.setModel(threadId, {
        model: row.model,
        instance: instanceValue(row.entry),
      });
      close();
    } catch (err) {
      log.warn("pilot.picker", "pilot.setModel.failed", {
        thread: threadId,
        reason: String(err),
      });
      notifications.error(t("pilot.switchFailed"));
    } finally {
      busy = false;
    }
  }

  function onMenuKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey) {
      const at = Number(event.key);
      if (Number.isInteger(at) && at >= 1 && at <= shortcuts.length) {
        event.preventDefault();
        void pick(shortcuts[at - 1]);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = reachable.length;
      if (count === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      cursor = (((cursor + step) % count) + count) % count;
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = reachable[cursor];
      if (row) void pick(row);
    }
  }

  // The field takes focus so the first keystroke filters rather than being
  // eaten by whatever had it. A menu opened from Ctrl+M has to do the same,
  // which is why this watches `open` rather than living in the click handler.
  $effect(() => {
    if (open) field?.focus();
  });

  // A filter that shortened the list under the cursor would leave it pointing
  // past the end, and Enter would take nothing.
  $effect(() => {
    if (cursor >= reachable.length) cursor = 0;
  });
</script>

<svelte:window
  onpointerdown={(event) => {
    if (!open) return;
    const target = event.target as Node | null;
    if (target && !root?.contains(target)) close(false);
  }}
/>

{#snippet line(row: Row, heading: boolean)}
  {#if heading}
    <p class="px-2.5 pt-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {row.group}
    </p>
  {/if}
  <button
    type="button"
    role="menuitemradio"
    aria-checked={row.current}
    class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 {reachable[
      cursor
    ] === row
      ? 'bg-[var(--color-surface-3)]'
      : ''} hover:bg-[var(--color-surface-3)]"
    disabled={!row.outcome.enabled || busy}
    onclick={() => void pick(row)}
    onpointerenter={() => {
      const found = reachable.indexOf(row);
      if (found >= 0) cursor = found;
    }}
    data-testid="chat-model-row"
    data-model={row.model ?? ""}
    data-current={row.current}
  >
    <span
      class="size-2 shrink-0 rounded-full"
      style:background={tint(row.model) ?? "var(--color-muted-foreground)"}
    ></span>
    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5">
        <span
          class="min-w-0 truncate text-sm {row.current
            ? 'font-medium text-foreground'
            : 'text-foreground'}">{row.label}</span
        >
        {#if row.badge}
          <span
            class="shrink-0 rounded-sm bg-[var(--color-surface-3)] px-1 py-px text-[0.625rem] font-semibold tracking-wide text-foreground uppercase"
          >
            {t("pilot.modelNew")}
          </span>
        {/if}
      </span>
      {#if row.sub}
        <span class="block truncate font-mono text-xs text-muted-foreground">{row.sub}</span>
      {/if}
    </span>
    {#if !row.outcome.enabled}
      <span class="shrink-0 text-xs text-muted-foreground">{t(row.outcome.key)}</span>
    {:else if shortcutOf(row) !== null}
      <kbd
        class="shrink-0 rounded border border-border px-1 py-px font-mono text-[0.625rem] text-muted-foreground"
      >
        {t("pilot.modelShortcut", { n: String(shortcutOf(row)) })}
      </kbd>
    {/if}
  </button>
{/snippet}

<div class="relative" bind:this={root}>
  <button
    bind:this={trigger}
    type="button"
    class="press flex max-w-[15rem] items-center gap-1.5 rounded-full border border-border bg-[var(--color-surface-2)] text-muted-foreground transition hover:border-edge hover:text-foreground focus:outline-none focus-visible:focus-ring {compact
      ? 'h-6 px-2 text-xs'
      : 'h-7 px-2.5 text-xs'}"
    onclick={toggle}
    aria-expanded={open}
    aria-haspopup="menu"
    aria-label={t("pilot.pickerOpen")}
    data-testid="chat-model-chip"
    data-model={model ?? ""}
  >
    <span
      class="size-2 shrink-0 rounded-full"
      style:background={tint(model) ?? "var(--color-muted-foreground)"}
    ></span>
    <span class="min-w-0 truncate font-medium">{label}</span>
    <ChevronDown class="size-3 shrink-0 opacity-70" />
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="surface-popover pilot-pop absolute z-30 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col {placement ===
      'up'
        ? 'bottom-full mb-1.5'
        : 'top-full mt-1.5'} {align === 'right' ? 'right-0' : 'left-0'}"
      role="menu"
      tabindex="-1"
      onkeydown={onMenuKey}
      data-testid="chat-model-menu"
    >
      <div class="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
        <Search class="size-3.5 shrink-0 text-muted-foreground" />
        <input
          bind:this={field}
          bind:value={query}
          type="text"
          class="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          placeholder={t("pilot.pickerSearch")}
          aria-label={t("pilot.pickerSearch")}
          data-testid="chat-model-search"
        />
      </div>

      <!-- Said once, about the row the reader is on, rather than fifteen times
           about fifteen rows that all answer the same. -->
      {#if hint}
        <p class="border-b border-border px-2.5 py-1.5 text-xs text-muted-foreground">
          {t(hint.key)}
        </p>
      {/if}

      <div class="max-h-72 scroll-pane overflow-y-auto py-1">
        {#if shown.length === 0 && legacyMatched.length === 0}
          <p class="px-2.5 py-3 text-center text-sm text-muted-foreground">
            {t("pilot.pickerNoMatch")}
          </p>
        {:else}
          {#each primaryShown as row, at (row.key)}
            {@render line(row, at === 0 || primaryShown[at - 1].group !== row.group)}
          {/each}

          {#if legacyRows.length > 0}
            <button
              type="button"
              class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition hover:bg-[var(--color-surface-3)] hover:text-foreground focus:outline-none focus-visible:focus-ring-inset"
              onclick={() => (foldOpen = !unfolded)}
              aria-expanded={unfolded}
              data-testid="chat-model-legacy"
            >
              <ChevronRight
                class="size-3 shrink-0 transition-transform {unfolded ? 'rotate-90' : ''}"
              />
              {t("pilot.legacyModels", { count: String(legacyRows.length) })}
            </button>
            {#each legacyShown as row, at (row.key)}
              {@render line(row, false)}
            {/each}
          {/if}

          {#each otherShown as row, at (row.key)}
            {@render line(row, at === 0 || otherShown[at - 1].group !== row.group)}
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  /* 120ms, and nothing at all where the user asked for nothing: the app's own
     motion gate is an attribute on <html>, so a media query alone would ignore
     the setting in Appearance. */
  .pilot-pop {
    animation: pilot-pop var(--dur-2) var(--ease-out-quint);
    transform-origin: top center;
  }
  @keyframes pilot-pop {
    from {
      opacity: 0;
      transform: translateY(-2px) scale(0.985);
    }
  }
  :global(html[data-motion="reduced"]) .pilot-pop {
    animation: none;
  }
</style>
