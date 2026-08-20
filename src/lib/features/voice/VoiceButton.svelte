<script lang="ts">
  import { t, activeLocale } from "$lib/i18n/index.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { sttAvailability, SttSession } from "./stt";
  import { PushToTalk } from "./ptt.svelte";
  import { voice } from "./store.svelte";
  import MicIcon from "@lucide/svelte/icons/mic";

  // The live transcript replaces the composer text while talking; on release
  // the final text stays there, editable, and auto-send (when armed) counts
  // down in the store where the composer can cancel it.
  let {
    onTranscript,
    onAutoSend,
  }: { onTranscript: (text: string) => void; onAutoSend: () => void } = $props();

  const availability = sttAvailability();
  let session: SttSession | null = $state(null);
  const listening = $derived(session !== null);

  function begin() {
    if (session || !availability.ok) return;
    const next = new SttSession(
      activeLocale(),
      (text) => onTranscript(text),
      (text) => {
        session = null;
        if (!text.trim()) return;
        onTranscript(text);
        if (settings.state.voiceAutoSend) voice.armAutoSend(onAutoSend);
      },
    );
    session = next.start() ? next : null;
  }

  function end() {
    session?.stop();
  }

  // The hold key lives only while a mic button is on screen: no global
  // registration, nothing to fight the keyboard controller for.
  $effect(() => {
    if (!settings.state.voicePushToTalk || !availability.ok) return;
    return new PushToTalk(begin, end).watch();
  });
</script>

<button
  type="button"
  class="rounded-md border px-2 py-1 text-xs transition disabled:opacity-50 {listening
    ? 'border-red-500/60 bg-red-500/10 text-foreground'
    : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'}"
  aria-pressed={listening}
  aria-label={t("voice.hold")}
  title={availability.ok ? t("voice.hold") : t(availability.reasonKey)}
  disabled={!availability.ok}
  onpointerdown={begin}
  onpointerup={end}
  onpointercancel={end}
  onpointerleave={end}
>
  <MicIcon class="size-3.5" />
  <span class="sr-only">{listening ? t("voice.listening") : t("voice.hold")}</span>
</button>
