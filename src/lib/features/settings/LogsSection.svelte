<script lang="ts">
  /**
   * The log, as the user reads it.
   *
   * Three bus calls and nothing else: `tail` on open (the ring this host keeps
   * in memory, instant, no file read), `query` for anything older, and
   * `subscribe` while Follow is on. The filters are sent rather than applied
   * here, so a needle finds a record that is in the file and not in the ring:
   * the old panel filtered an array it had already downloaded, which meant
   * "search the log" only ever searched the last thousand lines of it.
   */
  import { onDestroy, onMount } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Copy from "@lucide/svelte/icons/copy";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import { debounce } from "$lib/shared/utils/debounce";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { backend, localBackend } from "$lib/backend";
  import { hasTauri } from "$lib/backend/env";
  import type { LogRecord } from "$lib/backend/types";
  import { app } from "$lib/app/store.svelte";

  /** How much of the log the section opens on. */
  const TAIL_LIMIT = 200;

  /** One press of "older" is worth this many records. */
  const PAGE_LIMIT = 200;

  /**
   * The ceiling on what the DOM holds.
   *
   * A followed log runs to tens of thousands of records in a session and every
   * one is a row of five spans. Only the tail answers a diagnostics question,
   * so the head is dropped as live records arrive.
   */
  const RENDER_LIMIT = 2000;

  /** Long enough that a burst of keystrokes queries once. */
  const FILTER_DEBOUNCE_MS = 250;

  // The `id` is what goes on the wire; the label is the only translated half.
  const LEVELS: { id: string; labelKey: MessageKey }[] = [
    { id: "", labelKey: "logs.levelAll" },
    { id: "debug", labelKey: "logs.levelDebug" },
    { id: "info", labelKey: "logs.levelInfo" },
    { id: "warn", labelKey: "logs.levelWarn" },
    { id: "error", labelKey: "logs.levelError" },
  ];

  const HOSTS: { id: string; labelKey: MessageKey }[] = [
    { id: "", labelKey: "logs.hostAll" },
    { id: "desktop", labelKey: "logs.hostDesktop" },
    { id: "server", labelKey: "logs.hostServer" },
    { id: "mcp", labelKey: "logs.hostMcp" },
    { id: "webview", labelKey: "logs.hostWebview" },
  ];

  let records = $state<LogRecord[]>([]);
  let loading = $state(false);
  let older = $state(false);
  let follow = $state(false);
  let levelFilter = $state("");
  let hostFilter = $state("");
  let threadFilter = $state("");
  let textFilter = $state("");
  let logPath = $state("");
  let exhausted = $state(false);

  // The clear button truncates this device's own file through the desktop host.
  // A browser talking to a server has no such file, and saying so beats a
  // button that answers nothing.
  const canClear = hasTauri() && localBackend().caps.appLogs;

  const applyThread = debounce((raw: string) => {
    threadFilter = raw.trim();
  }, FILTER_DEBOUNCE_MS);
  const applyText = debounce((raw: string) => {
    textFilter = raw.trim();
  }, FILTER_DEBOUNCE_MS);

  onDestroy(() => {
    applyThread.cancel();
    applyText.cancel();
    stopFollowing();
  });

  const filters = $derived({
    level: levelFilter || undefined,
    host: hostFilter || undefined,
    thread: threadFilter || undefined,
    text: textFilter || undefined,
  });

  const visible = $derived(
    records.length > RENDER_LIMIT ? records.slice(records.length - RENDER_LIMIT) : records,
  );

  const levelClass: Record<string, string> = {
    debug: "text-muted-2",
    info: "text-foreground",
    warn: "text-warning",
    error: "text-danger",
  };

  const chipClass: Record<string, string> = {
    debug: "border-edge text-muted-2",
    info: "border-edge text-muted-foreground",
    warn: "border-warning/40 bg-warning/10 text-warning",
    error: "border-danger/40 bg-danger/10 text-danger",
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

  /** A thread id is a uuid; eight characters is enough to recognise one. */
  function shortThread(id: string): string {
    return id.length > 8 ? id.slice(0, 8) : id;
  }

  function threadLabel(id: string): string | null {
    return app.threads.find((thread) => thread.id === id)?.label ?? null;
  }

  /** Whether a record still belongs on screen under the filters in force. */
  function passes(record: LogRecord): boolean {
    const f = filters;
    if (f.host && record.host !== f.host) return false;
    if (f.thread && record.thread !== f.thread) return false;
    if (f.level && severity(record.level) < severity(f.level)) return false;
    if (f.text) {
      const needle = f.text.toLowerCase();
      const hay = `${record.msg} ${record.target} ${JSON.stringify(record.fields ?? {})}`;
      if (!hay.toLowerCase().includes(needle)) return false;
    }
    return true;
  }

  const ORDER = ["trace", "debug", "info", "warn", "error"];
  function severity(level: string): number {
    const at = ORDER.indexOf(level.toLowerCase());
    return at === -1 ? ORDER.length : at;
  }

  function fieldsOf(record: LogRecord): string {
    const entries = Object.entries(record.fields ?? {});
    if (entries.length === 0) return "";
    return entries.map(([key, value]) => `${key}=${stringify(value)}`).join(" ");
  }

  function stringify(value: unknown): string {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }

  async function reload() {
    loading = true;
    exhausted = false;
    try {
      // The ring first: it is this host's own memory, so it answers instantly
      // and covers the case the section is opened for, which is "what just
      // happened". Anything before it comes from `query` on demand.
      records = await backend().logs.tail({ limit: TAIL_LIMIT, ...filters });
    } catch (err) {
      notifications.error(t("logs.readFailed", { error: String(err) }));
      records = [];
    } finally {
      loading = false;
    }
  }

  async function loadOlder() {
    older = true;
    try {
      const until = records.length > 0 ? records[0].ts : Date.now();
      const page = await backend().logs.query({ ...filters, until, limit: PAGE_LIMIT });
      // `until` is inclusive, so the boundary record comes back a second time.
      const seen = new Set(records.map(keyOf));
      const fresh = page.filter((r) => !seen.has(keyOf(r)));
      if (fresh.length === 0) exhausted = true;
      records = [...fresh, ...records];
    } catch (err) {
      notifications.error(t("logs.readFailed", { error: String(err) }));
    } finally {
      older = false;
    }
  }

  function keyOf(record: LogRecord): string {
    return `${record.ts}:${record.seq ?? 0}:${record.host ?? ""}`;
  }

  let unfollow: (() => void) | null = null;

  function startFollowing() {
    if (unfollow) return;
    unfollow = backend().logs.subscribe((batch) => {
      const fresh = batch.filter(passes);
      if (fresh.length === 0) return;
      const next = [...records, ...fresh];
      records = next.length > RENDER_LIMIT * 2 ? next.slice(next.length - RENDER_LIMIT) : next;
    });
  }

  function stopFollowing() {
    unfollow?.();
    unfollow = null;
  }

  function copyAll() {
    const text = visible
      .map((r) => {
        const head = `${formatTime(r.ts)} ${r.level.toUpperCase().padEnd(5)} [${r.target}] ${r.msg}`;
        const extra = fieldsOf(r);
        return extra ? `${head} ${extra}` : head;
      })
      .join("\n");
    void navigator.clipboard.writeText(text);
    notifications.success(t("logs.copiedEntries", { count: visible.length }));
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
      await localBackend().log.clear();
      notifications.success(t("logs.cleared"));
      await reload();
    } catch (err) {
      notifications.error(t("logs.clearFailed", { error: String(err) }));
    }
  }

  function copyPath() {
    if (!logPath) return;
    void navigator.clipboard.writeText(logPath);
    notifications.success(t("logs.pathCopied"));
  }

  // Refetches whenever a filter moves, because the filters are sent rather than
  // applied to what is already here.
  $effect(() => {
    void filters;
    void reload();
  });

  $effect(() => {
    if (follow) startFollowing();
    else stopFollowing();
  });

  onMount(() => {
    if (!canClear) return;
    void localBackend()
      .log.filePath()
      .then((p) => (logPath = p))
      .catch(() => {});
  });
