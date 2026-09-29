<script lang="ts">
  import type { TelemetryState } from '@boite/contracts';
  import tradeOffer from '../assets/onboarding/trade-offer.webm';
  import noThanks from '../assets/onboarding/no-thanks.webm';
  import { openExternal } from '../lib/links';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * Boite Legacy's consent screen: the trade offer meme, one row per tier, and
   * picking a row ends the tour. "Enough" keeps the anonymous counters, so the
   * note under both rows carries the full opt-out, one click like the rows.
   */
  let { store, onchosen }: { store: Store; onchosen: () => void } = $props();

  const DOC_URL = 'https://github.com/beboite/boite/blob/main/docs/analytics.md';
  /** How long the refusal clip plays before the tour closes. */
  const REFUSAL_MS = 2000;
  const reduced = document.documentElement.dataset.motion === 'reduced' || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

  let consent = $state<TelemetryState | null>(null);
  /** The client `consent` came from: a reconnect swaps it without re-running the read. */
  let consentFrom: Store['client'] = null;
  let busy = $state(false);
  let refusing = $state(false);
  let error = $state('');
  let clip = $state<HTMLVideoElement>();
  let clipSize = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(timer));

  $effect(() => {
    const client = store.client;
    // Another machine's saved mode says nothing about this one.
    consent = null;
    if (!client || !store.owner) return;
    let active = true;
    void store.telemetryState().then(value => { if (active) { consent = value; consentFrom = client; } })
      .catch(reason => { if (active) error = String(reason); });
    return () => { active = false; };
  });

  async function choose(mode: TelemetryState['mode']): Promise<boolean> {
    const client = store.client;
    if (!client) return false;
    busy = true; error = '';
    try { consent = await store.configureTelemetry(mode); consentFrom = client; return store.client === client; }
    catch (reason) { if (store.client === client) error = String(reason); return false; }
    finally { busy = false; }
  }

  /** The saved mode of the client connected now, read again when it changed since. */
  async function savedMode(): Promise<TelemetryState['mode'] | null> {
    const client = store.client;
    if (!client) return null;
    if (consent && consentFrom === client) return consent.mode;
    busy = true; error = '';
    try {
      const value = await store.telemetryState();
      if (store.client !== client) return null;
      consent = value; consentFrom = client;
      return value.mode;
    } catch (reason) { if (store.client === client) error = String(reason); return null; }
    finally { busy = false; }
  }

  async function enough() {
    // Until the saved mode is known, "enough" could write basic over an opt-out.
    if (busy || refusing || !consent) return;
    const saved = await savedMode();
    if (!saved) return;
    // A replay never turns counters back on after a saved opt-out.
    if (!await choose(saved === 'off' ? 'off' : 'basic')) return;
    if (reduced) { onchosen(); return; }
    // The clip swaps at the size the first one had, so the rows do not jump.
    const box = clip?.getBoundingClientRect();
    if (box && box.width > 0) clipSize = `width:${box.width}px;height:${box.height}px`;
    refusing = true;
    timer = setTimeout(onchosen, REFUSAL_MS);
  }

  async function deal() {
    if (busy || refusing) return;
    if (await choose('enhanced')) onchosen();
  }

  async function off() {
    if (busy || refusing) return;
    if (await choose('off')) onchosen();
  }
</script>

