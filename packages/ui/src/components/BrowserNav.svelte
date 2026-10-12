<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ArrowLeft, ArrowRight, Globe, Lock, RotateCw } from '@lucide/svelte';
  import { strings } from '../lib/strings';

  /**
   * A browser view's toolbar: back, forward and reload, then the address field
   * behind the site's lock or globe, and the bar sliding under it while a page
   * loads. The view keeps the field itself (`field`), what follows it in the
   * omnibox (`status`) and its own buttons after it (`actions`). The loading
   * bar sits 39px down the nearest positioned parent, on the toolbar's edge.
   */
  let { addressId, secure, loading, spinning = loading, disabled = false, onsubmit, onback, onforward, onreload, field, status, actions }: {
    addressId: string;
    secure: boolean;
    loading: boolean;
    /** The reload icon turns while a page loads, even one the bar does not show. */
    spinning?: boolean;
    disabled?: boolean;
    onsubmit: (event: SubmitEvent) => void;
    onback: () => void;
    onforward: () => void;
    onreload: () => void;
    field: Snippet;
    status?: Snippet;
    actions?: Snippet;
  } = $props();
</script>

<form class="nav" data-testid="remote-browser-nav" {onsubmit}>
  <button type="button" class="ghost small icon" {disabled} title={strings.remoteBrowser.back} aria-label={strings.remoteBrowser.back} onclick={onback}><ArrowLeft size={15} strokeWidth={1.75} /></button>
  <button type="button" class="ghost small icon" {disabled} title={strings.remoteBrowser.forward} aria-label={strings.remoteBrowser.forward} onclick={onforward}><ArrowRight size={15} strokeWidth={1.75} /></button>
  <button type="button" class="ghost small icon" {disabled} title={strings.remoteBrowser.reload} aria-label={strings.remoteBrowser.reload} onclick={onreload}><RotateCw size={14} strokeWidth={1.75} class={spinning ? 'spin' : ''} /></button>
  <div class="omnibox" class:secure>
    <!-- The icon is the field's label: a click beside the text still lands in it. -->
    <label class="site" for={addressId}><span aria-hidden="true">{#if secure}<Lock size={12} strokeWidth={2} />{:else}<Globe size={12} strokeWidth={2} />{/if}</span></label>
    {@render field()}
    {@render status?.()}
  </div>
  {@render actions?.()}
</form>
{#if loading}<span class="loading" aria-hidden="true"></span>{/if}

<style>
  .nav { display: flex; align-items: center; gap: 2px; height: 40px; padding: 0 6px; margin: 0; flex: none; border-bottom: 1px solid var(--color-border); background: var(--color-surface); }
  .nav > :global(button) { flex: none; }
  .omnibox { flex: 1; min-width: 0; display: flex; align-items: center; height: var(--control-sm); margin: 0 4px; padding: 0 10px 0 0; border: 1px solid transparent; border-radius: var(--radius-full); background: var(--color-surface-2); color: var(--color-muted-foreground); cursor: text; transition: border-color var(--dur-2) var(--ease-out-quint); }
  .omnibox:hover { border-color: var(--color-border); }
  .omnibox:focus-within { border-color: color-mix(in srgb, var(--color-accent) 60%, var(--color-edge)); box-shadow: 0 0 0 3px var(--color-accent-soft); }
  .omnibox > :global(input) { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; color: var(--color-foreground); font-size: var(--text-sm); text-overflow: ellipsis; outline: none; }
  .site { display: flex; align-items: center; flex: none; align-self: stretch; padding: 0 6px 0 10px; line-height: 0; cursor: text; }
  .omnibox.secure .site { color: var(--color-foreground); opacity: .7; }
  .nav :global(.spin) { animation: spin 1s linear infinite; }
  .loading { position: absolute; top: 39px; left: 0; height: 2px; width: 40%; z-index: 2; background: var(--color-accent); animation: loading-slide 1.1s var(--ease-out-quint) infinite; }
  @media (prefers-reduced-motion: reduce) { .nav :global(.spin), .loading { animation: none; } }
  /* A finger gets a taller bar, and a field large enough that the phone does not zoom on it. */
  @media (max-width: 720px), (pointer: coarse) { .omnibox > :global(input) { font-size: var(--text-md); } }
  @media (max-width: 720px) { .nav { height: auto; min-height: 48px; padding-block: 2px; } .loading { top: auto; } }
</style>
