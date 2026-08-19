<!--
  The CLI manager: one row per agent Boite can launch, with what this machine has
  and what it takes to change that.

  It answers for the machine the threads spawn on, which for a remote boite is the
  server rather than the device drawing this panel — the same rule the presence
  probe beside it follows.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import CliRow from "$lib/features/cli/CliRow.svelte";
  import { cliManager } from "$lib/features/cli/store.svelte";
  import { t } from "$lib/i18n/index.svelte";

  onMount(() => {
    void cliManager.ensure();
    // Not awaited alongside the rows: what this machine has takes milliseconds
    // and what six vendors publish does not, so the list draws first and the
    // rows stop saying "Update" as the answers land.
    void cliManager.checkLatest();
  });
</script>

<SettingsCard title={t("cli.title")} anchor="cli.title" description={t("cli.description")}>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
      onclick={() => {
        void cliManager.refresh(true);
        void cliManager.checkLatest(true);
      }}
      disabled={cliManager.loading || cliManager.checking}
      title={t("cli.recheck")}
    >
      <RefreshCw class="size-3 {cliManager.loading || cliManager.checking ? 'animate-spin' : ''}" />
      {t("cli.recheck")}
    </button>
  {/snippet}

  {#if cliManager.error}
    <p class="text-xs leading-snug text-[var(--color-danger)]">{cliManager.error}</p>
  {/if}

  <div class="flex flex-col gap-1.5">
    {#each cliManager.rows as row (row.id)}
      <CliRow {row} />
    {/each}
  </div>
</SettingsCard>