<div class="deal" data-testid="telemetry-deal">
  {#key refusing}
    <video class="clip" bind:this={clip} src={refusing ? noThanks : tradeOffer} aria-label={strings.onboarding.privacy.video}
      autoplay={!reduced} loop muted playsinline disablepictureinpicture preload="auto" style={clipSize || undefined}></video>
  {/key}
  <p class="intro">{strings.onboarding.privacy.intro}</p>
  <p class="question">{strings.onboarding.privacy.question}</p>
  <div class="rows">
    <button class="row no" class:refused={refusing} disabled={busy || refusing || !consent} data-testid="onboarding-telemetry-basic" onclick={() => void enough()}>
      <span class="label">{strings.onboarding.privacy.basic}<small>{strings.onboarding.privacy.basicDefault}</small></span>
      <span class="hint">{strings.onboarding.privacy.basicHint}</span>
    </button>
    <button class="row yes" disabled={busy || refusing} data-testid="onboarding-telemetry-enhanced" onclick={() => void deal()}>
      <span class="label">{strings.onboarding.privacy.deal}</span>
      <span class="hint">{strings.onboarding.privacy.dealHint}</span>
    </button>
  </div>
  <p class="note">{strings.onboarding.privacy.optOut}
    <button class="link" disabled={busy || refusing} data-testid="onboarding-telemetry-off" onclick={() => void off()}>{strings.onboarding.privacy.offLabel}</button></p>
  <button class="link" disabled={refusing} onclick={() => void openExternal(DOC_URL)}>{strings.onboarding.privacy.doc}</button>
  {#if error}<p role="alert">{error}</p>{/if}
</div>

<style>
  .deal { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
  p { margin: 0; }
  .clip { display: block; max-width: 100%; max-height: min(26vh, 200px); margin: 0 auto; border-radius: var(--radius-lg); animation: swap var(--dur-3) var(--ease-out-quint); }
  .intro { max-width: 52ch; margin: 0 auto; color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.6; text-align: center; }
  .question { margin: 2px 0 0; font-size: var(--text-lg); font-weight: 800; text-align: center; }
  .rows { display: grid; gap: 8px; }
  .row { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; height: auto; padding: 11px 16px; white-space: normal; text-align: left; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--color-surface-2) 88%, var(--color-foreground) 12%); color: var(--color-foreground); cursor: pointer; transition: transform var(--dur-1) ease-out, border-color var(--dur-2) ease-out, background var(--dur-2) ease-out, color var(--dur-2) ease-out, box-shadow var(--dur-2) ease-out; }
  .row:hover:not(:disabled) { transform: translateY(-1px); border-color: color-mix(in srgb, var(--color-foreground) 45%, var(--color-border)); }
  .row:disabled { opacity: .5; cursor: not-allowed; }
  .label { display: inline-flex; align-items: baseline; flex-wrap: wrap; gap: 6px; font-size: var(--text-base); font-weight: 700; }
  .label small { font-size: var(--text-xs); font-weight: 500; color: var(--color-muted-foreground); }
  .hint { font-size: var(--text-sm); line-height: 1.5; color: var(--color-muted-foreground); }
  .no:hover:not(:disabled), .no:hover:not(:disabled) .hint { color: var(--color-danger); }
  .no:hover:not(:disabled) { background: color-mix(in srgb, var(--color-danger) 14%, var(--color-surface-2)); border-color: color-mix(in srgb, var(--color-danger) 55%, var(--color-border)); }
  .no.refused, .no.refused:disabled { opacity: 1; color: var(--color-on-danger); background: var(--color-danger); border-color: var(--color-danger); box-shadow: 0 10px 28px color-mix(in srgb, var(--color-danger) 35%, transparent); }
  .no.refused .hint, .no.refused small { color: inherit; }
  .yes { border-color: color-mix(in srgb, var(--color-foreground) 65%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-foreground) 18%, transparent), 0 6px 22px color-mix(in srgb, var(--color-foreground) 8%, transparent); }
  .yes .label { letter-spacing: .04em; }
  .yes:hover:not(:disabled) { transform: translateY(-2px); border-color: var(--color-foreground); box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-foreground) 45%, transparent), 0 14px 32px color-mix(in srgb, var(--color-foreground) 16%, transparent); }
  .note { color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; text-align: center; }
  .link { align-self: center; height: auto; padding: 0; border: 0; background: transparent; color: var(--color-muted-foreground); font-size: var(--text-sm); text-decoration: underline; cursor: pointer; }
  .link:hover:not(:disabled) { color: var(--color-foreground); }
  [role=alert] { color: var(--color-danger); overflow-wrap: anywhere; }
  @keyframes swap { from { opacity: 0; transform: scale(.96); } }
  /* A short window shrinks the clip, never the line that says what is counted. */
  @media (max-height: 640px) { .clip { max-height: 16vh; } .row { padding: 8px 14px; } }
  @media (max-height: 520px) { .clip { display: none; } }
  /* A finger needs the full touch target, the opt-out included, not the 20 px line of text it sits on. */
  @media (max-width: 720px) { .link { display: inline-flex; align-items: center; justify-content: center; min-height: var(--touch-target); padding: 0 8px; vertical-align: middle; } }
  @media (prefers-reduced-motion: reduce) { .clip { animation: none; } .row:hover:not(:disabled) { transform: none; } }
  :global(html[data-motion="reduced"]) .clip { animation: none; }
</style>
