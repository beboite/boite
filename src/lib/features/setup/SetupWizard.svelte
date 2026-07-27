<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import { SETUP_STEPS, type SetupDraft } from "./steps";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import { t, LOCALE_OPTIONS } from "$lib/i18n/index.svelte";

  // 0 is the welcome screen, 1..n index SETUP_STEPS.
  let step = $state(0);

  const draft = $state<SetupDraft>({ shortcuts: [] });

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

  function finish() {
    return settings.completeSetup(draft.shortcuts.map((shortcut) => ({ ...shortcut })));
  }
</script>

<div
  class="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-[var(--color-background)] p-4"
>
  <div
    class="modal flex w-[min(94vw,520px)] flex-col gap-4 rounded-2xl border border-border/70 bg-[var(--color-surface)] p-6 shadow-2xl"
    role="dialog"
    aria-modal="true"
    aria-labelledby="setup-title"
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
            <span class="text-[11px] text-muted-foreground">{t("setup.language")}</span>
            <div class="flex gap-1.5">
              {#each LOCALE_OPTIONS as lang (lang.id)}
                <button
                  type="button"
                  class="rounded-md border px-2.5 py-1 text-[11px] transition {settings.state
                    .locale === lang.id
                    ? 'border-foreground/40 bg-[var(--color-surface-3)] text-foreground'
                    : 'border-border bg-[var(--color-surface-2)] text-muted-foreground hover:border-foreground/30 hover:text-foreground'}"
                  onclick={() => settings.setLocale(lang.id)}
                >
                  {t(lang.labelKey)}
                </button>
              {/each}
            </div>
          </div>
        {:else}
          {@const Step = current.component}
          <Step {draft} />
        {/if}
      </div>
    {/key}

    <div class="flex items-center justify-between gap-3">
      {#if step === 0}
        <button
          type="button"
          onclick={() => void settings.setSetupCompleted(true)}
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
        type="button"
        onclick={next}
        class="rounded-lg bg-foreground px-5 py-2.5 text-xs font-bold text-background transition hover:bg-foreground/90"
      >
        {isLast ? t("setup.finish") : t("setup.continue")}
      </button>
    </div>
  </div>
</div>

<style>
  .modal {
    animation: modalIn 260ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .step {
    animation: stepIn 200ms ease-out;
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
