<script lang="ts">
  import { strings } from '../lib/strings';
  import type { Page, Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  const pages: { id: Page; label: string }[] = [
    { id: 'threads', label: strings.nav.threads },
    { id: 'resources', label: strings.nav.resources },
    { id: 'accounts', label: strings.nav.accounts },
    { id: 'usage', label: strings.nav.usage },
    { id: 'settings', label: strings.nav.settings }
  ];

  async function go(page: Page) {
    store.page = page;
    if (page === 'resources') await store.refreshResources();
    if (page === 'usage') await store.refreshUsage();
  }
</script>

<header>
  <span class="wordmark">{strings.app.name}</span>
  <nav>
    {#each pages as page (page.id)}
      <button
        class="quiet"
        class:active={store.page === page.id}
        aria-current={store.page === page.id ? 'page' : undefined}
        onclick={() => void go(page.id)}
      >
        {page.label}
        {#if page.id === 'threads' && store.unreadCount > 0}
          <span class="badge">{store.unreadCount}</span>
        {/if}
      </button>
    {/each}
  </nav>
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 34px;
    padding: 0 10px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }

  .wordmark {
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  nav {
    display: flex;
    gap: 2px;
  }

  button {
    padding: 2px 8px;
  }

  .active {
    background: var(--accent-soft);
    color: var(--text);
  }

  .badge {
    display: inline-block;
    min-width: 15px;
    padding: 0 3px;
    margin-left: 4px;
    border-radius: 7px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 10px;
    text-align: center;
  }
</style>
