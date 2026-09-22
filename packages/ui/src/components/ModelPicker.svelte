<script lang="ts">
  import { ChevronDown, ChevronRight, Search, Sparkles, Star, RefreshCw } from '@lucide/svelte';
  import { isNamedModel, orderedModels, type FavoriteModel } from '../lib/model-order';
  import type { Account, ModelInfo, ProviderSummary } from '@boite/contracts';
  import ProviderLogo from './ProviderLogo.svelte';
  import { floating } from '../lib/floating';
  import { Closing } from '../lib/closing.svelte';
  import { strings } from '../lib/strings';
  import type { Choice, PickPatch, Store } from '../lib/store.svelte';

  /**
   * A fixed frame: provider logos beside a scrolling model list on desktop.
   * Its name heads the column, its accounts sit
   * below the name as chips when there is more than one, and its models fill
   * the rest. A click on a model closes the picker; nothing else does.
   */
  let {
    store,
    choice,
    locked = false,
    disabled = false,
    onpick
  }: {
    store: Store;
    choice: Choice | null;
    /** Optional restriction for callers that intentionally keep one account. */
    locked?: boolean;
    disabled?: boolean;
    onpick: (patch: PickPatch) => void;
  } = $props();

  /** Past this many models the column stops being a plain scroll and gets a search field. */
  const SEARCH_FROM = 12;

  const popover = new Closing();
  const legacy = new Closing();
  $effect(() => { if (!popover.open) legacy.hide(); });
  let legacyOpen = $derived(legacy.open);
  let menu = $state<HTMLDivElement | undefined>(undefined);
  let root = $state<HTMLDivElement | undefined>(undefined);
  let searchBox = $state<HTMLInputElement | undefined>(undefined);
  /** What the model column is filtered on; empty while the list is short. */
  let modelQuery = $state('');
  /** The provider whose column is shown: the choice's until another tile is clicked. */
  let shownProviderId = $state<string | null>(null);
  let favoritesOpen = $state(false);
  let favoritePending = $state(false);
  const favorites = $derived(store.favorites.filter((f) => store.accountOf(f.accountId)?.providerId === f.providerId));
  function favorite(model: ModelInfo): boolean {
    return store.favorites.some((f) => f.providerId === shown?.id && f.accountId === shownAccountId && f.model.id === model.id);
  }
  async function pickFavorite(entry: FavoriteModel) {
    if (favoritePending) return;
    favoritePending = true;
    try {
      const protocol = store.providerOf(entry.providerId)?.protocol;
      if (protocol === 'claude-sdk' || protocol === 'acp' || protocol === 'codex-appserver' || protocol === 'muse' || protocol === 'pi' || protocol === 'agy') await store.probeModels(entry.providerId, entry.accountId);
      if (!store.modelsOf(entry.providerId, entry.accountId).some((m) => m.id === entry.model.id)) { store.error = strings.composer.favoriteUnavailable; return; }
      onpick({ providerId: entry.providerId, accountId: entry.accountId, model: entry.model.id });
      popover.hide();
    } finally { favoritePending = false; }
  }

  interface Tile {
    provider: ProviderSummary;
    /** Why this provider cannot run, or null: it dims the tile and rides in its title. */
    reason: string | null;
    /** True while an open thread holds the choice on another provider. */
    held: boolean;
  }

  let provider = $derived(choice ? store.providerOf(choice.providerId) : null);
  let account = $derived(choice ? store.accountOf(choice.accountId) : null);
  let shown = $derived(
    (shownProviderId ? store.providerOf(shownProviderId) : null) ?? provider ?? store.providers[0] ?? null
  );
  /** The account the right column belongs to: an agent lists its models per login. */
  let shownAccountId = $derived.by((): string | null => {
    if (!shown) return null;
    if (choice && choice.providerId === shown.id) return choice.accountId;
    return store.accountsOf(shown.id)[0]?.id ?? null;
  });
  let seats = $derived(shown ? store.accountsOf(shown.id) : []);
  /**
   * The files are still to download, so this provider has no models to offer
   * yet. An agent the user installed on their own is there whatever Boite's own
   * release says.
   */
  let needsInstall = $derived.by((): boolean => {
    if (!shown || shown.available) return false;
    const install = store.installOf(shown.id);
    return install !== null && install.state !== 'installed';
  });
  let shownModels = $derived(shown ? orderedModels(store.modelsOf(shown.id, shownAccountId)) : []);
  let probing = $derived(shown ? store.isProbing(shown.id, shownAccountId) : false);

  async function refreshModels() {
    if (favoritesOpen) {
      const seen = new Set<string>();
      for (const entry of favorites) {
        const key = entry.providerId + '::' + entry.accountId;
        if (seen.has(key)) continue;
        seen.add(key);
        await store.probeModels(entry.providerId, entry.accountId, true);
      }
    } else if (shown && shownAccountId) await store.probeModels(shown.id, shownAccountId, true);
  }

  // An ACP agent owns its model list, so the descriptor cannot carry it: the
  // core reads it from one short-lived agent process the first time the picker
  // shows that instance, and the answer stands for the rest of the session.
  // Nothing is asked of a provider whose executable is not on the machine.
  $effect(() => {
    if (!popover.open || favoritesOpen || !shown || needsInstall) return;
    if (shown.protocol !== 'claude-sdk' && shown.protocol !== 'acp' && shown.protocol !== 'codex-appserver' && shown.protocol !== 'muse' && shown.protocol !== 'pi' && shown.protocol !== 'agy') return;
    const accountId = shownAccountId;
    if (accountId === null) return;
    void store.probeModels(shown.id, accountId);
  });

  // Keep the shown provider visible in the vertical rail or phone strip.
  $effect(() => {
    const current = favoritesOpen ? 'favorites' : shown?.id;
    if (!popover.shown || !menu || !current) return;
    const rail = menu.querySelector<HTMLElement>('.rail');
    const tile = rail?.querySelector<HTMLElement>(`[data-provider="${current}"]`);
    if (!rail || !tile) return;
    const railBox = rail.getBoundingClientRect();
    const tileBox = tile.getBoundingClientRect();
    if (!window.matchMedia('(max-width: 720px)').matches) {
      if (tileBox.bottom > railBox.bottom) rail.scrollTop += tileBox.bottom - railBox.bottom;
      else if (tileBox.top < railBox.top) rail.scrollTop -= railBox.top - tileBox.top;
      return;
    }
    const visibleRight = railBox.right - (parseFloat(getComputedStyle(rail).paddingRight) || 0);
    if (tileBox.right > visibleRight) rail.scrollLeft += tileBox.right - visibleRight;
    else if (tileBox.left < railBox.left) rail.scrollLeft -= railBox.left - tileBox.left;
  });

  // The effort has a chip of its own in the composer, so this one names the
  // model and the account only: one place says the level.
  let label = $derived.by(() => {
    if (!choice || !provider) return strings.composer.noProvider;
    const model = store.modelOf(choice);
    const name = model && isNamedModel(model) ? model.name : strings.composer.picker;
    const siblings = store.accountsOf(provider.id);
    return siblings.length > 1 && account ? `${name} · ${account.label}` : name;
  });

  /** One tile per provider, in the order the core listed them. */
  let tiles = $derived.by((): Tile[] =>
    store.providers.map((entry) => {
      const reason = !entry.available
        ? strings.composer.unavailable
        : store.accountsOf(entry.id).length === 0
          ? strings.composer.noAccount
          : null;
      return { provider: entry, reason, held: locked && choice?.providerId !== entry.id };
    })
  );

  function tileTitle(tile: Tile): string {
    if (tile.held) return strings.composer.lockedHint;
    return tile.reason === null ? tile.provider.name : `${tile.provider.name}, ${tile.reason}`;
  }

  /** What keeps an account chip from being clicked, or null. */
  function seatReason(seat: Account): string | null {
    if (!shown) return null;
    const hints: string[] = [];
    if (!shown.available) hints.push(strings.composer.unavailable);
    if (seat.status === 'unauthenticated') hints.push(strings.accounts.status.unauthenticated);
    return hints.join(', ') || null;
  }

  function seatHeld(seat: Account): boolean {
    return locked && !(choice?.providerId === shown?.id && choice?.accountId === seat.id);
  }

  function seatTitle(seat: Account): string {
    if (seatHeld(seat)) return strings.composer.lockedHint;
    const reason = seatReason(seat);
    return reason === null ? (seat.identity ?? seat.label) : `${seat.label}, ${reason}`;
  }

  let currentModels = $derived(shownModels.filter((m) => !m.legacy));
  let legacyModels = $derived(shownModels.filter((m) => m.legacy));

  // An ACP agent can list hundreds of models (OpenCode answered 534 here), and a
  // plain scroll is useless at that length: past twelve the column gets a search
  // field and the matches are grouped by the `provider/` prefix of their id.
  let searchable = $derived(shownModels.length > SEARCH_FROM);
  let words = $derived(
    searchable ? modelQuery.toLowerCase().split(/\s+/).filter((word) => word.length > 0) : []
  );

  function matches(model: ModelInfo): boolean {
    if (words.length === 0) return true;
    const hay = `${model.id} ${model.name}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  }

  /** The descriptor's default: on an ACP provider it is "let the agent choose", so it never filters out. */
  let pinnedModel = $derived.by((): ModelInfo | null => {
    if (!searchable || !shown) return null;
    const id = store.defaultModelOf(shown);
    return shownModels.find((m) => m.id === id) ?? null;
  });

  let filteredCurrent = $derived(
    searchable ? currentModels.filter((m) => m.id !== pinnedModel?.id && matches(m)) : currentModels
  );
  let filteredLegacy = $derived(searchable ? legacyModels.filter(matches) : legacyModels);

  interface Group {
    /** The part of the id before the first slash, empty for a model that has none. */
    key: string;
    models: ModelInfo[];
  }

  /** One label per prefix, the groups in the order the agent first mentioned each. */
  let groups = $derived.by((): Group[] => {
    const byKey = new Map<string, Group>();
    for (const model of filteredCurrent) {
      const slash = model.id.indexOf('/');
      const key = slash > 0 ? model.id.slice(0, slash) : '';
      const group = byKey.get(key);
      if (group) group.models.push(model);
      else byKey.set(key, { key, models: [model] });
    }
    return [...byKey.values()];
  });

  function isCurrentModel(model: ModelInfo): boolean {
    return shown !== null && choice?.providerId === shown.id && choice?.model === model.id;
  }

  // A column that opens on a long list is a column you are about to type in.
  $effect(() => {
    if (!popover.open || !searchable) return;
    searchBox?.focus();
  });

  function toggle(event: MouseEvent) {
    event.stopPropagation();
    popover.toggle();
    if (popover.open) {
      shownProviderId = choice?.providerId ?? null;
      favoritesOpen = favorites.length > 0;
      legacy.hide();
      modelQuery = '';
    }
  }

  /** A tile only moves the column: the choice follows a model or an account chip. */
  function pickTile(tile: Tile) {
    if (tile.held) return;
    favoritesOpen = false;
    shownProviderId = tile.provider.id;
    legacy.hide();
    modelQuery = '';
  }

  function pickSeat(seat: Account) {
    if (!shown || seatHeld(seat) || !shown.available) return;
    if (choice?.providerId === shown.id && choice.accountId === seat.id) return;
    modelQuery = '';
    onpick({ providerId: shown.id, accountId: seat.id, model: store.defaultModelOf(shown) });
  }

  async function pickModel(model: ModelInfo) {
    if (!shown) return;
    const instance =
      choice && choice.providerId === shown.id
        ? { providerId: choice.providerId, accountId: choice.accountId }
        : firstInstanceOf(shown.id);
    if (!instance || favoritePending) return;
    favoritePending = true;
    try {
      await store.probeModels(instance.providerId, instance.accountId);
      if (!store.modelsOf(instance.providerId, instance.accountId).some(m => m.id === model.id)) { store.error = strings.composer.favoriteUnavailable; return; }
      onpick({ ...instance, model: model.id });
      popover.hide();
    } finally { favoritePending = false; }
  }

  /** The download happens on the Accounts page now, so the picker sends you there. */
  function openInstall() {
    popover.hide();
    store.showSettings('accounts');
  }

  function firstInstanceOf(providerId: string): { providerId: string; accountId: string } | null {
    const entry = store.providerOf(providerId);
    if (!entry || !entry.available) return null;
    const seat = store.accountsOf(providerId)[0];
    return seat ? { providerId, accountId: seat.id } : null;
  }

  function focusable(): HTMLElement[] {
    return Array.from(activeMenu()?.querySelectorAll<HTMLElement>('[data-row]:not(:disabled)') ?? []);
  }

  function activeMenu(): HTMLElement | null {
    return legacyOpen ? root?.querySelector<HTMLElement>('[data-testid=picker-legacy-menu]') ?? null : menu ?? null;
  }

  /** The model rows alone: what the arrows walk once the search field has the focus. */
  function modelRows(): HTMLElement[] {
    return Array.from(activeMenu()?.querySelectorAll<HTMLElement>('.models [data-row]:not(:disabled)') ?? []);
  }

  function handleEscape(event: KeyboardEvent) {
    event.stopPropagation();
    if (legacyOpen) {
      legacy.hide();
      root?.querySelector<HTMLElement>('[data-testid=picker-legacy]')?.focus();
      return;
    }
    // The query goes first: closing on it would throw away what was just typed.
    if (searchable && modelQuery !== '') {
      modelQuery = '';
      searchBox?.focus();
      return;
    }
    popover.hide();
  }

  function handleLegacyNavigation(event: KeyboardEvent, active: HTMLElement | null): boolean {
    if (event.key === 'ArrowRight' && active?.dataset.testid === 'picker-legacy') {
      event.preventDefault();
      legacy.show();
      queueMicrotask(() => root?.querySelector<HTMLElement>('[data-testid=picker-legacy-menu] [data-model]')?.focus());
      return true;
    }
    if (event.key === 'ArrowLeft' && active?.closest('[data-testid=picker-legacy-menu]')) {
      event.preventDefault();
      legacy.hide();
      root?.querySelector<HTMLElement>('[data-testid=picker-legacy]')?.focus();
      return true;
    }
    return false;
  }

  function handleModelSearch(event: KeyboardEvent, active: HTMLElement | null): boolean {
    if (legacyOpen) return false;
    if (!searchable || (active !== searchBox && !active?.hasAttribute('data-model'))) return false;
    if (event.key === 'Enter') {
      // A focused row is activated by the browser too; taking the default keeps it to one pick.
      event.preventDefault();
      const row = active === searchBox ? modelRows()[0] : active;
      row?.click();
      return true;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
    event.preventDefault();
    const list = modelRows();
    const here = active === searchBox || !active ? -1 : list.indexOf(active);
    if (event.key === 'ArrowDown') list[Math.min(here + 1, list.length - 1)]?.focus();
    else if (here <= 0) searchBox?.focus();
    else list[here - 1]?.focus();
    return true;
  }

  function handleAccountNavigation(event: KeyboardEvent, active: HTMLElement | null): boolean {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false;
    // The account chips are a segmented control: the arrows walk them.
    const chips = root ? Array.from(root.querySelectorAll<HTMLElement>('.popover [data-seat]:not(:disabled)')) : [];
    const here = active ? chips.indexOf(active) : -1;
    if (here === -1) return false;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    chips[(here + step + chips.length) % chips.length]?.focus();
    return true;
  }

  function handleRowNavigation(event: KeyboardEvent, active: HTMLElement | null) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const list = focusable();
    if (list.length === 0) return;
    event.preventDefault();
    const index = active ? list.indexOf(active) : -1;
    const next = event.key === 'ArrowDown' ? (index + 1) % list.length : (index - 1 + list.length) % list.length;
    list[next]?.focus();
  }

  function onkeydown(event: KeyboardEvent) {
    if (!popover.open) return;
    const active = document.activeElement as HTMLElement | null;
    if (event.key === 'Escape') return handleEscape(event);
    if (handleLegacyNavigation(event, active)) return;
    if (handleModelSearch(event, active)) return;
    if (handleAccountNavigation(event, active)) return;
    handleRowNavigation(event, active);
  }

  function onWindowPointerdown(event: PointerEvent) {
    if (!popover.open) return;
    if (root && event.target instanceof Node && root.contains(event.target)) return;
    popover.hide();
  }
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

<div class="picker" bind:this={root}>
  <button
    type="button"
    class="chip trigger"
    aria-haspopup="menu"
    aria-expanded={popover.open}
    aria-label={strings.composer.picker}
    title={locked ? strings.composer.lockedHint : strings.composer.picker}
    data-testid="composer-picker"
    {disabled}
    onclick={toggle}
    {onkeydown}
  >
    {#if provider}
      <ProviderLogo providerId={provider.id} size={14} />
    {:else}
      <Sparkles size={14} strokeWidth={1.75} />
    {/if}
    <span class="label">{label}</span>
    <ChevronDown size={12} strokeWidth={2} />
  </button>

  {#if popover.shown}
    <div
      class="popover"
      class:closing={popover.closing}
      role="menu"
      tabindex="-1"
      aria-label={strings.composer.picker}
        data-testid="composer-picker-menu"
      bind:this={menu}
      use:floating={{ anchor: () => root?.closest<HTMLElement>("[data-testid=composer]") ?? null, dismiss: () => popover.hide() }}
      use:popover.attach
      onanimationend={popover.end}
      {onkeydown}
    >
      {#if store.owner}
        <button class="refresh" type="button" data-testid="picker-refresh" aria-label={strings.composer.refreshModels} title={strings.composer.refreshModels} disabled={probing || needsInstall} onclick={() => void refreshModels()}><RefreshCw size={14} class={probing ? 'spin' : ''} /></button>
      {/if}
      <div class="column rail">
        <button type="button" class="tile" class:current={favoritesOpen} role="menuitem" data-row data-provider="favorites" title={strings.composer.favorites} aria-label={strings.composer.favorites} onclick={() => { favoritesOpen = true; modelQuery = ''; }}><Star size={18} /></button>
        {#each tiles as tile (tile.provider.id)}
          <button
            type="button"
            class="tile"
            class:current={!favoritesOpen && shown?.id === tile.provider.id}
            class:dim={tile.reason !== null}
            disabled={tile.held}
            role="menuitem"
            data-row
            data-provider={tile.provider.id}
            title={tileTitle(tile)}
            aria-label={tile.provider.name}
            onclick={() => pickTile(tile)}
          >
            <ProviderLogo providerId={tile.provider.id} size={18} />
          </button>
        {/each}
      </div>

      <div class="column models main-models">
        {#snippet modelRow(model: ModelInfo)}
          <div class="model-entry">
          <button
            type="button"
            class="row model"
            class:current={isCurrentModel(model)}
            role="menuitem"
            data-row
            data-model={model.id}
            onclick={() => pickModel(model)}
          >
            <span class="mark"></span>
            <span class="name">{model.name}</span>
            {#if model.badge === 'new'}
              <span class="badge">{strings.composer.newBadge}</span>
            {/if}
          </button>
          <button type="button" class="favorite-button" data-testid="model-favorite" data-favorite-model={model.id} aria-label={favorite(model) ? strings.composer.unfavorite : strings.composer.favorite} aria-pressed={favorite(model)} onclick={() => { if (shown && shownAccountId) store.toggleFavorite(shown.id, shownAccountId, model); }}><Star size={14} fill={favorite(model) ? 'currentColor' : 'none'} /></button>
          </div>
        {/snippet}

        {#if favoritesOpen}
          <div class="head"><span class="provider-name">{strings.composer.favorites}</span></div>
          <div class="model-list">
          {#each favorites as entry (`${entry.providerId}:${entry.accountId}:${entry.model.id}`)}
            <div class="model-entry">
              <button type="button" class="row model favorite-row" role="menuitem" data-row data-testid="favorite-model" disabled={favoritePending || !store.providerOf(entry.providerId)?.available} onclick={() => void pickFavorite(entry)}>
                <ProviderLogo providerId={entry.providerId} size={16} /><span class="name">{entry.model.name}{#if favorites.some(other => other.providerId === entry.providerId && other.model.id === entry.model.id && other.accountId !== entry.accountId)}<span class="account-label">{store.accountOf(entry.accountId)?.label}</span>{/if}</span>
              </button>
              <button type="button" class="favorite-button" aria-label={strings.composer.unfavorite} onclick={() => store.toggleFavorite(entry.providerId, entry.accountId, entry.model)}><Star size={14} fill="currentColor" /></button>
            </div>
          {:else}<p class="none subtle" data-testid="favorites-empty">{strings.composer.favoritesEmpty}</p>{/each}
          </div>
        {:else}
        <div class="head">
          <span class="provider-name">{shown ? shown.name : strings.composer.models}</span>
          {#if seats.length > 1}
            <div class="seats" role="group" aria-label={strings.accounts.heading}>
              {#each seats as seat (seat.id)}
                <button
                  type="button"
                  class="seat"
                  disabled={seatHeld(seat) || !(shown?.available ?? false)}
                  data-seat
                  data-instance="{shown?.id}::{seat.id}"
                  aria-pressed={seat.id === shownAccountId}
                  title={seatTitle(seat)}
                  onclick={() => pickSeat(seat)}
                >
                  {seat.label}
                </button>
              {/each}
            </div>
          {/if}
        </div>
        {#key `${shown?.id}:${shownAccountId}`}
        <div class="model-list">
        {#if locked && seats.length > 1}
          <span class="locked-note">{strings.composer.lockedHint}</span>
        {/if}

        {#if needsInstall}
          <p class="none subtle" data-testid="picker-not-installed">{strings.composer.notInstalled}</p>
          <!-- The Providers page is `accounts.*` and `providers.install`, so the
               device is told the provider is missing and nothing more. -->
          {#if store.owner}
            <button
              type="button"
              class="quiet small to-settings"
              data-testid="picker-install-settings"
              onclick={openInstall}
            >
              {strings.composer.installInSettings}
            </button>
          {/if}
        {:else}
          {#if searchable}
            <div class="search-bar">
              <label class="search">
                <Search size={13} strokeWidth={1.75} />
                <input
                  bind:this={searchBox}
                  bind:value={modelQuery}
                  placeholder={strings.composer.searchModels}
                  aria-label={strings.composer.searchModels}
                  data-testid="picker-search"
                  spellcheck="false"
                />
              </label>
            </div>
            {#if pinnedModel}
              {@render modelRow(pinnedModel)}
            {/if}
            {#each groups as group (group.key)}
              {#if group.key}
                <span class="section-label group" data-group={group.key}>{group.key}</span>
              {/if}
              {#each group.models as model (model.id)}
                {@render modelRow(model)}
              {/each}
            {/each}
            {#if groups.length === 0 && filteredLegacy.length === 0 && modelQuery.trim() !== ''}
              <p class="none subtle" data-testid="picker-no-models">{strings.composer.noModels}</p>
            {/if}
          {:else}
            {#each currentModels as model (model.id)}
              {@render modelRow(model)}
            {/each}
          {/if}

          {#if filteredLegacy.length > 0}
            <button
              type="button"
              class="row fold small"
              data-row
              data-testid="picker-legacy"
              aria-expanded={legacyOpen}
              onclick={() => legacy.toggle()}
            >
              <span class="name muted">{strings.composer.legacyModels}</span>
              <ChevronRight size={14} strokeWidth={2} />
            </button>
          {/if}
          {#if shown && shownModels.length === 0 && !probing}
            <p class="none subtle">{strings.composer.noModels}</p>
          {/if}
          {#if probing}
            <p class="none subtle probing" data-testid="picker-probing">{strings.composer.probing}</p>
          {/if}
        {/if}
        </div>
        {/key}
        {/if}
      </div>
    </div>
  {/if}
  {#if popover.shown && legacy.shown && !favoritesOpen && filteredLegacy.length > 0}
    <div class="popover legacy-menu" class:closing={legacy.closing} role="menu" tabindex="-1" data-testid="picker-legacy-menu" aria-label={strings.composer.legacyModels} use:legacy.attach onanimationend={legacy.end} use:floating={{ anchor: () => menu ?? null, side: 'right' }} {onkeydown}>
      <div class="column models">
        <div class="head"><button type="button" class="icon small legacy-back" aria-label={strings.settings.back} onclick={() => legacy.hide()}><ChevronRight size={14} style="transform: rotate(180deg)" /></button><span class="provider-name">{strings.composer.legacyModels}</span></div>
                {#each filteredLegacy as model (model.id)}
                  <div class="model-entry">
                  <button
                    type="button"
                    class="row model legacy"
                    class:current={isCurrentModel(model)}
                    role="menuitem"
                    tabindex={legacyOpen ? 0 : -1}
                    data-row={legacyOpen || undefined}
                    data-model={legacyOpen ? model.id : undefined}
                    onclick={() => pickModel(model)}
                  >
                    <span class="mark"></span>
                    <span class="name">{model.name}</span>
                  </button>
                  <button type="button" class="favorite-button" tabindex={legacyOpen ? 0 : -1} aria-label={favorite(model) ? strings.composer.unfavorite : strings.composer.favorite} aria-pressed={favorite(model)} onclick={() => { if (shown && shownAccountId) store.toggleFavorite(shown.id, shownAccountId, model); }}><Star size={14} fill={favorite(model) ? 'currentColor' : 'none'} /></button>
                  </div>
                {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .model-entry { display: flex; align-items: center; }
  .model-entry .model { flex: 1; min-width: 0; }
  .favorite-button { width: var(--control-sm); height: var(--control-sm); padding: 0; flex: none; color: var(--color-muted-foreground); background: transparent; border: none; }
  .favorite-button[aria-pressed='true'] { color: var(--color-foreground); }
  .account-label { margin-left: 8px; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .row.favorite-row { min-height: 42px; }
  .popover.legacy-menu { width: min(320px, calc(100vw - 24px)); height: auto; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); z-index: 41; }
  .picker {
    display: inline-flex;
    min-width: 0;
  }

  .trigger {
    cursor: pointer;
    height: var(--control-sm);
    max-width: 260px;
    padding-right: 6px;
    transition:
      background var(--dur-2) var(--ease-out-quint),
      color var(--dur-2) var(--ease-out-quint);
  }

  .trigger:hover,
  .trigger[aria-expanded='true'] {
    background: var(--color-surface-3);
    color: var(--color-foreground);
  }

  .trigger .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .popover {
    position: fixed;
    z-index: 40;
    display: grid;
    grid-template-columns: calc(var(--control-lg) + 28px) minmax(0, 1fr);
    width: min(440px, calc(100vw - 32px));
    height: 360px;
    max-height: min(360px, 45dvh);
    grid-template-rows: minmax(0, 1fr) auto;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-e2);
    animation: pop var(--dur-2) var(--ease-out-quint);
    transform-origin: top left;
    overflow: hidden;
  }

  .popover.closing {
    animation-name: pop-out;
    pointer-events: none;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    touch-action: pan-y;
  }

  .rail {
    align-items: center;
    gap: 4px;
    background: var(--color-surface);
  }

  .tile {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: var(--control-lg);
    height: var(--control-lg);
    padding: 0;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-muted-foreground);
    transition:
      background var(--dur-2) var(--ease-out-quint),
      color var(--dur-2) var(--ease-out-quint);
  }

  .tile:hover:not(:disabled),
  .tile:focus-visible {
    background: var(--color-hover);
    color: var(--color-foreground);
    outline: none;
  }

  .tile.current {
    background: var(--color-active);
    color: var(--color-foreground);
  }

  /* Nothing runs on it: still pickable, so its column can say why. */
  .tile.dim {
    opacity: 0.45;
  }

  .models > * { flex-shrink: 0; }
  .main-models { grid-area: 1 / 2 / 3 / 3; overflow: hidden; padding: 0; gap: 0; border-left: 1px solid var(--color-border); }
  .main-models .head { flex-direction: column; align-items: stretch; gap: 6px; height: calc(var(--control-sm) + 56px); padding: 10px 12px; border-bottom: 1px solid var(--color-border); }
  .model-list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; padding: 6px; }
  .rail { grid-area: 1 / 1; }
  .refresh { grid-area: 2 / 1; align-self: end; justify-self: center; margin: 6px; position: relative; z-index: 3; display: grid; place-items: center; width: var(--control-lg); height: var(--control-lg); padding: 0; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); color: var(--color-muted-foreground); }
  .refresh:hover:not(:disabled) { background: linear-gradient(var(--color-hover) 0 0), var(--color-surface); color: var(--color-foreground); }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: var(--control-sm);
    padding: 2px 4px 6px;
  }

  .provider-name {
    font-size: var(--text-base);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .seats {
    display: flex;
    gap: 2px;
    align-self: flex-start;
    flex-shrink: 0;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 2px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    min-width: 0;
  }

  .seat {
    height: var(--control-sm);
    min-height: var(--control-sm);
    flex-shrink: 0;
    max-width: 150px;
    padding: 0 7px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
    transition:
      background var(--dur-2) var(--ease-out-quint),
      color var(--dur-2) var(--ease-out-quint);
  }

  .seat:hover:not(:disabled),
  .seat:focus-visible {
    background: var(--color-surface-3);
    color: var(--color-foreground);
    outline: none;
  }

  .seat[aria-pressed='true'] {
    background: var(--color-surface-3);
    color: var(--color-foreground);
    box-shadow: var(--shadow-e1);
  }

  .locked-note {
    padding: 0 4px 6px;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }

  .to-settings {
    align-self: flex-start;
    margin: 2px 0 0 4px;
  }

  /* The sidebar's search box, kept in place while hundreds of rows scroll under it. */
  .search-bar {
    position: sticky;
    /* The column pads by 6, so the bar starts 6 higher and paints that strip itself. */
    top: -6px;
    z-index: 1;
    margin: 0 -6px 4px;
    padding: 6px 6px 4px;
    background: var(--color-surface-2);
  }

  .search {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--control);
    padding: 0 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    color: var(--color-subtle);
    transition: border-color var(--dur-2) var(--ease-out-quint);
  }

  .search:focus-within {
    border-color: var(--color-edge);
    color: var(--color-muted-foreground);
  }

  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--color-foreground);
    font-size: var(--text-sm);
  }

  .search input:focus {
    outline: none;
  }

  .group {
    padding: 8px 8px 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    width: 100%;
    min-height: var(--row);
    padding: 3px 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-foreground);
    text-align: left;
    white-space: normal;
  }

  .row:hover:not(:disabled),
  .row:focus-visible {
    background: var(--color-hover);
    outline: none;
  }

  /* A full width row does not shrink under the finger, it fills one step more. */
  .row:active:not(:disabled) {
    transform: none;
    background: color-mix(in srgb, var(--color-surface-3) 85%, var(--color-foreground));
  }

  .mark {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
    background: transparent;
  }

  .row.current .mark {
    background: var(--color-foreground);
  }

  .name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .model .name {
    flex: 1;
  }

  .legacy .name {
    font-weight: 400;
    color: var(--color-muted-foreground);
  }

  .badge {
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 1px 5px;
    border-radius: 999px;
    border: 1px solid var(--color-edge);
    color: var(--color-muted-foreground);
  }

  .fold {
    margin-top: 4px;
    min-height: var(--control-sm);
  }

  p.none {
    padding: 6px 8px;
    font-size: var(--text-sm);
  }

  /* The agent is being asked for its models; the descriptor's stay above. */
  p.probing {
    margin-top: 2px;
    font-size: var(--text-sm);
  }

  @media (max-width: 720px) {
    .popover {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-rows: auto minmax(0, 1fr);
      width: calc(100vw - 24px);
      height: min(420px, 60dvh);
    }

    .rail {
      flex-direction: row;
      flex-wrap: nowrap;
      padding-bottom: 6px;
      align-items: center;
      touch-action: pan-x;
      overflow-x: auto;
      justify-content: flex-start;
      border-right: none;
      border-bottom: 1px solid var(--color-border);
    }

    /* The rail is the finger's first stop on a phone, so its tiles and the
       refresh button take a full touch target like every other control. */
    .main-models { grid-area: 2 / 1 / 3 / 3; border-left: none; }
    .seat { height: var(--touch-target); min-height: var(--touch-target); }
    .refresh { grid-area: 1 / 2; align-self: center; justify-self: end; justify-content: center; width: var(--touch-target); padding: 0; border: none; }
    .tile { justify-content: center; padding: 0; }
    .tile,
    .refresh {
      width: var(--touch-target);
      height: var(--touch-target);
    }
  }
</style>
