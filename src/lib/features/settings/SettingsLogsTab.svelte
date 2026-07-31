<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { logger, type LogEntry } from "$lib/shared/services/logger.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Copy from "@lucide/svelte/icons/copy";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import { debounce } from "$lib/shared/utils/debounce";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { backend } from "$lib/backend";

  type Scope = "current" | "previous";

  // A session log runs to tens of thousands of entries, and every one of them is
  // a row of five spans. Only the tail of the log answers a diagnostics question,
  // so the rest is never handed to the DOM: the count line below says how much of
  // the file is on screen.
  const RENDER_LIMIT = 1000;

  // Long enough that a burst of keystrokes refilters once, short enough that the
  // list still feels attached to the field.
  const FILTER_DEBOUNCE_MS = 120;

  // The `id` is the level as the log file writes it, never shown; the label is
  // the only translated half.
  const LEVELS: { id: string; labelKey: MessageKey }[] = [
    { id: "all", labelKey: "logs.levelAll" },
    { id: "debug", labelKey: "logs.levelDebug" },
    { id: "info", labelKey: "logs.levelInfo" },
    { id: "warn", labelKey: "logs.levelWarn" },
    { id: "error", labelKey: "logs.levelError" },
  ];

  let scope = $state<Scope>("current");
  // The log file belongs to the machine running Boite, so a remote workspace has
  // nothing to read: the remote backend stubs the whole capability. Saying so
  // beats an empty list, which reads as a bug in the logger.
  const deviceLocal = $derived(!backend().caps.appLogs);
  let entries = $state<LogEntry[]>([]);
  let loading = $state(false);
  let levelFilter = $state<string>("all");
  // The needle is stored already lowercased: folding it per entry meant one
  // allocation per line of the log per keystroke.
  let sourceNeedle = $state<string>("");
  let logPath = $state<string>("");

  const applySourceFilter = debounce((raw: string) => {
    sourceNeedle = raw.trim().toLowerCase();
  }, FILTER_DEBOUNCE_MS);

  onDestroy(() => applySourceFilter.cancel());

  const filtered = $derived.by(() => {
    const needle = sourceNeedle;
    const level = levelFilter;
    return entries.filter((e) => {
      if (level !== "all" && e.level !== level) return false;
      if (needle && !e.source.toLowerCase().includes(needle)) return false;
      return true;
    });
  });

  const visible = $derived(
    filtered.length > RENDER_LIMIT ? filtered.slice(filtered.length - RENDER_LIMIT) : filtered,
  );

  const levelClass: Record<string, string> = {
    debug: "text-muted-foreground/70",
    info: "text-foreground/80",
    warn: "text-warning",
    error: "text-danger",
  };

  function formatTime(ms: number): string {
    if (!ms) return "--:--:--";
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const millis = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${millis}`;
  }

  async function refresh() {
    loading = true;
    try {
      entries = await logger.read(scope);
    } catch (err) {
      notifications.error(t("logs.readFailed", { error: String(err) }));
      entries = [];
    } finally {
      loading = false;
    }
  }

  function copyAll() {
    const text = filtered
      .map((e) => {
        const head = `${formatTime(e.tsMs)} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`;
        return e.details ? `${head} ${e.details}` : head;
      })
      .join("\n");
    void navigator.clipboard.writeText(text);
    notifications.success(t("logs.copiedEntries", { count: filtered.length }));
  }

  async function clear() {
    const ok = await confirmDialog.ask({
      title: t("logs.clearConfirmTitle"),
      message: t("logs.clearConfirmMessage"),
      confirmLabel: t("logs.clearConfirmAction"),
      danger: true,
    });
    if (!ok) return;
    try {
      await logger.clear();
      notifications.success(t("logs.cleared"));
      await refresh();
    } catch (err) {
      notifications.error(t("logs.clearFailed", { error: String(err) }));
    }
  }

  async function copyPath() {
    if (!logPath) return;
    void navigator.clipboard.writeText(logPath);
    notifications.success(t("logs.pathCopied"));
  }

  $effect(() => {
    if (deviceLocal) {
      entries = [];
      return;
    }
    void refresh();
    void scope;
  });

  onMount(() => {
    void logger
      .filePath()
      .then((p) => (logPath = p))
      .catch(() => {});
  });
</script>

<section class="flex flex-col gap-2">
  <header class="flex items-center justify-between">
    <div class="flex items-center gap-2">
      <h3 class="text-sm font-semibold tracking-tight">{t("tabs.logs")}</h3>
      {#if !deviceLocal}
      <div class="flex rounded-md border border-border bg-[var(--color-surface)] p-0.5 text-xs">
        <button
          type="button"
          aria-pressed={scope === "current"}
          class="rounded-sm px-2 py-0.5 transition {scope === 'current'
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:text-foreground'}"
          onclick={() => (scope = "current")}
        >
          {t("logs.scopeCurrent")}
        </button>
        <button
          type="button"
          aria-pressed={scope === "previous"}
          class="rounded-sm px-2 py-0.5 transition {scope === 'previous'
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:text-foreground'}"
          onclick={() => (scope = "previous")}
        >
          {t("logs.scopePrevious")}
        </button>
      </div>
      {/if}
    </div>
    {#if !deviceLocal}
    <div class="flex items-center gap-2">
      <select
        bind:value={levelFilter}
        aria-label={t("logs.levelAll")}
        class="rounded-md border border-border bg-[var(--color-surface)] px-2 py-1 text-xs"
      >
        {#each LEVELS as level (level.id)}
          <option value={level.id}>{t(level.labelKey)}</option>
        {/each}
      </select>
      <input
        oninput={(e) => applySourceFilter(e.currentTarget.value)}
        placeholder={t("logs.sourceFilter")}
        aria-label={t("logs.sourceFilter")}
        class="w-32 rounded-md border border-border bg-[var(--color-surface)] px-2 py-1 text-xs outline-none focus:border-foreground/30"
      />
      <button
        type="button"
        class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={refresh}
        title={t("logs.refresh")}
      >
        <RotateCw class="size-3 {loading ? 'animate-spin' : ''}" />
        {t("logs.refresh")}
      </button>
      <button
        type="button"
        class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={copyAll}
        title={t("logs.copyFiltered")}
      >
        <Copy class="size-3" />
        {t("logs.copy")}
      </button>
      {#if scope === "current"}
        <button
          type="button"
          class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:bg-danger/15 hover:text-danger"
          onclick={clear}
          title={t("logs.clearTitle")}
        >
          <Trash2 class="size-3" />
          {t("logs.clear")}
        </button>
      {/if}
    </div>
    {/if}
  </header>

  <div
    class="max-h-[60vh] min-h-[200px] overflow-y-auto rounded-md border border-border bg-[var(--color-titlebar)] p-2 font-mono text-xs"
  >
    {#if deviceLocal}
      <p class="py-4 text-center text-muted-foreground/60">{t("logs.deviceLocalOnly")}</p>
    {:else if loading && entries.length === 0}
      <p class="py-4 text-center text-muted-foreground/60">{t("common.loading")}</p>
    {:else if filtered.length === 0}
      <p class="py-4 text-center text-muted-foreground/60">
        {scope === "previous" ? t("logs.noPreviousSession") : t("logs.empty")}
      </p>
    {:else}
      {#each visible as entry, i (`${entry.tsMs}-${i}`)}
        <div class="flex gap-2 py-0.5 {levelClass[entry.level] ?? 'text-foreground/80'}">
          <span class="shrink-0 text-muted-foreground/60">{formatTime(entry.tsMs)}</span>
          <span class="w-12 shrink-0 uppercase">{entry.level}</span>
          <span class="w-32 shrink-0 truncate text-muted-foreground" title={entry.source}>
            [{entry.source}]
          </span>
          <span class="min-w-0 flex-1 break-words">
            {entry.message}
            {#if entry.details}
              <span class="text-muted-foreground/60"> {entry.details}</span>
            {/if}
          </span>
        </div>
      {/each}
    {/if}
  </div>

  <div class="flex items-center justify-between text-xs text-muted-foreground/60">
    <span>{t("logs.entryCount", { shown: visible.length, total: entries.length })}</span>
    {#if logPath}
      <button
        type="button"
        class="flex items-center gap-1 transition hover:text-foreground"
        onclick={copyPath}
        title={t("logs.copyPath")}
      >
        <FolderOpen class="size-3" />
        <span class="truncate font-mono">{logPath}</span>
      </button>
    {/if}
  </div>
</section>
