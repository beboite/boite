<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import { platform } from "$lib/storage/platform.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import Check from "@lucide/svelte/icons/check";

  function pickDefault(id: string | null) {
    void settings.setDefaultShellId(id);
  }
</script>

<SettingsCard
  title="Default shell"
  description="Used by + Terminal and to wrap shortcut commands so aliases (e.g. cc → claude) resolve through your shell profile."
>
  <div class="overflow-hidden rounded-lg border border-border bg-[var(--color-surface-2)]">
    <button
      type="button"
      class="flex w-full items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-left transition hover:bg-[var(--color-surface-3)]"
      onclick={() => pickDefault(null)}
    >
      <div class="min-w-0">
        <div class="text-xs font-medium text-foreground">No wrapping</div>
        <div class="text-[10.5px] text-muted-foreground">
          Run shortcut commands directly. + Terminal launches the platform default.
        </div>
      </div>
      {#if settings.state.defaultShellId === null}
        <Check class="size-3.5 shrink-0 text-foreground" />
      {/if}
    </button>
    {#each platform.shells as shell (shell.id)}
      {@const active = settings.state.defaultShellId === shell.id}
      <button
        type="button"
        class="flex w-full items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-left transition last:border-b-0 hover:bg-[var(--color-surface-3)]"
        onclick={() => pickDefault(shell.id)}
      >
        <div class="min-w-0">
          <div class="text-xs font-medium text-foreground">{shell.label}</div>
          <div class="truncate font-mono text-[10.5px] text-muted-foreground">
            {shell.cmd}
            {#if shell.args.length > 0}
              <span class="text-muted-foreground/70">{" " + shell.args.join(" ")}</span>
            {/if}
          </div>
        </div>
        {#if active}
          <Check class="size-3.5 shrink-0 text-foreground" />
        {/if}
      </button>
    {/each}
  </div>
</SettingsCard>

{#if platform.isWindows}
  <SettingsCard
    title="Windows tweaks"
    description="Behaviours specific to PowerShell and the Windows console."
  >
    <ToggleSetting
      label="PowerShell newline translation"
      description="Shift+Enter sends LF (Ctrl+J) so PowerShell wraps a line without executing."
      enabled={settings.state.powershellNewline}
      onLabel="On"
      offLabel="Off"
      onToggle={() =>
        settings.setPowershellNewline(!settings.state.powershellNewline)}
    />
  </SettingsCard>
{/if}
