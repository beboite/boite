<script lang="ts">
  import { onMount } from "svelte";
  import { CLI_PRESETS } from "$lib/features/settings/cliPresets";
  import { cliDetection } from "$lib/features/settings/cliDetection.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { uuid } from "$lib/shared/utils/uuid";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Settings2 from "@lucide/svelte/icons/settings-2";
  import { t } from "$lib/i18n/index.svelte";
  import type { IconKey } from "$lib/types";
  import type { SetupStepProps } from "./steps";

  let { draft }: SetupStepProps = $props();

  const found = $derived(CLI_PRESETS.filter((p) => cliDetection.found[p.executable]));

  // The list the user ends up with is exactly what was found. Nothing to pick,
  // nothing to order: both are one click away in the settings, and the hint
  // below says so.
  $effect(() => {
    draft.shortcuts = found.map((preset) => ({
      id: uuid(),
      label: preset.label,
      command: preset.command,
      iconKey: preset.iconKey as IconKey,
    }));
  });

  onMount(() => {
    void cliDetection.ensure();
  });
</script>

<h2 class="text-center text-lg font-bold text-foreground">{t("setup.agentsTitle")}</h2>

{#if !cliDetection.probed}
  <div class="flex flex-col items-center gap-3 py-8">
    <div class="size-6 animate-spin rounded-full border-2 border-border border-t-foreground"></div>
    <p class="text-xs text-muted-foreground">{t("setup.agentsSearching")}</p>
  </div>
{:else if found.length > 0}
  <p class="text-center text-xs text-muted-foreground">{t("setup.agentsFound")}</p>
  <ul class="flex flex-wrap justify-center gap-2">
    {#each found as preset (preset.id)}
      <li
        class="flex items-center gap-2 rounded-full border border-border bg-[var(--color-surface-2)] py-1.5 pl-2 pr-3.5"
      >
        <ShortcutIcon iconKey={preset.iconKey as IconKey} size={16} />
        <span class="text-xs font-semibold text-foreground">{preset.label}</span>
      </li>
    {/each}
  </ul>
{:else}
  <div class="flex flex-col items-center gap-2 py-4 text-center">
    <p class="text-sm text-foreground">{t("setup.agentsNone")}</p>
    <p class="max-w-sm text-xs leading-relaxed text-muted-foreground">
      {t("setup.agentsNoneHint")}
    </p>
  </div>
{/if}

{#if cliDetection.probed}
  <div class="flex justify-center">
    <button
      type="button"
      onclick={() => void cliDetection.refreshAll()}
      disabled={cliDetection.checking}
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
    >
      <RefreshCw class="size-3 {cliDetection.checking ? 'animate-spin' : ''}" />
      {t("setup.agentsRecheck")}
    </button>
  </div>
{/if}

<p
  class="flex items-start gap-2 rounded-lg border border-border/70 bg-[var(--color-surface-2)] p-3 text-sm leading-relaxed text-muted-foreground"
>
  <Settings2 class="mt-0.5 size-3.5 shrink-0" />
  <span>{t("setup.settingsHint")}</span>
</p>