</script>

<section class="flex flex-col gap-2">
  <header class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="text-sm font-semibold tracking-tight">{t("logs.title")}</h3>
    <div class="flex flex-wrap items-center gap-2">
      <select
        bind:value={levelFilter}
        aria-label={t("logs.levelAll")}
        class="rounded-md border border-edge bg-[var(--color-surface)] px-2 py-1 text-sm"
      >
        {#each LEVELS as level (level.id)}
          <option value={level.id}>{t(level.labelKey)}</option>
        {/each}
      </select>
      <select
        bind:value={hostFilter}
        aria-label={t("logs.hostFilter")}
        class="rounded-md border border-edge bg-[var(--color-surface)] px-2 py-1 text-sm"
      >
        {#each HOSTS as host (host.id)}
          <option value={host.id}>{t(host.labelKey)}</option>
        {/each}
      </select>
      <input
        value={threadFilter}
        oninput={(e) => applyThread(e.currentTarget.value)}
        placeholder={t("logs.threadFilter")}
        aria-label={t("logs.threadFilter")}
        class="w-28 min-w-0 rounded-md border border-border bg-[var(--color-surface)] px-2 py-1 text-sm outline-none focus:border-foreground/30"
      />
      <input
        oninput={(e) => applyText(e.currentTarget.value)}
        placeholder={t("logs.textFilter")}
        aria-label={t("logs.textFilter")}
        class="w-32 min-w-0 rounded-md border border-border bg-[var(--color-surface)] px-2 py-1 text-sm outline-none focus:border-foreground/30"
      />
      <label class="flex items-center gap-1 text-sm text-muted-foreground">
        <input type="checkbox" bind:checked={follow} class="accent-[var(--color-accent)]" />
        {t("logs.follow")}
      </label>
      <button
        type="button"
        class="flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={reload}
        use:tip={t("logs.refresh")}
      >
        <RotateCw class="size-3 {loading ? 'animate-spin' : ''}" />
        {t("logs.refresh")}
      </button>
      <button
        type="button"
        class="flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={copyAll}
        use:tip={t("logs.copyFiltered")}
      >
        <Copy class="size-3" />
        {t("logs.copy")}
      </button>
      {#if canClear}
        <button
          type="button"
          class="flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-sm text-muted-foreground transition hover:bg-danger/15 hover:text-danger"
          onclick={clear}
          use:tip={t("logs.clearTitle")}
        >
          <Trash2 class="size-3" />
          {t("logs.clear")}
        </button>
      {/if}
    </div>
  </header>

  <div
    class="max-h-[60vh] min-h-[200px] scroll-pane overflow-y-auto rounded-md border border-border bg-[var(--color-titlebar)] p-2 font-mono text-sm"
  >
    <div class="mb-1 flex justify-center">
      <button
        type="button"
        disabled={older || exhausted}
        class="flex items-center gap-1 rounded-md border border-edge px-2 py-0.5 text-xs text-muted-2 transition hover:text-foreground disabled:opacity-40"
        onclick={loadOlder}
      >
        <ChevronDown class="size-3 rotate-180" />
        {exhausted ? t("logs.noOlder") : t("logs.loadOlder")}
      </button>
    </div>
    {#if loading && records.length === 0}
      <p class="py-4 text-center text-muted-2">{t("common.loading")}</p>
    {:else if records.length === 0}
      <p class="py-4 text-center text-muted-2">{t("logs.empty")}</p>
    {:else}
      {#each visible as record, i (`${record.ts}-${record.seq ?? i}-${i}`)}
        <div class="flex gap-2 py-0.5 {levelClass[record.level] ?? 'text-foreground'}">
          <span class="shrink-0 text-muted-2">{formatTime(record.ts)}</span>
          <span
            class="shrink-0 rounded border px-1 text-[10px] uppercase leading-4 {chipClass[
              record.level
            ] ?? 'border-edge text-muted-2'}"
          >
            {record.level}
          </span>
          {#if record.thread}
            <button
              type="button"
              class="shrink-0 text-muted-foreground underline decoration-dotted underline-offset-2 transition hover:text-foreground"
              onclick={() => (threadFilter = record.thread ?? "")}
              use:tip={threadLabel(record.thread) ?? record.thread}
            >
              {shortThread(record.thread)}
            </button>
          {/if}
          <span class="w-40 shrink-0 truncate text-muted-foreground" use:tip={record.target}>
            {record.target}
          </span>
          <span class="min-w-0 flex-1 break-words">
            {record.msg}
            {#if record.fields}
              <span class="text-muted-2"> {fieldsOf(record)}</span>
            {/if}
          </span>
        </div>
      {/each}
    {/if}
  </div>

  <div class="flex items-center justify-between text-xs text-muted-2">
    <span>{t("logs.entryCount", { shown: visible.length, total: records.length })}</span>
    {#if logPath}
      <button
        type="button"
        class="flex items-center gap-1 transition hover:text-foreground"
        onclick={copyPath}
        use:tip={t("logs.copyPath")}
      >
        <span class="truncate">{logPath}</span>
      </button>
    {/if}
  </div>
</section>
