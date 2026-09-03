<script lang="ts">
  import { t } from "$lib/i18n/index.svelte";
  import { app } from "$lib/app/store.svelte";
  import { orchestrator } from "$lib/features/orchestrator/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import DashboardCard from "$lib/features/project/DashboardCard.svelte";
  import Button from "$lib/shared/components/Button.svelte";
  import ContextMenu from "$lib/shared/components/ContextMenu.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import VoiceButton from "$lib/features/voice/VoiceButton.svelte";
  import { voice } from "$lib/features/voice/store.svelte";
  import MessageSquareIcon from "@lucide/svelte/icons/message-square";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  /**
   * `fill` is home's layout asking for the whole column. Off, the card keeps the
   * bounded height a dashboard tile needs, which is what every other surface
   * embedding this wants.
   *
   * `hint` is the launcher layout, where this is one card among Start and
   * Recent rather than the page: it draws the line above the input that says
   * what the two keys do.
   */
  let { fill = false, hint = false }: { fill?: boolean; hint?: boolean } = $props();

  let draft = $state("");
  let list: HTMLUListElement | null = $state(null);

  // One thread per scope: the workspace, plus every project the orchestrator
  // watches. Switching scopes swaps the conversation shown; each keeps its own
  // cursor in the store. No flag of its own any more: `enabledFor` already
  // answers false for every project while the workspace experiment is off, so
  // the list empties itself and this chat is not drawn at all.
  const scopes = $derived(
    app.projects.filter((p) => !p.archived && orchestrator.enabledFor(p.id)),
  );

  // A scope that vanished under the selector (project archived, override cut)
  // falls back to the workspace rather than showing a chat nobody answers.
  $effect(() => {
    if (
      orchestrator.scope !== null &&
      !scopes.some((p) => p.id === orchestrator.scope)
    ) {
      orchestrator.scope = null;
    }
  });

  // Event-driven only: one catch-up read on mount, then the watch (desktop
  // Tauri event) or the control plane (remote) call in. No timer anywhere.
  $effect(() => {
    orchestrator.onWorkspaceEvent();
    return orchestrator.watch();
  });

  // The newest line is the one being read; keep it on screen as it lands.
  $effect(() => {
    void orchestrator.conversation.messages.length;
    if (list) list.scrollTop = list.scrollHeight;
  });

  // Speech out rides the same reads the bubbles do: each new orchestrator line
  // is offered to the voice store, which speaks its `aloud` field or nothing.
  $effect(() => {
    voice.considerSpeaking(orchestrator.conversation.messages);
  });

  const voiceOn = $derived(
    settings.state.experimentWorkspace && settings.state.voiceStt !== "off",
  );

  // The scope was a native <select> on a page where every other control is
  // custom. Same menu the sidebar's context menus use, opened under the button
  // that names the current scope.
  const scopeName = $derived(
    orchestrator.scope === null
      ? t("orchestrator.scopeWorkspace")
      : (scopes.find((p) => p.id === orchestrator.scope)?.name ??
        t("orchestrator.scopeWorkspace")),
  );

  let scopeMenu = $state<{
    x: number;
    y: number;
    avoid: { top: number; bottom: number };
  } | null>(null);

  const scopeItems: ContextMenuItem[] = $derived([
    {
      label: t("orchestrator.scopeWorkspace"),
      checked: orchestrator.scope === null,
      action: () => (orchestrator.scope = null),
    },
    ...scopes.map((project) => ({
      label: project.name,
      checked: orchestrator.scope === project.id,
      action: () => (orchestrator.scope = project.id),
    })),
  ]);

  function openScopeMenu(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    scopeMenu = {
      x: rect.left,
      y: rect.bottom,
      avoid: { top: rect.top, bottom: rect.bottom },
    };
  }

  async function send() {
    voice.cancelAutoSend();
    const text = draft;
    draft = "";
    const ok = await orchestrator.post(text);
    if (!ok) draft = text;
  }

  function onKeydown(e: KeyboardEvent) {
    // Any keystroke in the composer is the hand correcting a transcription:
    // the auto-send countdown must lose that race, every time.
    voice.cancelAutoSend();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }
</script>

<DashboardCard title={t("orchestrator.title")} flush class={fill ? "h-full min-h-0" : ""}>
  {#snippet icon()}<MessageSquareIcon class="size-3.5" />{/snippet}
  {#snippet actions()}
    {#if scopes.length > 0}
      <button
        type="button"
        class="flex max-w-36 items-center gap-1 rounded-md border border-edge bg-[var(--color-surface-2)] px-1.5 py-0.5 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground focus-visible:focus-ring-inset"
        aria-label={t("orchestrator.scopeLabel")}
        aria-haspopup="menu"
        aria-expanded={scopeMenu !== null}
        use:tip={t("orchestrator.scopePick")}
        onclick={openScopeMenu}
      >
        <span class="min-w-0 truncate">{scopeName}</span>
        <ChevronDown class="size-3 shrink-0 opacity-60" />
      </button>
    {/if}
  {/snippet}
  <div class="flex flex-col {fill ? 'h-full min-h-0' : 'max-h-80 min-h-40'}">
    {#if orchestrator.conversation.messages.length === 0}
      <p class="flex-1 px-3.5 pb-2 text-sm text-muted-foreground">
        {t("orchestrator.empty")}
      </p>
    {:else}
      <ul
        bind:this={list}
        class="flex flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-2"
      >
        {#each orchestrator.conversation.messages as message (message.id)}
          <ChatMessage {message} />
        {/each}
      </ul>
    {/if}
    {#if voice.pendingSend}
      <p class="border-t border-border px-3 pt-1.5 text-sm text-muted-foreground">
        {t("voice.sending")}
      </p>
    {:else if hint}
      <p class="border-t border-border px-3 pt-1.5 text-sm text-muted-2">
        {t("orchestrator.composerHint")}
      </p>
    {/if}
    <div
      class="flex items-end gap-2 border-border px-2.5 py-2 {voice.pendingSend || hint
        ? ''
        : 'border-t'}"
    >
      {#if voiceOn}
        <VoiceButton
          onTranscript={(text) => (draft = text)}
          onAutoSend={() => void send()}
        />
        {#if settings.state.voicePushToTalk}
          <!-- The chord was documented in the experiments tab and nowhere the
               microphone is. It is the button's tooltip and this chip now.
               Wrapped rather than hidden directly: `kbd.kbd` in app.css sets a
               display Tailwind's `hidden` cannot outrank. A phone has no
               keyboard to hold, so the chip is desktop only. -->
          <span class="hidden shrink-0 self-center whitespace-nowrap sm:block">
            <kbd class="kbd">{t("voice.pushToTalkChord")}</kbd>
          </span>
        {/if}
      {/if}
      <textarea
        rows="1"
        class="max-h-24 min-h-9 flex-1 resize-none rounded-md border border-edge bg-[var(--color-surface-2)] px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-2 focus:border-foreground/30"
        placeholder={t("orchestrator.placeholder")}
        aria-label={t("orchestrator.inputLabel")}
        bind:value={draft}
        onkeydown={onKeydown}
        disabled={orchestrator.posting}
      ></textarea>
      <Button
        variant="primary"
        size="lg"
        onclick={() => void send()}
        disabled={orchestrator.posting || !draft.trim()}
      >
        {t("orchestrator.send")}
      </Button>
    </div>
  </div>
</DashboardCard>

{#if scopeMenu}
  <ContextMenu
    items={scopeItems}
    x={scopeMenu.x}
    y={scopeMenu.y}
    avoid={scopeMenu.avoid}
    onClose={() => (scopeMenu = null)}
  />
{/if}
