<script lang="ts">
  import { Brain } from '@lucide/svelte';
  import type { MemoryPass } from '../lib/agent-turns';
  import { exactTime } from '../lib/format';
  import { strings } from '../lib/strings';

  /**
   * One small line under the answer a persistent agent's memory pass
   * followed: it is updating its memory, updated it (and what changed), found
   * nothing to change, or failed. A click shows its memory on the desk.
   */
  let { pass, onopen }: { pass: MemoryPass; onopen?: () => void } = $props();
  const t = $derived(strings.chat.fold);
</script>

<button type="button" class="ghost small memory-pass" data-status={pass.status} title={onopen ? t.memoryOpen : exactTime(pass.at)} disabled={!onopen} onclick={onopen} data-testid="memory-pass">
  <span class="glyph" aria-hidden="true"><Brain size={13} strokeWidth={1.75} /></span>
  <span class="ui-label">{t.memory[pass.status]}</span>
  {#if pass.summary && pass.status !== 'running'}<span class="summary">· {pass.summary}</span>{/if}
</button>

<style>
  .memory-pass {
    align-self: flex-start;
    max-width: 100%;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: auto;
    min-height: var(--control-sm);
    padding: 2px 8px;
    margin-top: -4px;
    border-radius: var(--radius-full);
    color: var(--color-subtle);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .memory-pass:disabled { opacity: 1; cursor: default; }
  .memory-pass:hover:not(:disabled), .memory-pass:focus-visible { color: var(--color-foreground); }
  .glyph { flex: none; display: inline-flex; color: var(--color-accent); }
  .memory-pass > .ui-label { flex: none; }
  .memory-pass[data-status='running'] .glyph { animation: pulse 1.6s var(--ease-out-quint) infinite var(--loops); }
  .memory-pass[data-status='error'] .glyph { color: var(--color-danger); }
  .memory-pass[data-status='unchanged'] .glyph { color: var(--color-subtle); }
  .summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); }
  @media (prefers-reduced-motion: reduce) { .memory-pass[data-status='running'] .glyph { animation: none; } }
  :global(html[data-motion='reduced']) .memory-pass[data-status='running'] .glyph { animation: none; }
</style>
