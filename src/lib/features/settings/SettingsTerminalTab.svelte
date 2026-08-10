<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import { platform } from "$lib/storage/platform.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import Check from "@lucide/svelte/icons/check";
  import { t } from "$lib/i18n/index.svelte";

  function pickDefault(id: string | null) {
    void settings.setDefaultShellId(id);
  }

  function setIdle(value: number) {
    settings.setIdleTimeoutMinutes(value);
  }

  function setAutoFetchSeconds(value: number) {
    settings.setGitAutoFetchSeconds(value);
  }

  // Labels are the agents' own product names, so they read the same in every
  // locale and stay out of the dictionary.
  type IconRow = { iconKey: string; label: string };
  const SUPPORTED_AUTOCLOSE: IconRow[] = [
    { iconKey: "claude", label: "Claude" },
    { iconKey: "codex", label: "Codex" },
    { iconKey: "opencode", label: "Opencode" },
    { iconKey: "cursor", label: "Cursor" },
    { iconKey: "antigravity", label: "Antigravity" },
    { iconKey: "copilot", label: "Copilot" },
    { iconKey: "grok", label: "Grok" },
    { iconKey: "hermes", label: "Hermes" },
    { iconKey: "pi", label: "Pi" },
    { iconKey: "muse", label: "Muse" },
  ];
</script>

<SettingsCard
  title={t("terminalTab.defaultShell")}
  description={t("terminalTab.defaultShellDesc")}
>
  <div class="overflow-hidden rounded-lg border border-border bg-[var(--color-surface-2)]">
    <button
      type="button"
      class="flex w-full items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-left transition hover:bg-[var(--color-surface-3)]"
      onclick={() => pickDefault(null)}
    >
      <div class="min-w-0">
        <div class="text-xs font-medium text-foreground">{t("terminalTab.shellNone")}</div>
        <div class="text-xs text-muted-foreground">
          {t("terminalTab.shellNoneDesc")}
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
          <div class="truncate font-mono text-xs text-muted-foreground">
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

{#if platform.isHostWindows}
  <SettingsCard
    title={t("terminalTab.windowsTweaks")}
    description={t("terminalTab.windowsTweaksDesc")}
  >
    <ToggleSetting
      label={t("terminalTab.psNewline")}
      description={t("terminalTab.psNewlineDesc")}
      enabled={settings.state.powershellNewline}
      onToggle={() =>
        settings.setPowershellNewline(!settings.state.powershellNewline)}
    />
    <ToggleSetting
      label={t("terminalTab.psNoProfile")}
      description={t("terminalTab.psNoProfileDesc")}
      enabled={settings.state.powershellNoProfile}
      onToggle={() =>
        settings.setPowershellNoProfile(!settings.state.powershellNoProfile)}
    />
  </SettingsCard>
{/if}

<SettingsCard
  title={t("terminalTab.threadClose")}
  description={t("terminalTab.threadCloseDesc")}
>
  <ToggleSetting
    label={t("terminalTab.confirmClose")}
    description={t("terminalTab.confirmCloseDesc")}
    enabled={settings.state.confirmCloseThread}
    onToggle={() =>
      settings.setConfirmCloseThread(!settings.state.confirmCloseThread)}
  />
</SettingsCard>

<SettingsCard
  title={t("terminalTab.gitAutoFetch")}
  description={t("terminalTab.gitAutoFetchDesc")}
>
  <ToggleSetting
    label={t("terminalTab.autoFetch")}
    description={t("terminalTab.autoFetchDesc")}
    enabled={settings.state.gitAutoFetch}
    onToggle={() => settings.setGitAutoFetch(!settings.state.gitAutoFetch)}
  />

  <div
    class="flex items-center gap-3"
    class:opacity-50={!settings.state.gitAutoFetch}
  >
    <label
      for="autofetch-period"
      class="min-w-[140px] text-xs font-medium text-foreground"
    >
      {t("terminalTab.fetchEvery")}
    </label>
    <input
      id="autofetch-period"
      type="range"
      min="30"
      max="600"
      step="30"
      value={settings.state.gitAutoFetchSeconds}
      disabled={!settings.state.gitAutoFetch}
      oninput={(e) =>
        setAutoFetchSeconds(Number((e.currentTarget as HTMLInputElement).value))}
      class="flex-1 accent-foreground"
    />
    <span class="min-w-[56px] text-right font-mono text-xs text-muted-foreground">
      {settings.state.gitAutoFetchSeconds < 60
        ? t("terminalTab.seconds", { count: settings.state.gitAutoFetchSeconds })
        : t("terminalTab.minutes", {
            count: Math.round(settings.state.gitAutoFetchSeconds / 60),
          })}
    </span>
  </div>
</SettingsCard>

<!-- Both of these were live settings with no way to reach them: read on every
     thread launch, hydrated from storage, and pinned to their default because
     nothing ever called their setter. -->
<SettingsCard
  title={t("terminalTab.agentLaunch")}
  description={t("terminalTab.agentLaunchDesc")}
>
  <ToggleSetting
    label={t("terminalTab.threadWorktrees")}
    description={t("terminalTab.threadWorktreesDesc")}
    enabled={settings.state.threadWorktrees}
    onToggle={() => void settings.setThreadWorktrees(!settings.state.threadWorktrees)}
  />
  <ToggleSetting
    label={t("terminalTab.agentTodoAccess")}
    description={t("terminalTab.agentTodoAccessDesc")}
    enabled={settings.state.agentTodoAccess}
    onToggle={() => void settings.setAgentTodoAccess(!settings.state.agentTodoAccess)}
  />
  <ToggleSetting
    label={t("terminalTab.mcpYolo")}
    description={t("terminalTab.mcpYoloDesc")}
    enabled={settings.state.mcpYolo}
    onToggle={() => void settings.setMcpYolo(!settings.state.mcpYolo)}
  />
  {#if settings.state.mcpYolo}
    <!-- Said on the card rather than in the description: the line that matters
         is the one you read while it is on, not the one you read deciding. -->
    <p class="-mt-0.5 text-xs leading-snug text-warning">
      {t("terminalTab.mcpYoloOn")}
    </p>
  {/if}

  <div class="flex flex-col gap-1.5" class:opacity-50={!settings.state.agentTodoAccess}>
    <label for="todo-template" class="text-xs font-medium text-foreground">
      {t("terminalTab.todoTemplate")}
    </label>
    <p class="text-xs leading-snug text-muted-foreground">
      {t("terminalTab.todoTemplateDesc")}
    </p>
    <textarea
      id="todo-template"
      rows="7"
      spellcheck="false"
      disabled={!settings.state.agentTodoAccess}
      value={settings.state.todoPromptTemplate}
      onchange={(e) =>
        void settings.setTodoPromptTemplate((e.currentTarget as HTMLTextAreaElement).value)}
      class="w-full resize-y rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-2 font-mono text-sm leading-relaxed text-foreground outline-none focus:border-foreground/40 disabled:cursor-not-allowed"
    ></textarea>
    <button
      type="button"
      class="self-start rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      onclick={() => void settings.setTodoPromptTemplate("")}
    >
      {t("common.reset")}
    </button>
  </div>
</SettingsCard>

<SettingsCard
  title={t("terminalTab.idleAutoClose")}
  description={t("terminalTab.idleAutoCloseDesc")}
>
  <div class="flex items-center gap-3">
    <label
      for="idle-timeout"
      class="min-w-[140px] text-xs font-medium text-foreground"
    >
      {t("terminalTab.idleTimeout")}
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
        ? t("common.off")
        : t("terminalTab.minutes", { count: settings.state.idleTimeoutMinutes })}
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
