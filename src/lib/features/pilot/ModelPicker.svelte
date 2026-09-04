<script lang="ts">
  /**
   * Driver, account, model, effort and mode, in one menu.
   *
   * The rule the menu is built around: **it says what the click will do before
   * the click.** `selection.ts` answers that off the catalog, and the row wears
   * the answer, so picking another account reads "restarts on the same session"
   * rather than going quiet for a second. Another driver is a graft and is
   * phase 4, so its rows are disabled and say "later" rather than being hidden.
   *
   * The tint is the sidebar's own (`fastpick/accent.ts`): a fastpick route is
   * coloured by what is actually answering, which is the one thing a model name
   * on its own does not say.
   */
  import { backend } from "$lib/backend";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { log } from "$lib/shared/log";
  import { t } from "$lib/i18n/index.svelte";
  import { ACCENT_COLOR, modelFamily } from "$lib/features/fastpick/accent";
  import { instancesOf, switchOutcome } from "./selection";
  import type {
    PilotCatalog,
    PilotExecMode,
    PilotInstance,
    PilotInstanceEntry,
  } from "./types";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  type Props = {
    threadId: string;
    catalog: PilotCatalog | null;
    driver: string;
    /** The instance name the row carries, or null before one is known. */
    instance: string | null;
    model: string | null;
    mode: PilotExecMode;
  };
  let { threadId, catalog, driver, instance, model, mode }: Props = $props();

  let open = $state(false);
  let busy = $state(false);

  const MODES: { value: PilotExecMode; key: "pilot.modeAsk" | "pilot.modeEditAlone" | "pilot.modeYolo" }[] = [
    { value: "ask", key: "pilot.modeAsk" },
    { value: "edit_alone", key: "pilot.modeEditAlone" },
    { value: "yolo", key: "pilot.modeYolo" },
  ];

  const drivers = $derived(catalog?.drivers ?? []);
  const capabilities = $derived(
    drivers.find((entry) => entry.id === driver)?.capabilities ?? null,
  );
  const accounts = $derived(instancesOf(catalog?.instances ?? [], driver));
  const models = $derived(drivers.find((entry) => entry.id === driver)?.models ?? []);

  /** The tint a row wears, off the model it names. */
  const tint = (name: string | null): string | null =>
    name ? ACCENT_COLOR[modelFamily(name)] : null;

  const label = $derived(model ?? t("pilot.picker"));

  function instanceValue(entry: PilotInstanceEntry): PilotInstance {
    return entry.kind === "fastpick"
      ? { type: "fastpick", provider: entry.provider ?? "", model: entry.model ?? "" }
      : { type: "native", config_dir: entry.configDir ?? null };
  }

  async function pick(entry: PilotInstanceEntry, nextModel: string | null) {
    const outcome = switchOutcome(
      { driver, instance },
      { driver: entry.driver, instance: entry.name },
      capabilities,
    );
    if (!outcome.enabled || busy) return;
    busy = true;
    try {
      await backend().pilot.setModel(threadId, {
        model: nextModel,
        instance: instanceValue(entry),
      });
      open = false;
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

  async function setMode(next: PilotExecMode) {
    if (busy || next === mode) return;
    busy = true;
    try {
      await backend().pilot.setMode(threadId, next);
      open = false;
    } catch (err) {
      log.warn("pilot.picker", "pilot.setMode.failed", {
        thread: threadId,
        reason: String(err),
      });
      notifications.error(t("pilot.switchFailed"));
    } finally {
      busy = false;
    }
  }

  /** The sentence a row wears, so the user reads it before pressing it. */
  function says(entry: PilotInstanceEntry) {
    return switchOutcome(
      { driver, instance },
      { driver: entry.driver, instance: entry.name },
      capabilities,
    );
  }
</script>

<div class="relative">
  <button
    type="button"
    class="flex max-w-[14rem] items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
    onclick={() => (open = !open)}
    aria-expanded={open}
    aria-label={t("pilot.picker")}
  >
    <span
      class="size-1.5 shrink-0 rounded-full"
      style:background={tint(model) ?? "var(--color-muted-2)"}
    ></span>
    <span class="min-w-0 truncate">{label}</span>
    <ChevronDown class="size-3 shrink-0 opacity-60" />
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="surface-popover absolute right-0 top-full z-30 mt-1 flex max-h-80 w-72 flex-col gap-1 scroll-pane overflow-y-auto p-1.5"
    >
      <p class="px-1.5 pt-0.5 text-xs font-medium text-muted-2">{t("pilot.pickerDriver")}</p>
      {#each drivers as entry (entry.id)}
        <div
          class="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-sm {entry.id ===
          driver
            ? 'text-foreground'
            : 'text-muted-2'}"
        >
          <span class="min-w-0 truncate">{entry.id}</span>
          {#if entry.id !== driver}
            <span class="shrink-0 text-xs text-muted-2">{t("pilot.switchLater")}</span>
          {/if}
        </div>
      {/each}

      <p class="px-1.5 pt-1 text-xs font-medium text-muted-2">{t("pilot.pickerInstance")}</p>
      {#each accounts as entry (entry.name)}
        {@const outcome = says(entry)}
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-sm transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 {entry.name ===
          instance
            ? 'text-foreground'
            : 'text-muted-foreground'}"
          disabled={!outcome.enabled || busy}
          onclick={() => void pick(entry, model)}
        >
          <span class="min-w-0 truncate">{entry.label}</span>
          <span class="shrink-0 text-xs text-muted-2">{t(outcome.key)}</span>
        </button>
      {/each}

      {#if models.length > 0}
        <p class="px-1.5 pt-1 text-xs font-medium text-muted-2">{t("pilot.pickerModel")}</p>
        {#each models as name (name)}
          {@const own = accounts.find((entry) => entry.name === instance) ?? accounts[0]}
          <button
            type="button"
            class="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm transition hover:bg-accent disabled:opacity-40 {name ===
            model
              ? 'text-foreground'
              : 'text-muted-foreground'}"
            disabled={!own || busy}
            onclick={() => own && void pick(own, name)}
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              style:background={tint(name) ?? "var(--color-muted-2)"}
            ></span>
            <span class="min-w-0 flex-1 truncate">{name}</span>
            {#if own}
              <span class="shrink-0 text-xs text-muted-2">{t(says(own).key)}</span>
            {/if}
          </button>
        {/each}
      {/if}

      <!-- Effort has no list to offer until a driver declares one, so the menu
           says which one is in force rather than pretending to a choice. -->
      <p class="px-1.5 pt-1 text-xs font-medium text-muted-2">{t("pilot.pickerEffort")}</p>
      <p class="px-1.5 pb-0.5 text-sm text-muted-2">{t("pilot.effortDefault")}</p>

      <p class="px-1.5 pt-1 text-xs font-medium text-muted-2">{t("pilot.pickerMode")}</p>
      {#each MODES as row (row.value)}
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-sm transition hover:bg-accent disabled:opacity-40 {row.value ===
          mode
            ? 'text-foreground'
            : 'text-muted-foreground'}"
          disabled={busy || (capabilities ? !capabilities.modes.includes(row.value) : false)}
          onclick={() => void setMode(row.value)}
        >
          <span class="min-w-0 truncate">{t(row.key)}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
