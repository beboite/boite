<script lang="ts">
  import { t } from "$lib/i18n/index.svelte";
  import { openUrl } from "$lib/platform/opener";
  import { motionReduced } from "$lib/theme/motion";
  import tradeOfferVideo from "./assets/trade-offer.webm";
  import noThanksVideo from "./assets/no-thanks.webm";

  const DOC_URL = "https://github.com/beboite/boite/blob/master/docs/analytics.md";
  const REJECT_TOTAL_MS = 2000;

  type Props = {
    onChoose: (modeB: boolean) => void | Promise<void>;
    busy?: boolean;
    headingId?: string;
  };
  let { onChoose, busy = false, headingId = "telemetry-deal-title" }: Props = $props();

  let submitting = $state(false);
  let rejecting = $state(false);
  let dealTitleEl = $state<HTMLHeadingElement | null>(null);
  let gifEl = $state<HTMLVideoElement | null>(null);
  let gifSize = $state<{ w: number; h: number } | null>(null);

  const locked = $derived(busy || submitting || rejecting);

  $effect(() => {
    if (!dealTitleEl) return;
    if (motionReduced()) {
      dealTitleEl.style.color = "var(--color-danger)";
      return () => dealTitleEl?.style.removeProperty("color");
    }
    const anim = dealTitleEl.animate(
      [
        { color: "var(--color-foreground)", textShadow: "0 0 0px rgba(239, 68, 68, 0)" },
        {
          color: "color-mix(in srgb, var(--color-danger) 65%, var(--color-foreground))",
          textShadow: "0 0 6px rgba(239, 68, 68, 0.2)",
          offset: 0.4,
        },
        { color: "var(--color-danger)", textShadow: "0 0 18px rgba(239, 68, 68, 0.6)" },
      ],
      { duration: 10000, easing: "linear", fill: "forwards" },
    );
    return () => anim.cancel();
  });

  async function finish(modeB: boolean) {
    if (submitting) return;
    submitting = true;
    try {
      await onChoose(modeB);
    } finally {
      submitting = false;
    }
  }

  function handleEnough() {
    if (locked) return;
    if (gifEl) {
      const r = gifEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) gifSize = { w: r.width, h: r.height };
    }
    rejecting = true;
    setTimeout(() => {
      void finish(false);
    }, REJECT_TOTAL_MS);
  }

  function handleDeal() {
    void finish(true);
  }
</script>

