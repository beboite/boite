<script lang="ts">
  import { onMount } from "svelte";
  import { logger, type LogEntry } from "$lib/shared/services/logger.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Copy from "@lucide/svelte/icons/copy";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import { t } from "$lib/i18n/index.svelte";

  type Scope = "current" | "previous";

  let scope = $state<Scope>("current");
  let entries = $state<LogEntry[]>([]);
  let loading = $state(false);
  let levelFilter = $state<string>("all");
  let sourceFilter = $state<string>("");
  let logPath = $state<string>("");

  const filtered = $derived.by(() => {
    return entries.filter((e) => {
      if (levelFilter !== "all" && e.level !== levelFilter) return false;
      if (sourceFilter && !e.source.toLowerCase().includes(sourceFilter.toLowerCase())) {
        return false;
      }
      return true;
    });
  });

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
      notifications.error(`Read log failed: ${String(err)}`);
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
    notifications.success(`Copied ${filtered.length} entries`);
  }

  async function clear() {
    try {
      await logger.clear();
      notifications.success("Log cleared");
      await refresh();
    } catch (err) {
      notifications.error(`Clear failed: ${String(err)}`);
    }
  }

  async function copyPath() {
    if (!logPath) return;
    void navigator.clipboard.writeText(logPath);
    notifications.success("Log path copied");
  }

  $effect(() => {
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
      <h3 class="text-sm font-semibold tracking-tight">Logs</h3>
      <div class="flex rounded-md border border-border bg-[var(--color-surface)] p-0.5 text-xs">
        <button
          type="button"
          class="rounded-sm px-2 py-0.5 transition {scope === 'current'
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:text-foreground'}"
          onclick={() => (scope = "current")}
        >
          Current
        </button>
        <button
          type="button"
          class="rounded-sm px-2 py-0.5 transition {scope === 'previous'
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:text-foreground'}"
          onclick={() => (scope = "previous")}
        >
          Previous
        </button>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <select
        bind:value={levelFilter}
        class="rounded-md border border-border bg-[var(--color-surface)] px-2 py-1 text-xs"
      >
        <option value="all">All levels</option>
        <option value="debug">Debug</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
      </select>
      <input
        bind:value={sourceFilter}
        placeholder={t("logs.sourceFilter")}
        class="w-32 rounded-md border border-border bg-[var(--color-surface)] px-2 py-1 text-xs outline-none focus:border-foreground/30"
      />
      <button
        type="button"
        class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={refresh}
        title={t("logs.refresh")}
      >
        <RotateCw class="size-3 {loading ? 'animate-spin' : ''}" />
        Refresh
      </button>
      <button
        type="button"
        class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={copyAll}
        title={t("logs.copyFiltered")}
      >
        <Copy class="size-3" />
        Copy
      </button>
      {#if scope === "current"}
        <button
          type="button"
          class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:bg-danger/15 hover:text-danger"
          onclick={clear}
          title={t("logs.truncate")}
        >
          <Trash2 class="size-3" />
          Clear
        </button>
      {/if}
    </div>
  </header>

  <div
    class="max-h-[60vh] min-h-[200px] overflow-y-auto rounded-md border border-border bg-[var(--color-titlebar)] p-2 font-mono text-xs"
  >
    {#if loading && entries.length === 0}
      <p class="py-4 text-center text-muted-foreground/60">Loading…</p>
    {:else if filtered.length === 0}
      <p class="py-4 text-center text-muted-foreground/60">
        {scope === "previous" ? "No previous session log" : "No log entries"}
      </p>
    {:else}
      {#each filtered as entry, i (i)}
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
    <span>{filtered.length} / {entries.length} entries</span>
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
