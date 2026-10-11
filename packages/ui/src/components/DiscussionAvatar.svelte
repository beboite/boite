<script lang="ts">
  import { UserCog } from '@lucide/svelte';
  import type { ThreadStatus } from '@boite/contracts';
  import ProviderLogo from './ProviderLogo.svelte';
  import StatusMark from './StatusMark.svelte';

  /**
   * The other end of a discussion: its provider's mark, or the steward's, with
   * its live state in the corner once it works or failed. An idle agent has no
   * dot: most discussions are with agents that finished.
   */
  let { title, providerId, status, steward = false, size = 30 }: {
    title: string; providerId?: string; status?: ThreadStatus; steward?: boolean; size?: number;
  } = $props();
  let initial = $derived((title.trim()[0] ?? '?').toUpperCase());
</script>

<span class="avatar" class:steward style:--size="{size}px" aria-hidden="true">
  {#if steward}<UserCog size={Math.round(size * 0.55)} strokeWidth={1.75} />
  {:else if providerId}<ProviderLogo {providerId} size={Math.round(size * 0.55)} />
  {:else}<span class="initial">{initial}</span>{/if}
  {#if status && status !== 'idle'}<span class="dot"><StatusMark {status} /></span>{/if}
</span>

<style>
  .avatar { position: relative; flex: none; width: var(--size); height: var(--size); display: grid; place-items: center; border-radius: var(--radius-md); border: 1px solid var(--color-border); background: var(--color-surface-3); color: var(--color-muted-foreground); }
  .avatar.steward { border-color: color-mix(in oklch, var(--color-steward) 45%, transparent); background: var(--color-steward-soft); color: var(--color-steward); }
  .initial { font-size: calc(var(--size) * 0.42); font-weight: 600; line-height: 1; color: var(--color-foreground); }
  .dot { position: absolute; right: -3px; bottom: -3px; display: grid; place-items: center; padding: 2px; border-radius: 50%; background: var(--color-background); }
</style>
