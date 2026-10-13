<script lang="ts">
  // A conversation that started without part of the user's setup says so
  // wherever it is named: the chat header and the Subagents list. The label is
  // the preset; the tooltip lists what it left out, its tools and its rules.
  import { Feather, Scale, SlidersHorizontal } from '@lucide/svelte';
  import { contextDropped, type ThreadContextMode } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';

  let { mode, compact = false, testid = 'context-mode' }: { mode: ThreadContextMode; compact?: boolean; testid?: string } = $props();

  const Icon = $derived(mode.label === 'light' ? Feather : mode.label === 'neutral' ? Scale : SlidersHorizontal);
  const label = $derived(strings.contextMode[mode.label]);
  const detail = $derived([
    fill(strings.contextMode.heading, { label }),
    ...(contextDropped(mode).length ? [fill(strings.contextMode.without, { parts: contextDropped(mode).map(part => strings.contextMode[part]).join(', ') })] : []),
    ...(mode.tools ? [fill(strings.contextMode.tools, { tools: mode.tools.join(', ') })] : []),
    ...(mode.rules ? [fill(strings.contextMode.withRules, { rules: mode.rules.length > 280 ? `${mode.rules.slice(0, 277)}...` : mode.rules })] : []),
  ].join('\n'));
</script>

<span class="chip context-mode" class:compact data-testid={testid} data-mode={mode.label} title={detail} aria-label={detail}>
  <Icon size={compact ? 11 : 13} strokeWidth={1.75} />
  <span class="label ui-label">{label}{#if mode.rules}<span class="rules">{` + ${strings.contextMode.rules}`}</span>{/if}</span>
</span>

<style>
  .context-mode {
    gap: 4px;
    flex: none;
    border-color: color-mix(in oklch, var(--color-accent) 40%, transparent);
    background: var(--color-accent-soft);
    color: var(--color-accent);
    font-size: var(--text-xs);
    font-weight: 600;
    white-space: nowrap;
  }
  /* In a list row it sits beside the reasoning level and takes its size. */
  .context-mode.compact { height: auto; padding: 2px 6px 2px 5px; gap: 3px; }
  .rules { font-weight: 500; opacity: 0.85; }
  .context-mode :global(svg) { flex: none; }
</style>
