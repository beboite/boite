<script lang="ts">
  import { logger, type LogLevel } from "$lib/shared/services/logger.svelte";

  let levelFilter = $state<LogLevel | "all">("all");
  let scopeFilter = $state<string>("");

  const filtered = $derived.by(() => {
    return logger.entries.filter((e) => {
      if (levelFilter !== "all" && e.level !== levelFilter) return false;
      if (scopeFilter && !e.scope.toLowerCase().includes(scopeFilter.toLowerCase())) {
        return false;
      }
      return true;
    });
  });

  const levelClass: Record<LogLevel, string> = {
    debug: "text-muted-foreground/70",
    info: "text-foreground/80",
    warn: "text-warning",
    error: "text-danger",
  };

  function formatTime(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  function copyAll() {
    const text = filtered
      .map(
        (e) =>
          `${formatTime(e.timestamp)} ${e.level.toUpperCase()} [${e.scope}] ${e.message}${
            e.data !== undefined ? " " + JSON.stringify(e.data) : ""
          }`,
      )
      .join("\n");
    void navigator.clipboard.writeText(text);
  }
</script>

<section class="flex flex-col gap-2">
  <header class="flex items-center justify-between">
    <h3 class="text-[12px] font-semibold tracking-tight">Logs</h3>
    <div class="flex items-center gap-2">
      <select
        bind:value={levelFilter}
        class="rounded-md border border-border bg-[var(--color-surface)] px-2 py-1 text-[11px]"
      >
        <option value="all">All levels</option>
        <option value="debug">Debug</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
      </select>
      <input
        bind:value={scopeFilter}
        placeholder="Scope filter"
        class="w-32 rounded-md border border-border bg-[var(--color-surface)] px-2 py-1 text-[11px] outline-none focus:border-foreground/30"
      />
      <button
        type="button"
        class="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onclick={copyAll}
      >
        Copy
      </button>
      <button
        type="button"
        class="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-danger/15 hover:text-danger"
        onclick={() => logger.clear()}
      >
        Clear
      </button>
    </div>
  </header>

  <div
    class="max-h-[60vh] min-h-[200px] overflow-y-auto rounded-md border border-border bg-[var(--color-titlebar)] p-2 font-mono text-[11px]"
  >
    {#if filtered.length === 0}
      <p class="py-4 text-center text-muted-foreground/60">No log entries</p>
    {:else}
      {#each filtered as entry (entry.id)}
        <div class="flex gap-2 py-0.5 {levelClass[entry.level]}">
          <span class="shrink-0 text-muted-foreground/60">{formatTime(entry.timestamp)}</span>
          <span class="w-12 shrink-0 uppercase">{entry.level}</span>
          <span class="w-20 shrink-0 truncate text-muted-foreground">[{entry.scope}]</span>
          <span class="min-w-0 flex-1 break-words">
            {entry.message}
            {#if entry.data !== undefined}
              <span class="text-muted-foreground/60">
                {JSON.stringify(entry.data)}
              </span>
            {/if}
          </span>
        </div>
      {/each}
    {/if}
  </div>

  <p class="text-[10.5px] text-muted-foreground/60">
    {filtered.length} entries (max 1000 retained in memory)
  </p>
</section>
