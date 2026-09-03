<script lang="ts">
  import { onMount } from "svelte";

  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Pencil from "@lucide/svelte/icons/pencil";

  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import Button from "$lib/shared/components/Button.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { syncStore } from "$lib/features/sync/store.svelte";
  import { CLI_PRESETS } from "./cliPresets";
  import type { SyncPhase, SyncProbe } from "$lib/backend";

  const AGENTS_ID = "agents";

  let draft = $state("");
  let editing = $state(false);
  let probing = $state(false);
  let verdict = $state<SyncProbe | null>(null);

  onMount(() => {
    void syncStore.ensure();
  });

  const remote = $derived(syncStore.remoteUrl);
  const job = $derived(syncStore.status?.job ?? null);
  const supported = $derived(syncStore.status?.supported ?? true);

  /**
   * The rows, in the order the launcher already draws the agents, with the
   * shared tree first. The presets are the frontend's half of the same list the
   * backend keeps, and a test asserts the two agree.
   */
  const all = $derived(
    [
      { id: AGENTS_ID, label: t("sync.agentsRow"), iconKey: null },
      ...CLI_PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        iconKey: preset.iconKey,
      })),
    ].map((row) => ({
      ...row,
      source: syncStore.sources.find((source) => source.id === row.id) ?? null,
      enabled: settings.state.syncSources[row.id] ?? false,
    })),
  );

  /**
   * Seven of the ten agents have nothing verified to sync, and a row each drew
   * the same sentence seven times. They stay visible as one line of names: a
   * decision that was made still reads differently from one that was forgotten,
   * and it costs a line rather than a list.
   */
  const rows = $derived(all.filter((row) => row.source?.supported !== false));
  const notYet = $derived(
    all.filter((row) => row.source?.supported === false).map((row) => row.label),
  );

  function phaseText(phase: SyncPhase): string {
    switch (phase) {
      case "opening":
        return t("sync.phaseOpening");
      case "fetching":
        return t("sync.phaseFetching");
      case "reading":
        return t("sync.phaseReading");
      case "comparing":
        return t("sync.phaseComparing");
      case "writing":
        return t("sync.phaseWriting");
      case "committing":
        return t("sync.phaseCommitting");
      case "pushing":
        return t("sync.phasePushing");
      case "done":
        return t("sync.phaseDone");
      case "needsMerge":
        return t("sync.phaseNeedsMerge");
      case "failed":
        return t("sync.phaseFailed", { error: job?.message ?? "" });
      case "cancelled":
        return t("sync.phaseCancelled");
      default:
        return t("sync.phaseIdle");
    }
  }

  function verdictText(answer: SyncProbe): string {
    if (answer.needsAuth) return t("sync.remoteNeedsAuth");
    if (!answer.reachable) return t("sync.remoteMissing", { error: answer.message ?? "" });
    return answer.empty ? t("sync.remoteEmpty") : t("sync.remoteReachable");
  }

  async function check() {
    const url = draft.trim();
    if (!url) return;
    probing = true;
    verdict = null;
    try {
      verdict = await syncStore.probe(url);
    } finally {
      probing = false;
    }
  }

  async function save() {
    const url = draft.trim();
    if (!url) return;
    await settings.setSyncRemoteUrl(url);
    editing = false;
    verdict = null;
    await syncStore.refresh();
  }

  async function forget() {
    await settings.setSyncRemoteUrl(null);
    verdict = null;
    editing = false;
    await syncStore.refresh();
  }

  function startEditing() {
    draft = remote ?? "";
    editing = true;
  }
</script>

<ToggleSetting
  label={t("sync.enable")}
  anchor="sync.enable"
  description={remote ? t("sync.enableDesc") : t("sync.enableNoRemote")}
  enabled={settings.state.syncOnLaunch && remote !== null}
  onToggle={() => settings.setSyncOnLaunch(!settings.state.syncOnLaunch)}
/>

<SettingsCard
  title={t("sync.remoteTitle")}
  anchor="sync.remoteTitle"
  description={t("sync.remoteDesc")}
