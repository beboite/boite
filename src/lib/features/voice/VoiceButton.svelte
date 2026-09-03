<script lang="ts">
  import { t, activeLocale } from "$lib/i18n/index.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { backend } from "$lib/backend/active.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { sttAvailability, SttSession } from "./stt";
  import { captureAvailability, ClipRecorder, encodeWavBase64 } from "./capture";
  import { PushToTalk } from "./ptt.svelte";
  import { voice } from "./store.svelte";
  import MicIcon from "@lucide/svelte/icons/mic";
  import Button from "$lib/shared/components/Button.svelte";

  // The live transcript replaces the composer text while talking; on release
  // the final text stays there, editable, and auto-send (when armed) counts
  // down in the store where the composer can cancel it.
  //
  // Two engines behind one hold. `webspeech` hears in this webview and streams
  // interim text; `whisper` records a clip here and asks the paired host's
  // whisper.cpp for the text on release — no interim, one bounded body over
  // the bus, which is what a webview without a speech engine gets.
  let {
    onTranscript,
    onAutoSend,
  }: { onTranscript: (text: string) => void; onAutoSend: () => void } = $props();

  const engine = $derived(settings.state.voiceStt);
  const availability = $derived(
    engine === "whisper" ? captureAvailability() : sttAvailability(),
  );

  let session: SttSession | null = $state(null);
  let recorder: ClipRecorder | null = $state(null);
  let busy = $state(false);
  const listening = $derived(session !== null || recorder !== null);

  function landed(text: string) {
    if (!text.trim()) return;
    onTranscript(text);
    if (settings.state.voiceAutoSend) voice.armAutoSend(onAutoSend);
  }

  function beginSpeech() {
    if (session) return;
    const next = new SttSession(
      activeLocale(),
      (text) => onTranscript(text),
      (text) => {
        session = null;
        landed(text);
      },
    );
    session = next.start() ? next : null;
  }

  async function beginClip() {
    if (recorder || busy) return;
    const next = new ClipRecorder();
    recorder = next;
    if (!(await next.start())) recorder = null;
  }

  async function endClip() {
    const rec = recorder;
    recorder = null;
    if (!rec) return;
    const clip = await rec.stop();
    if (!clip || clip.size === 0) return;
    busy = true;
    try {
      const audio = await encodeWavBase64(clip);
      if (audio === null) {
        notifications.error(t("voice.transcribeFailed", { error: "AUDIO_TOO_LONG" }));
        return;
      }
      const conduct = backend().conduct;
      if (!conduct) return;
      const { text } = await conduct.transcribe({
        audio,
        mime: "audio/wav",
        provider: "whisper-local",
      });
      landed(text);
    } catch (err) {
      // The bus's own words (NO_WHISPER, AUDIO_TOO_LONG), quoted not translated:
      // they name the fix.
      notifications.error(t("voice.transcribeFailed", { error: String(err) }));
    } finally {
      busy = false;
    }
  }

  function begin() {
    if (!availability.ok) return;
    if (engine === "whisper") void beginClip();
    else beginSpeech();
  }

  function end() {
    if (engine === "whisper") void endClip();
    else session?.stop();
  }

  // The hold key lives only while a mic button is on screen: no global
  // registration, nothing to fight the keyboard controller for.
  $effect(() => {
    if (!settings.state.voicePushToTalk || !availability.ok) return;
    return new PushToTalk(begin, end).watch();
  });

  // The chord used to be written in the experiments tab only, so the one
  // visible voice control never said a key existed.
  const hold = $derived(
    settings.state.voicePushToTalk ? t("voice.holdChord") : t("voice.hold"),
  );
  const label = $derived(
    busy ? t("voice.transcribing") : availability.ok ? hold : t(availability.reasonKey),
  );
</script>

<!-- The composer's own metrics: the mic, the box and the send button are one
     height, which they were not while each carried its own padding. -->
<Button
  size="lg"
  icon
  variant={listening ? "danger" : "secondary"}
  disabled={!availability.ok || busy}
  ariaLabel={hold}
  tip={label}
  class={listening ? "border-red-500/60 bg-red-500/10 text-foreground" : ""}
  onpointerdown={begin}
  onpointerup={end}
  onpointercancel={end}
  onpointerleave={end}
  pressed={listening}
  {busy}
>
  <MicIcon class="size-4 {busy ? 'animate-pulse' : ''}" />
  <span class="sr-only">{listening ? t("voice.listening") : hold}</span>
</Button>
