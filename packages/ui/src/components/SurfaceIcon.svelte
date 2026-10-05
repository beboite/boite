<script lang="ts">
  import { Activity, AppWindow, FileText, FolderTree, GitCompare, Globe, ListChecks, MessageSquare, Smartphone, UsersRound } from '@lucide/svelte';
  import type { SurfaceKind } from '../lib/right-panel.svelte';

  /** The icon of a kind of surface, on its tab and on its launcher card. */
  let { kind, size }: { kind: SurfaceKind; size: number } = $props();
</script>

{#if kind === 'trace'}
  <Activity {size} strokeWidth={1.75} />
{:else if kind === 'agents'}
  <UsersRound {size} strokeWidth={1.75} />
{:else if kind === 'messages'}
  <MessageSquare {size} strokeWidth={1.75} />
{:else if kind === 'changes'}
  <GitCompare {size} strokeWidth={1.75} />
{:else if kind === 'files'}
  <FolderTree {size} strokeWidth={1.75} />
{:else if kind === 'file'}
  <FileText {size} strokeWidth={1.75} />
{:else if kind === 'agent-browser'}
  <AppWindow {size} strokeWidth={1.75} />
{:else if kind === 'device'}
  <Smartphone {size} strokeWidth={1.75} />
{:else if kind === 'tasks'}
  <ListChecks {size} strokeWidth={1.75} />
{:else}
  <Globe {size} strokeWidth={1.75} />
{/if}
