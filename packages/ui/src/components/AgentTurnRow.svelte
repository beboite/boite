<script lang="ts">
  import type { Turn } from '@boite/contracts';
  import type { AgentRow } from '../lib/agent-turns';
  import type { Store } from '../lib/store.svelte';
  import MemoryPassLine from './MemoryPassLine.svelte';
  import TurnFoldRow from './TurnFoldRow.svelte';

  /** A row a persistent agent's thread adds to its timeline (`AgentTimeline`): a folded turn, or its memory pass's line. */
  let { store, row, turn, at }: { store: Store; row: AgentRow; turn: Turn | undefined; at: number } = $props();
  const operation = $derived(turn?.execution?.operation);
</script>

{#if row.kind === 'memory'}
  <MemoryPassLine pass={row.pass} onopen={() => store.panel.open('desk')} />
{:else}
  <TurnFoldRow fold={row.fold} {at} wake={operation === 'routine' || operation === 'event' ? operation : undefined} />
{/if}
