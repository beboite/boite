<script lang="ts">
  import { t, activeLocale } from "$lib/i18n/index.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import type { VoiceStt, VoiceTts } from "$lib/types";
  import { sttAvailability } from "./stt";
  import { listVoices, ttsSupported, voiceMatchesLocale, watchVoices } from "./tts";
  import { captureAvailability, testMicrophone } from "./capture";

  const RADIO =
    "rounded-md border px-3 py-1 text-xs transition border-border bg-[var(--color-surface-2)] text-muted-foreground hover:border-foreground/30 hover:text-foreground";
  const RADIO_ON =
    "rounded-md border px-3 py-1 text-xs transition border-foreground/40 bg-[var(--color-surface-3)] text-foreground";

  const stt = sttAvailability();
  const capture = captureAvailability();

  // `whisper` records here and transcribes on the paired host: the gate is the
  // microphone, not a speech engine, so it stays offered where webspeech is not.
  const STT_MODES: { id: VoiceStt; label: string; ok: boolean }[] = [
    { id: "off", label: t("voice.off"), ok: true },
    { id: "webspeech", label: t("voice.webspeech"), ok: stt.ok },
    { id: "whisper", label: t("voice.whisper"), ok: capture.ok },
  ];
  const TTS_MODES: { id: VoiceTts; label: string }[] = [
    { id: "off", label: t("voice.off") },
    { id: "webspeech", label: t("voice.webspeech") },
  ];

  // The engine fills its voice list asynchronously; the watcher refreshes the
  // select when it lands so the page never needs a reload to show them.
  let voices = $state(listVoices());
  $effect(() => watchVoices(() => (voices = listVoices())));

  // Locale matches first, so the voice the user probably wants is at the top;
  // nothing is preselected for them, ever.
  const sorted = $derived(
    [...voices].sort((a, b) => {
      const am = voiceMatchesLocale(a, activeLocale()) ? 0 : 1;
      const bm = voiceMatchesLocale(b, activeLocale()) ? 0 : 1;
      return am - bm || a.name.localeCompare(b.name);
    }),
  );
  const noneMatch = $derived(
    voices.length > 0 && !voices.some((v) => voiceMatchesLocale(v, activeLocale())),
  );

  let micResult = $state<string | null>(null);

  async function testMic() {
    micResult = null;
    const result = await testMicrophone();
    micResult = result.ok ? t("voice.micOk") : t("voice.micFailed", { error: result.error });
  }
</script>

<div class="flex flex-col gap-2 pl-3">
  <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t("voice.stt")}>
    <span class="w-20 shrink-0 text-xs text-muted-foreground">{t("voice.stt")}</span>
    {#each STT_MODES as mode (mode.id)}
      <button
        type="button"
        role="radio"
        aria-checked={settings.state.voiceStt === mode.id}
        aria-disabled={!mode.ok}
        class={settings.state.voiceStt === mode.id ? RADIO_ON : RADIO}
        onclick={() => {
          if (!mode.ok) return;
          settings.setVoiceStt(mode.id);
        }}
      >
        {mode.label}
      </button>
    {/each}
  </div>
  <!-- Honesty over hope: the same build hears on Android Chrome and not in
       WebKitGTK, and the line says so instead of a mic that silently fails. -->
  {#if !stt.ok}
    <p class="text-xs text-muted-foreground">{t(stt.reasonKey)}</p>
  {/if}
  {#if !capture.ok}
    <p class="text-xs text-muted-foreground">{t(capture.reasonKey)}</p>
  {:else if settings.state.voiceStt === "whisper"}
    <p class="text-xs text-muted-foreground">{t("voice.whisperDesc")}</p>
  {/if}

  <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t("voice.tts")}>
    <span class="w-20 shrink-0 text-xs text-muted-foreground">{t("voice.tts")}</span>
    {#each TTS_MODES as mode (mode.id)}
      <button
        type="button"
        role="radio"
        aria-checked={settings.state.voiceTts === mode.id}
        aria-disabled={mode.id === "webspeech" && !ttsSupported()}
        class={settings.state.voiceTts === mode.id ? RADIO_ON : RADIO}
        onclick={() => {
          if (mode.id === "webspeech" && !ttsSupported()) return;
          settings.setVoiceTts(mode.id);
        }}
      >
        {mode.label}
      </button>
    {/each}
  </div>

  {#if settings.state.voiceTts === "webspeech" && ttsSupported()}
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="w-20 shrink-0 text-xs text-muted-foreground">{t("voice.voice")}</span>
      <select
        class="max-w-64 rounded-md border border-edge bg-[var(--color-surface-2)] px-1.5 py-0.5 text-xs text-foreground outline-none focus:border-foreground/30"
        aria-label={t("voice.voice")}
        value={settings.state.voiceName ?? ""}
        onchange={(e) => settings.setVoiceName(e.currentTarget.value || null)}
      >
        <option value="">{t("voice.voicePick")}</option>
        {#each sorted as v (v.name)}
          <option value={v.name}>{v.name} ({v.lang})</option>
        {/each}
      </select>
    </div>
    {#if noneMatch}
      <p class="text-xs text-amber-500">{t("voice.voiceNoneMatch")}</p>
    {/if}
  {/if}

  <div class="flex items-center gap-2">
    <button
      type="button"
      class="rounded-md border border-edge px-3 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      onclick={() => void testMic()}
    >
      {t("voice.testMic")}
    </button>
    {#if micResult}
      <span class="text-xs text-muted-foreground">{micResult}</span>
    {/if}
  </div>

  <!-- No anchors on the three toggles below: the catalogue test only scans the
       Settings*Tab files, and an anchor it cannot see is an id search jumps to
       while the index swears it does not exist. The experiment row above is the
       search's landing spot for the whole block. -->
  <ToggleSetting
    label={t("voice.pushToTalk")}
    description={t("voice.pushToTalkDesc")}
    enabled={settings.state.voicePushToTalk}
    onToggle={() => settings.setVoicePushToTalk(!settings.state.voicePushToTalk)}
  />
  <ToggleSetting
    label={t("voice.autoSend")}
    description={t("voice.autoSendDesc")}
    enabled={settings.state.voiceAutoSend}
    onToggle={() => settings.setVoiceAutoSend(!settings.state.voiceAutoSend)}
  />
  <ToggleSetting
    label={t("voice.speakUnfocused")}
    description={t("voice.speakUnfocusedDesc")}
    enabled={settings.state.voiceSpeakWhenUnfocused}
    onToggle={() =>
      settings.setVoiceSpeakWhenUnfocused(!settings.state.voiceSpeakWhenUnfocused)}
  />
</div>
