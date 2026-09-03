<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import { backend } from "$lib/backend";
  import { SETUP_STEPS, type SetupDraft } from "./steps";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import { restoreFocus } from "$lib/shared/keyboard/overlay";
  import { t, LOCALE_OPTIONS } from "$lib/i18n/index.svelte";
  import { reportSettingsSnapshot } from "./telemetry";

  // 0 is the welcome screen, 1..n index SETUP_STEPS.
  let step = $state(0);

  const draft = $state<SetupDraft>({ shortcuts: [], modeB: false });

  let dialogEl = $state<HTMLDivElement | null>(null);
  let nextBtn = $state<HTMLButtonElement | null>(null);

  // Same shape as ConfirmDialog. The wizard is the whole screen on a first run,
  // and it used to open with the keyboard on nothing: Tab started from the top of
  // the document instead of inside the dialog.
  $effect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const surface = dialogEl;
    (nextBtn ?? dialogEl)?.focus();
    return () => restoreFocus(previous, surface);
  });

  const total = SETUP_STEPS.length;
  const current = $derived(step > 0 ? (SETUP_STEPS[step - 1] ?? null) : null);
  const isLast = $derived(step >= total);

  function next() {
    if (isLast) {
      void finish();
      return;
    }
    step += 1;
  }

  async function finish() {
    await completeOnboarding(draft.modeB);
    return settings.completeSetup(draft.shortcuts.map((shortcut) => ({ ...shortcut })));
  }

  async function finishWith(modeB: boolean) {
    draft.modeB = modeB;
    await finish();
  }

  async function skipWizard() {
    await completeOnboarding(false);
    await settings.setSetupCompleted(true);
  }

  async function completeOnboarding(modeB: boolean) {
    try {
      await backend().telemetry.completeOnboarding(true, modeB);
      void reportSettingsSnapshot();
    } catch {
      // No runtime: the sidecar never existed, and nothing will be sent.
    }
  }
</script>

<div
  class="flex min-h-0 flex-1 items-center justify-center scroll-pane overflow-y-auto bg-[var(--color-background)] p-4"
>
  <!-- The welcome screen owns the visible title; the steps after it carry their
       own heading, so the dialog names itself there instead of pointing at an id
       that is no longer in the document. -->
  <div
    bind:this={dialogEl}
    class="surface-dialog modal flex w-[min(94vw,540px)] flex-col gap-4 p-6 outline-none {current?.id ===
    'telemetry'
      ? 'deal-mode'
      : ''}"
    role="dialog"
    aria-modal="true"
    aria-labelledby={step === 0 ? "setup-title" : undefined}
    aria-label={step === 0 ? undefined : t("setup.title")}
    tabindex="-1"
  >
    <div class="flex justify-center gap-1.5" aria-hidden="true">
      {#each Array(total + 1) as _, i (i)}
        <span
          class="size-1.5 rounded-full transition {i === step
            ? 'scale-125 bg-foreground'
            : 'bg-muted-foreground/30'}"
        ></span>
      {/each}
    </div>

    {#key step}
      <div class="step flex flex-col gap-4">
        {#if current === null}
          <div class="flex flex-col items-center gap-3 text-center">
            <BoiteLogo size={56} />
            <h2 id="setup-title" class="text-lg font-bold text-foreground">
              {t("setup.title")}
              <span class="ml-1 align-baseline text-xs font-medium text-muted-foreground">
                v{__APP_VERSION__}
              </span>
            </h2>
            <p class="max-w-sm text-xs leading-relaxed text-muted-foreground">{t("setup.desc")}</p>
          </div>

          <div class="flex items-center justify-center gap-2">
            <span class="text-xs text-muted-foreground">{t("setup.language")}</span>
            <div class="flex gap-1.5">
              {#each LOCALE_OPTIONS as lang (lang.id)}
                <button
                  type="button"
                  class="rounded-md border px-2.5 py-1 text-xs transition {settings.state
                    .locale === lang.id
                    ? 'border-foreground/40 bg-[var(--color-surface-3)] text-foreground'
                    : 'border-edge bg-[var(--color-surface-2)] text-muted-foreground hover:border-foreground/30 hover:text-foreground'}"
                  onclick={() => settings.setLocale(lang.id)}
                >
                  {t(lang.labelKey)}
                </button>
              {/each}
            </div>
          </div>
        {:else}
          {@const Step = current.component}
          <Step
            {draft}
            onTelemetryChosen={current.id === "telemetry"
              ? (modeB) => void finishWith(modeB)
              : undefined}
          />
        {/if}
      </div>
    {/key}

    {#if current?.id !== "telemetry"}
    <div class="flex items-center justify-between gap-3">
      {#if step === 0}
        <button
          type="button"
          onclick={() => void skipWizard()}
          class="rounded-lg border border-border px-3.5 py-2 text-xs font-medium text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
        >
          {t("setup.skip")}
        </button>
      {:else}
        <button
          type="button"
          onclick={() => (step -= 1)}
          class="rounded-lg border border-border px-3.5 py-2 text-xs font-medium text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
        >
          {t("setup.back")}
        </button>
      {/if}
      <button
        bind:this={nextBtn}
        type="button"
        onclick={next}
        class="rounded-lg bg-foreground px-5 py-2.5 text-xs font-bold text-background transition hover:bg-foreground/90"
      >
        {isLast ? t("setup.finish") : t("setup.continue")}
      </button>
    </div>
    {/if}
  </div>
</div>

<style>
  .modal {
    animation: modalIn 260ms var(--ease-out-quint);
  }
  .step {
    animation: stepIn 200ms ease-out;
  }
  .deal-mode {
    overflow: hidden;
    gap: 12px;
    padding: 18px 22px 16px;
    max-height: min(92vh, 660px);
  }
  .deal-mode .step {
    min-height: 0;
    gap: 10px;
  }
  @media (max-height: 640px) {
    .deal-mode {
      gap: 8px;
      padding: 14px 18px 12px;
    }
    .deal-mode .step {
      gap: 8px;
    }
  }
  @media (max-height: 520px) {
    .deal-mode {
      overflow-y: auto;
    }
  }
  @keyframes modalIn {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(8px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }
  @keyframes stepIn {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
