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
   * The rule the menu is built around: **it says what the click will do before
   * the click.** `selection.ts` answers that off the catalog and the row wears
   * the answer, so picking another account reads "restarts on the same session"
   * rather than going quiet for a second. Another driver is a graft and is
   * phase 4, so its rows are disabled and say "later" rather than being hidden:
   * a menu that hides what it cannot do yet teaches the user the driver does
   * not exist.
   *
   * The tint is the sidebar's own (`fastpick/accent.ts`): a fastpick route is
   * coloured by what is actually answering, which is the one thing a model name
   * on its own does not say.
   *
   * Keyboard: the arrows walk the enabled rows, Enter takes one, Escape closes
   * and hands focus back to the chip. The list is built flat for exactly that
   * reason, with the group headings drawn from each row's own `group`.
   */
  import { backend } from "$lib/backend";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { log } from "$lib/shared/log";
  import { t } from "$lib/i18n/index.svelte";
  import { ACCENT_COLOR, modelFamily } from "$lib/features/fastpick/accent";
  import { shortModel } from "./present";
  import ModeControl from "./ModeControl.svelte";
  import { instancesOf, switchOutcome, type SwitchOutcome } from "./selection";
  import type {
    PilotCatalog,
    PilotExecMode,
    PilotInstance,
    PilotInstanceEntry,
  } from "./types";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Search from "@lucide/svelte/icons/search";

  type Props = {
    threadId: string;
    catalog: PilotCatalog | null;
    driver: string;
    /** The instance name the row carries, or null before one is known. */
    instance: string | null;
    model: string | null;
    mode: PilotExecMode;
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
    mode,
    compact = false,
    placement = "down",
    align = "left",
    open = $bindable(false),
  }: Props = $props();

  let busy = $state(false);
  let query = $state("");
  let cursor = $state(0);
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
  /**
   * The effort levels the driver declared, which is none of them today.
   *
   * `PilotCapabilities` carries no such field yet, so the control draws the
   * level in force and says so rather than offering a choice nothing on the
   * other side would honour. The read is optional on purpose: the day a driver
   * declares them, this becomes a real segmented control with no edit here.
   */
  const efforts = $derived(
    (capabilities as { effort?: string[] } | null)?.effort ?? [],
  );

  /** The tint a row wears, off the model it names. */
  const tint = (name: string | null): string | null =>
    name ? ACCENT_COLOR[modelFamily(name)] : null;

  const label = $derived(shortModel(model) ?? t("pilot.picker"));

  /** One choosable line of the menu: an account, a model, and what it will do. */
  interface Row {
    key: string;
    entry: PilotInstanceEntry;
    model: string | null;
    label: string;
    group: string;
    outcome: SwitchOutcome;
  }

  /**
   * The menu, flat.
   *
   * Native accounts first and fastpick routes after, each labelled the way the
   * fastpick menu labels it, because a user reading two lists reads them in the
   * order the rest of the app already taught them. A native account offers the
   * driver's model list; a fastpick route is one model by construction and
   * offers itself.
   */
  const rows = $derived.by((): Row[] => {
    // Another driver is a graft and is phase 4. Its accounts are listed and
    // disabled rather than hidden: a menu that hides what it cannot do yet
    // teaches the user the driver does not exist.
    const others = (catalog?.instances ?? []).filter((entry) => entry.driver !== driver);
    const ordered = [
      ...accounts.filter((entry) => entry.kind === "native"),
      ...accounts.filter((entry) => entry.kind !== "native"),
      ...others,
    ];
    const out: Row[] = [];
    for (const entry of ordered) {
      const outcome = switchOutcome(
        { driver, instance: here },
        { driver: entry.driver, instance: entry.name },
        capabilities,
      );
      const names =
        entry.driver !== driver
          ? [entry.model ?? entry.name]
          : entry.kind === "native"
            ? models
            : [entry.model ?? entry.name];
      if (names.length === 0) {
        out.push({
          key: entry.name,
          entry,
          model: null,
          label: entry.label,
          group: entry.label,
          outcome,
        });
        continue;
      }
      for (const name of names) {
        out.push({
          key: `${entry.name}::${name}`,
          entry,
          model: name,
          label: shortModel(name) ?? name,
          group: entry.label,
          outcome,
        });
      }
    }
    return out;
  });

  const shown = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.label.toLowerCase().includes(needle) || row.group.toLowerCase().includes(needle),
    );
  });

  /** The rows a key can land on. A disabled row is read, never selected. */
  const reachable = $derived(shown.filter((row) => row.outcome.enabled));

  const isCurrent = (row: Row): boolean =>
    row.entry.name === here && (row.model === null || row.model === model);

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
        />
      </div>

      <div class="max-h-64 scroll-pane overflow-y-auto py-1">
        {#if shown.length === 0}
          <p class="px-2.5 py-3 text-center text-sm text-muted-foreground">
            {t("pilot.pickerNoMatch")}
          </p>
        {:else}
          {#each shown as row, at (row.key)}
            {#if at === 0 || shown[at - 1].group !== row.group}
              <p
                class="px-2.5 pt-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"
              >
                {row.group}
              </p>
            {/if}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={isCurrent(row)}
              class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 {reachable[
                cursor
              ] === row
                ? 'bg-[var(--color-surface-3)]'
                : ''} {isCurrent(row) ? 'text-foreground' : 'text-muted-foreground'} hover:bg-[var(--color-surface-3)] hover:text-foreground"
              disabled={!row.outcome.enabled || busy}
              onclick={() => void pick(row)}
              onpointerenter={() => {
                const at2 = reachable.indexOf(row);
                if (at2 >= 0) cursor = at2;
              }}
            >
              <span
                class="size-2 shrink-0 rounded-full"
                style:background={tint(row.model) ?? "var(--color-muted-foreground)"}
              ></span>
              <span class="min-w-0 flex-1 truncate">{row.label}</span>
              <span class="shrink-0 text-xs text-muted-foreground">{t(row.outcome.key)}</span>
            </button>
          {/each}
        {/if}
      </div>

      <!-- Effort has no list to offer until a driver declares one, so the menu
           says which one is in force rather than pretending to a choice. -->
      <div class="border-t border-border px-2.5 py-2">
        <p class="pb-1 text-xs font-medium text-muted-foreground">{t("pilot.pickerEffort")}</p>
        {#if efforts.length === 0}
          <p class="text-sm text-muted-foreground">{t("pilot.effortDefault")}</p>
        {:else}
          <div class="flex gap-1 rounded-md bg-[var(--color-surface)] p-0.5">
            {#each efforts as level (level)}
              <span
                class="flex-1 rounded px-2 py-1 text-center text-xs text-muted-foreground capitalize"
              >
                {level}
              </span>
            {/each}
          </div>
        {/if}
      </div>

      <div class="border-t border-border px-2.5 py-2">
        <p class="pb-1 text-xs font-medium text-muted-foreground">{t("pilot.pickerMode")}</p>
        <ModeControl {threadId} {mode} {capabilities} />
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
