<script lang="ts">
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import UpdatesCard from "$lib/features/updater/UpdatesCard.svelte";
  import LogsSection from "./LogsSection.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import { hasTauri } from "$lib/backend/env";
  import { workspace } from "$lib/backend";
  import { settings } from "$lib/features/settings/store.svelte";
  import type { ServerIdentity } from "$lib/backend/types";
  import type { Platform } from "$lib/storage/platform.svelte";
  import type { MessageKey } from "$lib/i18n/index.svelte";
  import type { WhipSound } from "$lib/types";
  import { openUrl } from "$lib/platform/opener";
  import { t } from "$lib/i18n/index.svelte";

  const RADIO =
    "rounded-md border px-3 py-1 text-xs transition border-border bg-[var(--color-surface-2)] text-muted-foreground hover:border-foreground/30 hover:text-foreground";
  const RADIO_ON =
    "rounded-md border px-3 py-1 text-xs transition border-foreground/40 bg-[var(--color-surface-3)] text-foreground";

  const WHIP_SOUNDS: { id: WhipSound; labelKey: MessageKey }[] = [
    { id: "synth", labelKey: "experiments.whipSoundSynth" },
    { id: "sampled", labelKey: "experiments.whipSoundMeme" },
  ];

  function whipSoundOn(id: WhipSound): boolean {
    if (id === "sampled") {
      return settings.state.whipSound === "sampled" || settings.state.whipSound === "meme";
    }
    return settings.state.whipSound === id;
  }

  /**
   * Cracks once so the choice is audible.
   *
   * The module is imported here rather than at the top so the settings chunk
   * does not carry the whip's audio for the pages that never open this row, and
   * the sample is awaited: previewing `meme` and hearing the synth because the
   * fetch had not landed is the one thing this button must not do.
   */
  async function playPreview(sound: WhipSound) {
    const { playCrack, primeCrackSound } = await import("$lib/features/whip/crack");
    await primeCrackSound(sound);
    playCrack(sound);
  }

  /**
   * Which build is running, and the one control that changes it.
   *
   * The version used to be a line of grey monospace in the settings footer,
   * present on every tab and belonging to none of them, while the thing you go
   * looking for when you read a version — whether there is a newer one — was a
   * card under General between push notifications and the shortcut editor.
   *
   * Nothing to update in a browser tab: the page is whatever the server last
   * served, so the card is desktop-only and the rest of this tab still answers
   * the question it was opened for.
   */
  const canUpdate = hasTauri();

  const REPO_URL = "https://github.com/beboite/boite";

  /**
   * The boite's own identity, or null when there is no boite in play.
   *
   * `__APP_VERSION__` is a Vite constant describing the bundle this window
   * downloaded, and it sat one row above a line saying the workspace was on
   * another machine. It read as the server's version and it never was: on a
   * phone it names the SPA the server happened to serve, and on a desktop
   * driving a boite it names an install that is not running any of the threads.
   *
   * Both reads below are runes and both are load-bearing. `mode` decides whether
   * a boite is in play, `connection` is what flips when a handshake finishes,
   * and the identity itself is a plain field written before the socket ever says
   * "connected". Re-reading it on that flag is therefore enough, and no effect
   * is needed to chase it.
   */
  const server = $derived.by<ServerIdentity | null>(() => {
    if (!workspace.hasRemote || workspace.connection !== "connected") return null;
    return workspace.remoteBackend?.serverIdentity ?? null;
  });

  /**
   * A machine that answered and is none of the three, against one that never
   * said. Kept apart rather than folded into one word: a server built before
   * `hello` carried any of this is silent, not exotic.
   */
  function osLabel(os: Platform | null): string {
    if (os === "windows") return t("about.osWindows");
    if (os === "macos") return t("about.osMacos");
    if (os === "linux") return t("about.osLinux");
    if (os === "unknown") return t("about.osUnknown");
    return t("about.boiteSilent");
  }

  const boiteVersion = $derived(
    server?.version ? `v${server.version}` : t("about.boiteSilent"),
  );
  const boiteOs = $derived(osLabel(server?.platform ?? null));
  const boiteHost = $derived(server?.host ?? t("about.boiteSilent"));
