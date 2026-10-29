<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { strings } from '../lib/strings';
  import type GoalChecklist from './GoalChecklist.svelte';

  /**
   * Only a `/goal2` has a checklist: the list loads the first time one is
   * opened, outside the entry chunk. A chunk that
   * fails to load (an update, a phone offline) offers another try.
   */
  let props: ComponentProps<typeof GoalChecklist> = $props();
  let loading = $state.raw(import('./GoalChecklist.svelte'));
</script>

{#await loading then module}
  <module.default {...props} />
{:catch}
  <div class="notice" role="status" data-testid="goal-checklist-failed">
    <span>{strings.activity.checklistLoadFailed}</span>
    <button class="quiet" onclick={() => (loading = import('./GoalChecklist.svelte'))}><span class="ui-label">{strings.common.refresh}</span></button>
  </div>
{/await}

<style>
  .notice { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
</style>
