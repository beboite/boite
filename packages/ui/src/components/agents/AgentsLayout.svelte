<script module lang="ts">
  type Page = typeof import('./AgentsPage.svelte').default;
  /** Kept past this layout's unmount, so coming back to Agents draws the page in its first frame. */
  let loaded: Page | undefined;
</script>

<script lang="ts">
  import type { Closing } from '../../lib/closing.svelte';
  import type { Store } from '../../lib/store.svelte';
  import { strings } from '../../lib/strings';
  import type RightPanelView from '../RightPanel.svelte';

  /**
   * The Agents page in the app's body: the chat's layout with the agents list
   * for its column. An agent's conversation is its thread, and the panel
   * beside it that thread's, drawn once the app has its chunk. The page itself
   * loads the first time it is shown.
   */
  let { store, panel, showPanel, RightPanel }: {
    store: Store;
    panel: Closing;
    /** The panel slot is open and the open thread is an agent's. */
    showPanel: boolean;
    RightPanel: typeof RightPanelView | undefined;
  } = $props();

  let AgentsPage = $state<Page | undefined>(loaded);
  let loadError = $state('');
  $effect(() => {
    if (AgentsPage) return;
    void import('./AgentsPage.svelte').then(module => { loaded = module.default; AgentsPage = loaded; })
      .catch(() => { loadError = strings.agents.offline; });
  });
</script>

{#if AgentsPage}{#key store}<AgentsPage {store} />{/key}{:else}<p class="empty">{loadError || strings.app.loading}</p>{/if}
{#if showPanel && RightPanel}
  {#key store}
    <RightPanel {store} panel={store.panel} closing={panel.closing} attach={panel.attach} onexit={panel.end} />
  {/key}
{/if}
