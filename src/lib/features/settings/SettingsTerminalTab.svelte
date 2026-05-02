<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import { platform } from "$lib/storage/platform.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
</script>

<SettingsCard
  title="Detected shells"
  description="Available on this platform — used by the + Terminal picker."
>
  <div class="overflow-hidden rounded-lg border border-border bg-[var(--color-surface-2)]">
    {#if platform.shells.length === 0}
      <p class="px-4 py-6 text-center text-xs text-muted-foreground">
        No shells detected.
      </p>
    {/if}
    {#each platform.shells as shell (shell.id)}
      <div
        class="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2 last:border-b-0"
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
        <span
          class="rounded-sm bg-[var(--color-surface-3)] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/80"
        >
          {shell.id}
        </span>
      </div>
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
