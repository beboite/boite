<script lang="ts">
  import { untrack } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { backendFor } from "$lib/backend";
  import type { McpServerRow } from "$lib/backend/types";
  import { settings } from "$lib/features/settings/store.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import PlugZap from "@lucide/svelte/icons/plug-zap";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import DashboardCard from "./DashboardCard.svelte";
  import type { Project } from "$lib/types";

  type Props = { project: Project };
  let { project }: Props = $props();

  let servers = $state<McpServerRow[]>([]);
  let loading = $state(true);
  let failed = $state(false);
  let saving = $state(false);
  let loadVersion = 0;

  const managed = $derived(project.mcpServerIds !== null && project.mcpServerIds !== undefined);
  const selectedIds = $derived.by(() => {
    if (managed) return new Set(project.mcpServerIds ?? []);
    return new Set(
      servers
        .filter((server) =>
          server.id === "boite" ? settings.state.agentTodoAccess : server.enabled,
        )
        .map((server) => server.id),
    );
  });

  async function load() {
    const version = ++loadVersion;
    loading = true;
    failed = false;
    try {
      const found = await backendFor(project.origin).mcp.catalog();
      if (version === loadVersion) servers = found;
    } catch {
      if (version === loadVersion) failed = true;
    } finally {
      if (version === loadVersion) loading = false;
    }
  }

  $effect(() => {
    void project.id;
    void project.origin;
    untrack(() => void load());
  });

  function rowDescription(server: McpServerRow): string {
    if (server.id === "boite") return t("project.mcpBoiteDesc");
    if (!server.claudeCompatible) return t("project.mcpCodexOnly");
    return server.transport === "http"
      ? t("project.mcpHttpAgents")
      : t("project.mcpStdioAgents");
  }

  async function toggle(id: string) {
    if (saving) return;
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    saving = true;
    try {
      await app.setProjectMcpServers(
        project.id,
        servers.filter((server) => next.has(server.id)).map((server) => server.id),
      );
    } finally {
      saving = false;
    }
  }

  async function reset() {
    if (saving || !managed) return;
    saving = true;
    try {
      await app.setProjectMcpServers(project.id, null);
    } finally {
      saving = false;
    }
  }
</script>

<DashboardCard
  title={t("project.mcpTitle")}
  badge={managed ? t("project.mcpCustom") : t("project.mcpDefaults")}
  class="lg:col-span-3"
>
  {#snippet icon()}<PlugZap class="size-3.5" />{/snippet}
  {#snippet actions()}
    {#if managed}
      <button
        type="button"
        class="rounded-sm p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
        onclick={() => void reset()}
        disabled={saving}
        title={t("project.mcpReset")}
        aria-label={t("project.mcpReset")}
      >
        <RotateCcw class="size-3.5" />
      </button>
    {/if}
  {/snippet}

  <p class="mb-2.5 text-xs leading-relaxed text-muted-foreground">
    {t("project.mcpDesc")}
  </p>

  {#if loading}
    <p class="text-sm text-muted-foreground">{t("project.mcpLoading")}</p>
  {:else if failed}
    <button
      type="button"
      class="text-sm text-[var(--color-danger)] hover:underline"
      onclick={() => void load()}
    >
      {t("project.mcpLoadFailed")}
    </button>
  {:else if servers.length === 0}
    <p class="text-sm text-muted-foreground">{t("project.mcpEmpty")}</p>
  {:else}
    <div class="grid gap-1.5 md:grid-cols-2" class:opacity-60={saving}>
      {#each servers as server (server.id)}
        <ToggleSetting
          label={server.name}
          description={rowDescription(server)}
          enabled={selectedIds.has(server.id)}
          onToggle={() => void toggle(server.id)}
        />
      {/each}
    </div>
  {/if}

  <p class="mt-2 text-xs text-muted-foreground/70">{t("project.mcpNextLaunch")}</p>
</DashboardCard>