>
  {#if remote && !editing}
    <div class="flex items-center gap-2">
      <span
        class="min-w-0 flex-1 truncate rounded-md bg-[var(--color-surface-2)] px-2 py-1 font-mono text-xs text-foreground"
        title={remote}>{remote}</span
      >
      <Button
        variant="ghost"
        icon
        title={t("sync.remoteEdit")}
        ariaLabel={t("sync.remoteEdit")}
        onclick={startEditing}
      >
        <Pencil size={14} />
      </Button>
      <Button variant="danger" onclick={forget}>{t("sync.remoteForget")}</Button>
    </div>
    <p class="mt-1.5 text-xs text-muted-2">{t("sync.remoteForgetAsk")}</p>
  {:else}
    <label class="block text-xs font-medium text-foreground" for="sync-remote">
      {t("sync.remoteLabel")}
    </label>
    <div class="mt-1.5 flex items-center gap-2">
      <input
        id="sync-remote"
        type="url"
        spellcheck="false"
        autocomplete="off"
        bind:value={draft}
        placeholder={t("sync.remotePlaceholder")}
        class="min-w-0 flex-1 rounded-md border border-edge bg-[var(--color-surface-2)] px-2 py-1 font-mono text-xs text-foreground"
      />
      <Button disabled={probing || draft.trim() === ""} onclick={check}>
        {probing ? t("sync.remoteChecking") : t("sync.remoteCheck")}
      </Button>
      <Button variant="primary" disabled={draft.trim() === ""} onclick={save}>
        {t("sync.remoteSave")}
      </Button>
    </div>
    {#if verdict}
      <p
        class="mt-1.5 text-xs"
        class:text-muted-foreground={verdict.reachable}
        class:text-[var(--color-danger)]={!verdict.reachable}
      >
        {verdictText(verdict)}
      </p>
    {/if}
  {/if}
  <p class="mt-2 text-xs text-muted-2">{t("sync.secretsNote")}</p>
</SettingsCard>

<SettingsCard
  title={t("sync.statusTitle")}
  anchor="sync.statusTitle"
  description={t("sync.statusDesc")}
>
  {#snippet actions()}
    <Button
      variant="ghost"
      icon
      title={t("sync.now")}
      ariaLabel={t("sync.now")}
      disabled={syncStore.busy || !remote || !supported}
      onclick={() => void syncStore.syncNow()}
    >
      <RefreshCw size={14} class={syncStore.busy ? "animate-spin" : ""} />
    </Button>
  {/snippet}

  {#if !supported}
    <p class="text-xs text-foreground">{t("sync.unsupportedHere")}</p>
    <p class="mt-0.5 text-xs text-muted-2">{t("sync.unsupportedHereDetail")}</p>
  {:else}
    {#if syncStore.error}
      <p class="mb-1.5 text-xs text-[var(--color-danger)]">{syncStore.error}</p>
    {/if}
    <p class="text-xs text-foreground">{phaseText(job?.phase ?? "idle")}</p>
    {#if syncStore.busy}
      <!-- No aria-valuenow when the length is unknown: a git fetch usually has
           none, and a made-up number reads as progress that is not happening. -->
      <div
        class="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]"
        role="progressbar"
        aria-label={t("sync.statusTitle")}
        aria-valuetext={phaseText(job?.phase ?? "idle")}
      >
        <div class="h-full w-1/3 animate-pulse rounded-full bg-foreground/60"></div>
      </div>
    {/if}
    <p class="mt-1 text-xs text-muted-foreground">
      {job?.lastSyncedAt
        ? t("sync.lastSyncedAt", { when: new Date(job.lastSyncedAt).toLocaleString() })
        : t("sync.neverSynced")}
    </p>
    {#if syncStore.pending > 0}
      <div class="mt-2 flex items-center gap-2">
        <span class="text-xs text-foreground">
          {t("sync.pendingCount", { count: syncStore.pending })}
        </span>
        <Button onclick={() => syncStore.openMerge(null)}>{t("sync.review")}</Button>
      </div>
    {/if}
    {#if job && (job.phase === "failed" || job.phase === "cancelled")}
      <div class="mt-2 flex items-center gap-2">
        <Button onclick={() => void syncStore.dismiss()}>{t("sync.dismiss")}</Button>
        <Button variant="ghost" onclick={() => void syncStore.repair()}>
          {t("sync.repair")}
        </Button>
      </div>
    {/if}
  {/if}
</SettingsCard>

<SettingsCard
  title={t("sync.sourcesTitle")}
  anchor="sync.sourcesTitle"
  description={t("sync.sourcesDesc")}
>
  <div class="overflow-hidden rounded-lg border border-border bg-[var(--color-surface-2)]">
    {#each rows as row (row.id)}
      {@const absent = row.source ? !row.source.presentHere : false}
      <label
        class="flex cursor-pointer items-center justify-between gap-3 border-b border-border/60 px-3 py-2 transition last:border-b-0 hover:bg-[var(--color-surface-3)]"
        class:opacity-60={absent}
      >
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class="flex items-center gap-2">
            {#if row.iconKey}
              <ShortcutIcon iconKey={row.iconKey} size={14} />
            {/if}
            <span class="text-xs text-foreground">{row.label}</span>
          </span>
          {#if row.id === AGENTS_ID}
            <span class="text-xs text-muted-2">{t("sync.agentsRowDesc")}</span>
          {:else if absent}
            <span class="text-xs text-muted-2">{t("sync.sourceAbsent")}</span>
          {/if}
          {#if row.source && row.source.paths.length > 0}
            <span class="truncate font-mono text-xs text-muted-2">
              {row.source.paths.join("  ")}
            </span>
          {/if}
        </span>
        <input
          type="checkbox"
          checked={row.enabled}
          onchange={(event) =>
            settings.setSyncSource(row.id, (event.currentTarget as HTMLInputElement).checked)}
          class="size-4 shrink-0 accent-foreground"
        />
      </label>
    {/each}
  </div>
  {#if notYet.length > 0}
    <p class="mt-2 text-xs text-muted-2">
      {t("sync.sourcesNotYet", { names: notYet.join(", ") })}
    </p>
  {/if}
</SettingsCard>