<div class="deal">
  <h2 id={headingId} class="deal-title" bind:this={dealTitleEl}>
    {t("setup.telemetryTitle")}
  </h2>
  {#key rejecting}
    <video
      class="deal-gif"
      bind:this={gifEl}
      src={rejecting ? noThanksVideo : tradeOfferVideo}
      aria-label={t("setup.telemetryGifAlt")}
      autoplay
      loop
      muted
      playsinline
      disablepictureinpicture
      style={gifSize ? `width:${gifSize.w}px;height:${gifSize.h}px;` : undefined}
    ></video>
  {/key}
  <p class="intro">{t("setup.telemetryIntro")}</p>
  <p class="question">{t("setup.telemetryQuestion")}</p>

  <div class="deal-buttons">
    <button
      type="button"
      class="deal-row no-btn"
      class:no-clicked={rejecting}
      disabled={locked}
      onclick={handleEnough}
    >
      <div class="deal-row-label">
        {t("setup.telemetryBasic")}
        <span class="default-inline">{t("setup.telemetryBasicDefault")}</span>
      </div>
      <div class="deal-row-body">{t("setup.telemetryBasicHint")}</div>
    </button>
    <button
      type="button"
      class="deal-row deal-accent"
      disabled={locked}
      onclick={handleDeal}
    >
      <div class="deal-row-label">{t("setup.telemetryDeal")}</div>
      <div class="deal-row-body">{t("setup.telemetryDealHint")}</div>
    </button>
  </div>

  <p class="opt-out-note">{t("setup.telemetryOptOutNote")}</p>

  <button
    type="button"
    class="learn-more"
    disabled={locked}
    onclick={() => void openUrl(DOC_URL)}
  >
    {t("setup.telemetryDoc")}
  </button>
</div>

<style>
  .deal {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }

  .deal-title {
    text-align: center;
    font-size: clamp(var(--text-lg), min(5vw, 3.4vh), var(--text-xl));
    font-weight: 900;
    letter-spacing: 0.08em;
    color: var(--color-foreground);
    margin: 0;
  }

  .deal-gif {
    max-width: 100%;
    max-height: 32vh;
    width: auto;
    height: auto;
    flex: 0 1 auto;
    min-height: 0;
    object-fit: contain;
    display: block;
    margin: 0 auto;
    border-radius: 10px;
    animation: gifSwap 240ms ease-out;
  }

  .intro {
    margin: 0 auto;
    max-width: 46ch;
    font-size: var(--text-sm);
    line-height: 1.6;
    color: var(--color-muted-foreground);
    text-align: center;
  }
  .question {
    margin: 2px 0 0;
    font-size: clamp(var(--text-md), min(4vw, 2.6vh), var(--text-lg));
    font-weight: 800;
    text-align: center;
    letter-spacing: 0.01em;
    color: var(--color-foreground);
  }

  .deal-buttons {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .deal-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    padding: 11px 16px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: color-mix(in srgb, var(--color-surface-2) 88%, var(--color-foreground) 12%);
    color: var(--color-foreground);
    text-align: left;
    cursor: pointer;
    transition:
      transform 120ms ease-out,
      border-color 160ms ease-out,
      background 160ms ease-out,
      color 160ms ease-out,
      box-shadow 160ms ease-out;
  }
  .deal-row:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--color-foreground) 45%, var(--color-border));
    background: color-mix(in srgb, var(--color-surface-2) 80%, var(--color-foreground) 20%);
  }
  .deal-row:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .deal-row-label {
    font-size: var(--text-base);
    font-weight: 700;
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }
  .default-inline {
    font-size: var(--text-xs);
    font-weight: 500;
    color: color-mix(in srgb, var(--color-muted-foreground) 80%, transparent);
  }
  .deal-row-body {
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--color-muted-foreground);
  }

  .opt-out-note {
    margin: 0;
    font-size: var(--text-xs);
    line-height: 1.5;
    color: color-mix(in srgb, var(--color-muted-foreground) 85%, transparent);
    text-align: center;
  }

  .no-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-danger) 14%, var(--color-surface-2));
    border-color: color-mix(in srgb, var(--color-danger) 55%, var(--color-border));
    color: var(--color-danger);
  }
  .no-btn:hover:not(:disabled) .deal-row-body {
    color: var(--color-danger);
  }
  .no-btn.no-clicked,
  .no-btn.no-clicked:disabled {
    background: var(--color-danger) !important;
    border-color: var(--color-danger) !important;
    color: #ffffff !important;
    opacity: 1 !important;
    box-shadow: 0 10px 28px color-mix(in srgb, var(--color-danger) 35%, transparent);
  }
  .no-btn.no-clicked .deal-row-body {
    color: #ffffff !important;
  }

  .deal-row.deal-accent {
    border-color: color-mix(in srgb, var(--color-foreground) 65%, transparent);
    background: color-mix(in srgb, var(--color-surface-2) 86%, var(--color-foreground) 14%);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--color-foreground) 18%, transparent),
      0 6px 22px color-mix(in srgb, var(--color-foreground) 8%, transparent);
  }
  .deal-row.deal-accent .deal-row-label {
    color: var(--color-foreground);
    letter-spacing: 0.04em;
  }
  .deal-row.deal-accent:hover:not(:disabled) {
    transform: translateY(-2px);
    border-color: var(--color-foreground);
    background: color-mix(in srgb, var(--color-surface-2) 78%, var(--color-foreground) 22%);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--color-foreground) 45%, transparent),
      0 14px 32px color-mix(in srgb, var(--color-foreground) 16%, transparent);
  }

  .learn-more {
    border: none;
    background: transparent;
    color: var(--color-muted-foreground);
    padding: 0;
    font-size: var(--text-sm);
    text-decoration: underline;
    cursor: pointer;
    align-self: center;
    transition: color 120ms ease-out;
  }
  .learn-more:hover:not(:disabled) {
    color: var(--color-foreground);
  }
  .learn-more:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @keyframes gifSwap {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  @media (max-height: 640px) {
    .intro {
      display: none;
    }
    .deal-row {
      padding: 8px 14px;
    }
  }
  @media (max-height: 520px) {
    .deal-gif {
      display: none;
    }
  }

  :global(html[data-motion="reduced"]) .deal-gif {
    animation: none;
  }
  :global(html[data-motion="reduced"]) .deal-row:hover:not(:disabled) {
    transform: none;
  }
</style>
