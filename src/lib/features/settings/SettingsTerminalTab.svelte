<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import { platform } from "$lib/storage/platform.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import Check from "@lucide/svelte/icons/check";

  function pickDefault(id: string | null) {
    void settings.setDefaultShellId(id);
  }

  function setIdle(value: number) {
    settings.setIdleTimeoutMinutes(value);
  }

  type IconRow = { iconKey: string; label: string };
  const SUPPORTED_AUTOCLOSE: IconRow[] = [
    { iconKey: "claude", label: "Claude" },
    { iconKey: "codex", label: "Codex" },
    { iconKey: "opencode", label: "Opencode" },
    { iconKey: "cursor", label: "Cursor" },
    { iconKey: "gemini", label: "Gemini" },
    { iconKey: "copilot", label: "Copilot" },
  ];
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

<SettingsCard
  title="Thread close"
  description="Behaviour when removing a thread from the sidebar."
>
  <ToggleSetting
    label="Confirm before closing"
    description="Show a dialog before killing a thread's process. Disable for one-click close."
    enabled={settings.state.confirmCloseThread}
    onLabel="On"
    offLabel="Off"
    onToggle={() =>
      settings.setConfirmCloseThread(!settings.state.confirmCloseThread)}
  />
</SettingsCard>

<SettingsCard
  title="Idle auto-close"
  description="Kill agent threads that finished and have not been viewed for a while. Threads stay restorable from the sidebar."
>
  <div class="flex items-center gap-3">
    <label
      for="idle-timeout"
      class="min-w-[140px] text-xs font-medium text-foreground"
    >
      Idle timeout (min)
    </label>
    <input
      id="idle-timeout"
      type="range"
      min="0"
      max="60"
      step="1"
      value={settings.state.idleTimeoutMinutes}
      oninput={(e) => setIdle(Number((e.currentTarget as HTMLInputElement).value))}
      class="flex-1 accent-foreground"
    />
    <span class="min-w-[56px] text-right font-mono text-xs text-muted-foreground">
      {settings.state.idleTimeoutMinutes === 0
        ? "Off"
        : `${settings.state.idleTimeoutMinutes} min`}
    </span>
  </div>

  <div
    class="overflow-hidden rounded-lg border border-border bg-[var(--color-surface-2)]"
    class:opacity-50={settings.state.idleTimeoutMinutes === 0}
  >
    {#each SUPPORTED_AUTOCLOSE as row (row.iconKey)}
      {@const enabled = settings.state.idleAutocloseByIcon[row.iconKey] ?? false}
      <label
        class="flex cursor-pointer items-center justify-between gap-3 border-b border-border/60 px-3 py-2 transition last:border-b-0 hover:bg-[var(--color-surface-3)]"
      >
        <span class="flex items-center gap-2">
          <ShortcutIcon iconKey={row.iconKey as never} size={14} />
          <span class="text-xs text-foreground">{row.label}</span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={settings.state.idleTimeoutMinutes === 0}
          onchange={(e) =>
            settings.setIdleAutocloseForIcon(
              row.iconKey,
              (e.currentTarget as HTMLInputElement).checked,
            )}
          class="size-4 accent-foreground"
        />
      </label>
    {/each}
  </div>
</SettingsCard>
