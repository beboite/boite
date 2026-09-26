<script lang="ts" module>
  import type { Component } from 'svelte';
  import type { SettingsTab } from '../lib/store.svelte';

  /** One place the search can land: a page, or a card on it. */
  export type SettingsEntry = { tab: SettingsTab; section: string | null; label: string; trail: string };
  export type SettingsTile = { id: SettingsTab; label: string; icon: Component<{ size?: number; strokeWidth?: number }>; group: number };
</script>

<script lang="ts">
  import { ChevronRight, Search } from '@lucide/svelte';
  import { connected } from '../lib/provider-setup';
  import { providerRows } from '../lib/provider-family';
  import { fill, strings } from '../lib/strings';
  import { workspace } from '../lib/workspace.svelte';
  import type { Store } from '../lib/store.svelte';

  /**
   * Where Settings opens: a search over every page and card, then one tile
   * per page. A tile says something only when there is a state worth reading
   * from here, how many providers answer and how many machines are paired.
   */
  let { store, tiles, entries, onopen }: {
    store: Store;
    tiles: SettingsTile[];
    entries: SettingsEntry[];
    onopen: (entry: SettingsEntry) => void;
  } = $props();

  let query = $state('');

  /** "Clavier" finds "clavier", "Récents" finds "recents": case and accents never decide a match. */
  const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

  let results = $derived.by(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    return entries.filter((entry) => {
      const text = fold(`${entry.label} ${entry.trail}`);
      return words.every((word) => text.includes(word));
    }).slice(0, 12);
  });

  let rows = $derived(providerRows(store.providers));
  let ready = $derived(rows.filter((row) => row.members.some((provider) => connected(provider, store.accounts))).length);
  let machines = $derived(Math.max(1, workspace.machines.length));

  /** The state line under a tile, null when the page has none worth a glance. */
  function status(tab: SettingsTab): { text: string; tone?: 'call' } | null {
    if (tab === 'accounts' && store.providers.length > 0) {
      return ready === 0 ? { text: strings.settings.connectProvider, tone: 'call' } : { text: ready === 1 ? strings.settings.providersOne : fill(strings.settings.providersReady, { count: String(ready) }) };
    }
    if (tab === 'machines') {
      const parts = machines > 1 ? [fill(strings.settings.machinesCount, { count: String(machines) })] : [];
      if (store.sessions.length > 0) parts.push(store.sessions.length === 1 ? strings.settings.devicesOne : fill(strings.settings.devicesCount, { count: String(store.sessions.length) }));
      return parts.length > 0 ? { text: parts.join(' · ') } : null;
    }
    return null;
  }

  let groups = $derived(tiles.filter((tile) => tile.id !== 'home').reduce<SettingsTile[][]>((all, tile) => {
    const last = all.at(-1);
    if (last && last[0]!.group === tile.group) last.push(tile);
    else all.push([tile]);
    return all;
  }, []));

  $effect(() => {
    if (store.connection === 'ready') void store.loadSessions();
  });

  function onkey(event: KeyboardEvent) {
    if (event.key === 'Enter' && results[0]) {
      event.preventDefault();
      onopen(results[0]);
    } else if (event.key === 'Escape' && query) {
      event.preventDefault();
      event.stopPropagation();
      query = '';
    }
  }
</script>

<div class="page home" data-testid="settings-home">
  <header>
    <h1>{strings.settings.heading}</h1>
  </header>

  <label class="search">
    <Search size={16} strokeWidth={1.75} />
    <input type="search" bind:value={query} placeholder={strings.settings.search} aria-label={strings.settings.search} data-testid="settings-search" onkeydown={onkey} spellcheck="false" autocomplete="off" />
  </label>

  {#if query.trim()}
    {#if results.length === 0}
      <p class="hint" data-testid="settings-search-empty">{strings.settings.searchEmpty}</p>
    {:else}
      <div class="card flush results" data-testid="settings-search-results">
        {#each results as entry (`${entry.tab}:${entry.section}:${entry.label}`)}
          <button type="button" class="ghost result" data-testid="settings-search-result" onclick={() => onopen(entry)}>
            <span class="label">{entry.label}</span>
            {#if entry.trail}<span class="trail">{entry.trail}</span>{/if}
            <ChevronRight size={15} />
          </button>
        {/each}
      </div>
    {/if}
  {:else}
    {#each groups as group, index (index)}
      <div class="tiles">
        {#each group as tile (tile.id)}
          {@const Icon = tile.icon}
          {@const line = status(tile.id)}
          <button type="button" class="tile" data-testid="settings-home-{tile.id}" onclick={() => onopen({ tab: tile.id, section: null, label: tile.label, trail: '' })}>
            <span class="glyph"><Icon size={18} strokeWidth={1.75} /></span>
            <span class="text">
              <span class="label">{tile.label}</span>
              {#if line}<span class="status" class:call={line.tone === 'call'}>{line.text}</span>{/if}
            </span>
          </button>
        {/each}
      </div>
    {/each}
  {/if}
</div>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: var(--settings-width);
    height: 40px;
    padding: 0 12px;
    margin-bottom: 28px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    color: var(--color-muted-foreground);
    transition: border-color var(--dur-2);
  }
  .search:focus-within { border-color: var(--color-foreground); }
  .search input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; background: transparent; box-shadow: none; outline: none; font-size: var(--text-base); }
  .search input::-webkit-search-cancel-button { display: none; }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
    max-width: var(--settings-width);
    margin-bottom: 24px;
  }

  .tile {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;
    height: auto;
    min-height: 60px;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    box-shadow: none;
    text-align: left;
    font-weight: normal;
    color: var(--color-foreground);
    transition: background var(--dur-2), border-color var(--dur-2);
  }
  .tile:hover { background: var(--color-hover); border-color: var(--color-edge); }
  .tile:active:not(:disabled) { transform: none; }

  .glyph {
    display: grid;
    place-items: center;
    flex: none;
    width: 34px;
    height: 34px;
    border-radius: var(--radius-md);
    background: var(--color-surface-3);
    color: var(--color-muted-foreground);
  }

  .text { display: grid; gap: 2px; min-width: 0; }
  .label { font-weight: 500; overflow-wrap: anywhere; }
  .status { font-size: var(--text-sm); color: var(--color-muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status.call { color: var(--color-accent); }

  .results { max-width: var(--settings-width); display: grid; }
  .result {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
    height: auto;
    min-height: var(--row);
    padding: 8px 14px;
    border-radius: 0;
    color: var(--color-foreground);
    text-align: left;
  }
  .result + .result { border-top: 1px solid var(--color-border); }
  .result .label { flex: none; max-width: 60%; }
  .result .trail { flex: 1; min-width: 0; font-size: var(--text-sm); color: var(--color-muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result :global(svg) { flex: none; color: var(--color-subtle); }
</style>
