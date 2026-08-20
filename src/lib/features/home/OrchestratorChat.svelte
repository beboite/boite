<script lang="ts">
  import { t } from "$lib/i18n/index.svelte";
  import { app } from "$lib/app/store.svelte";
  import { orchestrator } from "$lib/features/orchestrator/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import DashboardCard from "$lib/features/project/DashboardCard.svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import VoiceButton from "$lib/features/voice/VoiceButton.svelte";
  import { voice } from "$lib/features/voice/store.svelte";
  import MessageSquareIcon from "@lucide/svelte/icons/message-square";

  let draft = $state("");
  let list: HTMLUListElement | null = $state(null);

  // One thread per scope: the workspace, plus every project the orchestrator
  // watches while the per-project experiment is armed. Switching scopes swaps
  // the conversation shown; each keeps its own cursor in the store.
  const scopes = $derived(
    settings.state.experimentOrchestratorPerProject
      ? app.projects.filter((p) => !p.archived && orchestrator.enabledFor(p.id))
      : [],
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
    settings.state.experimentVoice && settings.state.voiceStt !== "off",
  );

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

<DashboardCard title={t("orchestrator.title")} flush>
  {#snippet icon()}<MessageSquareIcon class="size-3.5" />{/snippet}
  {#snippet actions()}
    {#if scopes.length > 0}
      <select
        class="max-w-36 rounded-md border border-border bg-[var(--color-surface-2)] px-1.5 py-0.5 text-xs text-muted-foreground outline-none focus:border-foreground/30"
        aria-label={t("orchestrator.scopeLabel")}
        bind:value={orchestrator.scope}
      >
        <option value={null}>{t("orchestrator.scopeWorkspace")}</option>
        {#each scopes as project (project.id)}
          <option value={project.id}>{project.name}</option>
        {/each}
      </select>
    {/if}
  {/snippet}
  <div class="flex max-h-80 min-h-40 flex-col">
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
      <p class="border-t border-border px-3 pt-1.5 text-xs text-muted-foreground">
        {t("voice.sending")}
      </p>
    {/if}
    <div
      class="flex items-end gap-1.5 border-border px-2.5 py-2 {voice.pendingSend
        ? ''
        : 'border-t'}"
    >
      {#if voiceOn}
        <VoiceButton
          onTranscript={(text) => (draft = text)}
          onAutoSend={() => void send()}
        />
      {/if}
      <textarea
        rows="1"
        class="max-h-24 min-h-7 flex-1 resize-none rounded-md border border-border bg-[var(--color-surface-2)] px-2 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/30"
        placeholder={t("orchestrator.placeholder")}
        bind:value={draft}
        onkeydown={onKeydown}
        disabled={orchestrator.posting}
      ></textarea>
      <button
        type="button"
        class="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
        onclick={() => void send()}
        disabled={orchestrator.posting || !draft.trim()}
      >
        {t("orchestrator.send")}
      </button>
    </div>
  </div>
</DashboardCard>
