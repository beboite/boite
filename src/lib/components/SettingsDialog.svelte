<script lang="ts">
  import { settings, PRESETS } from "$lib/settings.svelte";
  import X from "@lucide/svelte/icons/x";
  import Check from "@lucide/svelte/icons/check";

  type Props = { open: boolean; onClose: () => void };
  let { open = $bindable(), onClose }: Props = $props();

  let cmd = $state(settings.state.defaultCmd);
  let argsText = $state(settings.state.defaultArgs.join(" "));
  let powershellNewline = $state(settings.state.powershellNewline);

  $effect(() => {
    if (open) {
      cmd = settings.state.defaultCmd;
      argsText = settings.state.defaultArgs.join(" ");
      powershellNewline = settings.state.powershellNewline;
    }
  });

  async function applyPreset(presetCmd: string, presetArgs: string[]) {
    cmd = presetCmd;
    argsText = presetArgs.join(" ");
    await settings.update({ defaultCmd: presetCmd, defaultArgs: [...presetArgs] });
  }

  async function save() {
    const parsedArgs = argsText
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    await settings.update({
      defaultCmd: cmd.trim() || "claude",
      defaultArgs: parsedArgs,
      powershellNewline,
    });
    open = false;
    onClose();
  }

  function cancel() {
    open = false;
    onClose();
  }

  function isActivePreset(presetCmd: string, presetArgs: string[]): boolean {
    return (
      cmd.trim() === presetCmd &&
      argsText.trim() === presetArgs.join(" ").trim()
    );
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={(e) => {
      if (e.target === e.currentTarget) cancel();
    }}
    onkeydown={(e) => {
      if (e.key === "Escape") cancel();
    }}
  >
    <div
      class="w-[480px] overflow-hidden rounded-xl border border-border bg-[var(--color-surface)] shadow-2xl"
    >
      <header class="flex items-center justify-between border-b px-5 py-3">
        <h2 class="text-sm font-semibold tracking-tight">Settings</h2>
        <button
          type="button"
          class="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          onclick={cancel}
          aria-label="Close"
        >
          <X class="size-4" />
        </button>
      </header>

      <div class="space-y-5 px-5 py-4">
        <section>
          <h3
            class="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
          >
            Default command
          </h3>
          <div class="grid grid-cols-3 gap-1.5">
            {#each PRESETS as preset (preset.id)}
              {@const active = isActivePreset(preset.cmd, preset.args)}
              <button
                type="button"
                class="flex items-center justify-between rounded-md border px-2.5 py-1.5 text-xs transition {active
                  ? 'border-foreground/40 bg-accent text-foreground'
                  : 'border-border bg-[var(--color-surface-2)] text-muted-foreground hover:border-foreground/20 hover:text-foreground'}"
                onclick={() => applyPreset(preset.cmd, preset.args)}
              >
                <span class="truncate">{preset.label}</span>
                {#if active}<Check class="size-3 shrink-0" />{/if}
              </button>
            {/each}
          </div>

          <div class="mt-3 grid grid-cols-[1fr_2fr] gap-2">
            <label class="block">
              <span class="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                Command
              </span>
              <input
                type="text"
                bind:value={cmd}
                placeholder="claude"
                class="w-full rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1.5 font-mono text-xs outline-none transition focus:border-foreground/40"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                Args
              </span>
              <input
                type="text"
                bind:value={argsText}
                placeholder="--resume"
                class="w-full rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1.5 font-mono text-xs outline-none transition focus:border-foreground/40"
              />
            </label>
          </div>
          <p class="mt-1.5 text-[10px] text-muted-foreground/80">
            Used when adding a new project from a folder.
          </p>
        </section>

        <section class="border-t pt-4">
          <h3
            class="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
          >
            Terminal
          </h3>
          <label class="flex cursor-pointer items-start gap-3 rounded-md border border-transparent p-2 transition hover:border-border hover:bg-accent/40">
            <input
              type="checkbox"
              bind:checked={powershellNewline}
              class="mt-0.5 size-3.5 shrink-0 accent-foreground"
            />
            <div class="flex-1">
              <div class="text-xs font-medium text-foreground">
                PowerShell newline translation
              </div>
              <div class="text-[10px] text-muted-foreground">
                Shift+Enter sends LF (Ctrl+J) to wrap a line without executing.
              </div>
            </div>
          </label>
        </section>
      </div>

      <footer class="flex justify-end gap-2 border-t bg-[var(--color-titlebar)] px-5 py-3">
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
          onclick={cancel}
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:bg-foreground/90"
          onclick={save}
        >
          Save
        </button>
      </footer>
    </div>
  </div>
{/if}