</script>

<SettingsCard title={t("about.title")} anchor="about.title" description={t("about.description")}>
  <div class="flex items-center gap-3 rounded-lg border border-border bg-[var(--color-surface-2)] px-3 py-2.5">
    <span class="shrink-0 text-muted-foreground/60"><BoiteLogo size={32} /></span>
    <dl class="grid min-w-0 flex-1 grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-xs">
      <!-- Unqualified while this device is the only machine there is. The label
           only has to name a machine once there are two of them to confuse. -->
      <dt class="text-muted-foreground">
        {server ? t("about.versionHere") : t("about.version")}
      </dt>
      <dd class="justify-self-end tabular-nums text-foreground">v{__APP_VERSION__}</dd>

      <dt class="text-muted-foreground">{t("about.platform")}</dt>
      <dd class="justify-self-end text-foreground/90">
        {canUpdate ? t("about.platformDesktop") : t("about.platformBrowser")}
      </dd>

      {#if server}
        <dt class="text-muted-foreground">{t("about.versionBoite")}</dt>
        <dd class="justify-self-end tabular-nums text-foreground">{boiteVersion}</dd>

        <dt class="text-muted-foreground">{t("about.boitePlatform")}</dt>
        <dd class="justify-self-end text-foreground/90">{boiteOs}</dd>

        <dt class="text-muted-foreground">{t("about.boiteHost")}</dt>
        <dd class="min-w-0 justify-self-end truncate text-foreground/90">
          {boiteHost}
        </dd>
      {/if}

      <dt class="text-muted-foreground">{t("about.workspace")}</dt>
      <dd class="min-w-0 justify-self-end truncate text-foreground/90">
        {workspace.isRemote ? t("about.workspaceRemote") : t("about.workspaceLocal")}
      </dd>

      <dt class="text-muted-foreground">{t("about.source")}</dt>
      <dd class="min-w-0 justify-self-end truncate">
        <!-- Through the opener, never an <a href>: in the desktop webview a plain
             link navigates the app window itself, and there is no way back. -->
        <button
          type="button"
          class="truncate text-foreground/90 underline decoration-border underline-offset-2 transition hover:decoration-foreground"
          onclick={() => void openUrl(REPO_URL)}
        >
          beboite/boite
        </button>
      </dd>
    </dl>
  </div>
</SettingsCard>

{#if canUpdate}
  <UpdatesCard />
{/if}

<!-- The logs were their own page in the rail, which spent a permanent line on
     a page opened when something has already gone wrong. They belong beside
     the build number: what version is this, and what did it write. -->
<LogsSection />

<!-- The whip is not an experiment, it is a joke that works, and it sat on the
     Experiments tab making that tab look like nine unfinished features. It
     lands here, at the bottom of the page nobody opens twice, which is where a
     toy belongs. -->
<ToggleSetting
  label={t("experiments.whip")} anchor="experiments.whip"
  description={t("experiments.whipDesc")}
  enabled={settings.state.experimentWhip}
  onToggle={() => settings.setExperimentWhip(!settings.state.experimentWhip)}
/>

{#if settings.state.experimentWhip}
  <div class="flex flex-col gap-1 pl-3">
    <div
      class="flex flex-wrap items-center gap-1.5"
      role="radiogroup"
      aria-label={t("experiments.whipSound")}
    >
      <span class="w-20 shrink-0 text-xs text-muted-foreground">
        {t("experiments.whipSound")}
      </span>
      {#each WHIP_SOUNDS as sound (sound.id)}
        <button
          type="button"
          role="radio"
          aria-checked={whipSoundOn(sound.id)}
          class={whipSoundOn(sound.id) ? RADIO_ON : RADIO}
          onclick={() => {
            settings.setWhipSound(sound.id);
            // The click is the gesture that unlocks audio, so picking a noise
            // is also the only honest way to hear it: a label cannot say what
            // a crack sounds like.
            void playPreview(sound.id);
          }}
        >
          {t(sound.labelKey)}
        </button>
      {/each}
    </div>
    <p class="text-xs text-muted-foreground">{t("experiments.whipSoundDesc")}</p>
  </div>
{/if}
