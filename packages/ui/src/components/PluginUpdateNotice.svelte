<script lang="ts">
  import { Puzzle } from '@lucide/svelte';
  import type { PluginState } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { workspace } from '../lib/workspace.svelte';
  import { answerPluginUpdate, pluginUpdateOffer, readPluginUpdateAnswers } from '../lib/plugin-update-notice';

  interface Host { id: string; label: string; store: Store }
  interface Notice { key: string; host: Host; plugin: PluginState; version: string }

  /** Tests hand their machines; the app shows the workspace's. */
  let { machines }: { machines?: Host[] } = $props();
  const t = strings.plugins;
  /** More than this at once would bury the thread; the Plugins page lists every update. */
  const MOST = 2;

  let hosts = $derived(machines ?? workspace.machines);
  let lists = $state<Record<string, PluginState[]>>({});
  let answers = $state(readPluginUpdateAnswers());

  /** Only the owner installs plugins: a paired device neither asks for the list nor sees a notice. */
  const owns = (store: Store) => store.connection === 'ready' && store.owner && store.client !== null;

  $effect(() => {
    const offs: (() => void)[] = [];
    for (const host of hosts) {
      const store = host.store;
      // A new connection is a new client: listen again and read the list it now holds.
      void store.clientGeneration;
      if (!owns(store)) continue;
      const client = store.client!;
      const id = host.id;
      offs.push(client.on('plugins.updated', (plugin) => {
        lists[id] = [...(lists[id] ?? []).filter((entry) => entry.id !== plugin.id), plugin];
      }));
      client.call('plugins.list', {}).then((rows) => { lists[id] = rows; }, () => undefined);
    }
    return () => { for (const off of offs) off(); };
  });

  let notices = $derived.by(() => {
    const out: Notice[] = [];
    for (const host of hosts) {
      if (!owns(host.store)) continue;
      for (const plugin of lists[host.id] ?? []) {
        const key = `${host.id}:${plugin.id}`;
        const version = pluginUpdateOffer(plugin, answers, key);
        if (version !== null) out.push({ key, host, plugin, version });
      }
    }
    return out.slice(0, MOST);
  });
  let several = $derived(hosts.length > 1);
  /** Settings would hide their own controls under it, and the Plugins page shows the same update: the notice waits for the conversation. */
  let offChat = $derived(machines === undefined && workspace.active.page !== 'chat');

  /** Either answer is final for this version; the install itself shows on the Plugins page. */
  function answer(notice: Notice, install: boolean) {
    answers = answerPluginUpdate(answers, notice.key, notice.version);
    if (!install) return;
    notice.host.store.client?.call('plugins.install', { id: notice.plugin.id }).catch((cause: unknown) => notice.host.store.reportError(cause));
  }
</script>

{#if notices.length > 0}
  <div class="update-notices" class:off-chat={offChat} data-testid="plugin-update-notices" role="region" aria-label={t.noticeLabel}>
    {#each notices as notice (notice.key)}
      <article class="notice" data-testid="plugin-update-notice" data-plugin={notice.plugin.id} data-version={notice.version}>
        <span class="logo" aria-hidden="true"><Puzzle size={18} strokeWidth={1.75} /></span>
        <div class="lines">
          <span class="heading">{fill(t.noticeTitle, { name: notice.plugin.name, version: notice.version })}</span>
          <p>{t.noticeBody}{#if several}<span class="sep" aria-hidden="true"> · </span>{notice.host.label}{/if}</p>
        </div>
        <div class="actions">
          <button type="button" class="quiet small" data-testid="plugin-update-later" onclick={() => answer(notice, false)}>{t.noticeLater}</button>
          <button type="button" class="primary small" data-testid="plugin-update-run" onclick={() => answer(notice, true)}>{t.noticeUpdate}</button>
        </div>
      </article>
    {/each}
  </div>
{/if}

<style>
  /* The notice the agent updates used: pinned under the title bar, never
     auto-dismissed, leaving only on an answer. The top right corner is the one
     the composer, the sidebar and a phone's tab bar all leave alone. App mounts
     it beside its root, under the dialogs (60) and the image viewer (55). */
  .update-notices {
    position: fixed;
    right: max(16px, env(safe-area-inset-right));
    top: calc(var(--titlebar, 44px) + 12px + env(safe-area-inset-top, 0px));
    z-index: 54;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(400px, calc(100vw - 32px));
    pointer-events: none;
  }

  .notice {
    pointer-events: auto;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--color-surface-2) 96%, transparent);
    backdrop-filter: blur(10px);
    box-shadow: var(--shadow-e3);
    overflow: hidden;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .logo {
    display: grid;
    place-items: center;
    width: var(--control);
    height: var(--control);
    border-radius: var(--radius-md);
    background: var(--color-surface-3);
    color: var(--color-muted-foreground);
  }

  .lines { min-width: 0; }
  .heading { display: block; font-size: var(--text-sm); font-weight: 600; overflow-wrap: anywhere; }

  p {
    margin: 2px 0 0;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .actions { display: flex; align-items: center; gap: 6px; }

  .update-notices.off-chat { display: none; }

  @media (prefers-reduced-motion: reduce) {
    .notice { animation: none; }
  }

  /* A phone shows one at a time, under its own header. */
  @media (max-width: 720px) {
    .update-notices {
      top: calc(56px + env(safe-area-inset-top, 0px));
      left: 16px;
      right: 16px;
      width: auto;
    }
    :global(.app.phone-chat) ~ .update-notices { top: calc(56px + var(--titlebar, 44px) + 8px + env(safe-area-inset-top, 0px)); }
    .notice:nth-child(n + 2) { display: none; }
  }
  /* Too narrow for the buttons beside the text: they go under it. */
  @media (max-width: 420px) {
    .notice { grid-template-columns: auto minmax(0, 1fr); }
    .actions { grid-column: 1 / -1; justify-content: flex-end; }
  }
</style>
