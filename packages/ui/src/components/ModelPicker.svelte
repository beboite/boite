<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ChevronDown, ChevronRight, Plug, Sparkles, Star, RefreshCw } from '@lucide/svelte';
  import { isNamedModel, orderedModels, type FavoriteModel } from '../lib/model-order';
  import type { Account, ModelInfo } from '@boite/contracts';
  import AccountSeats from './AccountSeats.svelte';
  import ModelSearch from './ModelSearch.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import ProviderTiles from './ProviderTiles.svelte';
  import { floating } from '../lib/floating';
  import { Closing } from '../lib/closing.svelte';
  import { fill, strings } from '../lib/strings';
  import { FIRST_MODELS, favoriteIds, firstModels, groupModels } from '../lib/model-list';
  import { pickerKeydown } from '../lib/model-picker-keys';
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
    single = false,
    disabled = false,
    onpick
  }: {
    store: Store;
    choice: Choice | null;
    /** Optional restriction for callers that intentionally keep one account. */
    locked?: boolean;
    /** The choice's provider alone: no provider rail and no favorites, its models straight away. */
    single?: boolean;
    disabled?: boolean;
    onpick: (patch: PickPatch) => void;
  } = $props();

  /** Long lists get prefix groups and a bounded first page. */
  const SEARCH_FROM = 12;

  const popover = new Closing();
  const legacy = new Closing();
  let mounted = true;
  let pickEpoch = 0;
  onDestroy(() => { mounted = false; pickEpoch += 1; });
  $effect(() => {
    if (!popover.open) { legacy.hide(); pickEpoch += 1; pickPending = false; }
  });
  let legacyOpen = $derived(legacy.open);
  let menu = $state<HTMLDivElement | undefined>(undefined);
  let root = $state<HTMLDivElement | undefined>(undefined);
  let searchBox = $state<HTMLInputElement | undefined>(undefined);
  /** Filters model names and ids, including legacy entries. */
  let modelQuery = $state('');
  /** The provider whose column is shown: the choice's until another tile is clicked. */
  let shownProviderId = $state<string | null>(null);
  let favoritesOpen = $state(false);
  let pickPending = $state(false);
  const favorites = $derived(store.favorites.filter((f) => store.accountOf(f.accountId)?.providerId === f.providerId && store.providerOn(f.providerId)));
  const favoriteSet = $derived.by(() => favoriteIds(store.favorites, shown?.id, shownAccountId));
  function favorite(model: ModelInfo): boolean {
    return favoriteSet.has(model.id);
  }
  async function applyPick(instance: { providerId: string; accountId: string }, requested?: string, close = true) {
    if (pickPending || disabled) return;
    const owner = store;
    const generation = owner.clientGeneration;
    const navigation = owner.navigationGeneration;
    const epoch = ++pickEpoch;
    const apply = onpick;
    const current = () => mounted && epoch === pickEpoch && store === owner
      && owner.clientGeneration === generation && owner.navigationGeneration === navigation;
    pickPending = true;
    try {
      const provider = owner.providerOf(instance.providerId);
      if (!provider) return;
      const native = ['claude-sdk', 'acp', 'codex-appserver', 'muse', 'pi', 'agy'].includes(provider.protocol);
      if (native) await owner.probeModels(instance.providerId, instance.accountId);
      if (!current()) return;
      const models = owner.modelsOf(instance.providerId, instance.accountId);
      const preferred = owner.defaultModelOf(provider, instance.accountId);
      const model = requested ?? (models.some(entry => entry.id === preferred) ? preferred
        : models.find(entry => entry.default)?.id ?? models[0]?.id ?? null);
      if ((model !== null && !models.some(entry => entry.id === model)) || (native && models.length === 0)) {
        owner.error = strings.composer.favoriteUnavailable;
        return;
      }
      apply({ ...instance, model });
      if (close) popover.hide();
    } finally { if (epoch === pickEpoch) pickPending = false; }
  }

  function pickFavorite(entry: FavoriteModel) {
    return applyPick(entry, entry.model.id);
  }

  let provider = $derived(choice ? store.providerOf(choice.providerId) : null);
  let account = $derived(choice ? store.accountOf(choice.accountId) : null);
  /** A provider turned off has no column: the rail's first one shows instead. */
  const offered = (id: string | null | undefined) => (id && store.providerOn(id) ? store.providerOf(id) : null);
  let shown = $derived(offered(shownProviderId) ?? offered(provider?.id) ?? store.offeredProviders[0] ?? null);
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
  /** No answer yet for this instance: the descriptor's list would be replaced once it lands. */
  let pending = $derived(shown ? store.modelsPending(shown.id, shownAccountId) : false);

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
  // core reads it from one short-lived agent process. Reopening also refreshes
  // a catalog whose cached answer has expired.
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

  let currentModels = $derived(shownModels.filter((m) => !m.legacy));
  let legacyModels = $derived(shownModels.filter((m) => m.legacy));

  // An ACP agent can list hundreds of models (OpenCode answered 534 here), and a
  // plain scroll is useless at that length: group by the `provider/` prefix.
  let grouped = $derived(shownModels.length > SEARCH_FROM);
  let searchable = $derived(!favoritesOpen && !needsInstall);
  let words = $derived(
    searchable ? modelQuery.toLowerCase().split(/\s+/).filter((word) => word.length > 0) : []
  );

  function matches(model: ModelInfo): boolean {
    if (words.length === 0) return true;
    const hay = `${model.id} ${model.name}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  }

  /** A matching default stays above long lists; filtering never changes the selection. */
  let pinnedModel = $derived.by((): ModelInfo | null => {
    if (!grouped || !shown) return null;
    const id = store.defaultModelOf(shown);
    return shownModels.find((m) => m.id === id && matches(m)) ?? null;
  });

  let filteredCurrent = $derived(
    (words.length ? shownModels : currentModels).filter((m) => m.id !== pinnedModel?.id && matches(m))
  );
  let filteredLegacy = $derived(words.length ? [] : legacyModels);

  // Nothing typed on a long list: its first rows, the current model and a show-all row.
  let expandedFor = $state<string | null>(null);
  let capped = $derived(expandedFor !== shown?.id && words.length === 0 && filteredCurrent.length > FIRST_MODELS);
  let groups = $derived(groupModels(capped ? firstModels(filteredCurrent, isCurrentModel) : filteredCurrent));

  function isCurrentModel(model: ModelInfo): boolean {
    return shown !== null && choice?.providerId === shown.id && choice?.model === model.id;
  }

  // Desktop can type immediately. Phones keep their keyboard closed until tapped.
  $effect(() => {
    if (!popover.open || !searchable || window.matchMedia('(max-width: 720px)').matches) return;
    searchBox?.focus();
  });

  function toggle(event: MouseEvent) {
    event.stopPropagation();
    popover.toggle();
    if (popover.open) {
      shownProviderId = choice?.providerId ?? null;
      favoritesOpen = !single && favorites.length > 0;
      legacy.hide();
      modelQuery = '';
      expandedFor = null;
    }
  }

  /** A tile only moves the column: the choice follows a model or an account chip. */
  function pickTile(providerId: string) {
    pickEpoch += 1;
    pickPending = false;
    favoritesOpen = false;
    shownProviderId = providerId;
    legacy.hide();
    modelQuery = '';
  }

  function pickSeat(seat: Account) {
    if (!shown) return;
    modelQuery = '';
    return applyPick({ providerId: shown.id, accountId: seat.id }, undefined, false);
  }

  function pickModel(model: ModelInfo) {
    if (!shown) return;
    const instance =
      choice && choice.providerId === shown.id
        ? { providerId: choice.providerId, accountId: choice.accountId }
        : firstInstanceOf(shown.id);
    if (instance) return applyPick(instance, model.id);
  }

  /** Installing and signing in happen on the Providers page, so the picker sends you there. */
  function openInstall() {
    popover.hide();
    store.showSettings('accounts');
  }

  function firstInstanceOf(providerId: string): { providerId: string; accountId: string } | null {
    const entry = store.providerOf(providerId);
    if (!entry || !entry.available || !store.providerOn(providerId)) return null;
    const seat = store.accountsOf(providerId)[0];
    return seat ? { providerId, accountId: seat.id } : null;
  }

  const onkeydown = pickerKeydown({
    popover,
    legacy,
    root: () => root,
    menu: () => menu,
    searchBox: () => searchBox,
    legacyOpen: () => legacyOpen,
    searchable: () => searchable,
    modelQuery: () => modelQuery,
    clearQuery: () => { modelQuery = ''; }
  });

  function onWindowPointerdown(event: PointerEvent) {
    if (!popover.open) return;
    if (root && event.target instanceof Node && root.contains(event.target)) return;
    popover.hide();
  }
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

<div class="picker" bind:this={root}>
  {#if !choice && store.owner}
    <!-- Nothing to pick from yet: the chip is the way to get something. -->
    <button type="button" class="chip trigger connect" data-testid="composer-connect" onclick={() => store.openConnect()}>
      <Plug size={14} strokeWidth={1.75} />
      <span class="label ui-label">{strings.connect.button}</span>
    </button>
  {:else}
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
    <span class="label ui-label">{label}</span>
    <ChevronDown size={12} strokeWidth={2} />
  </button>
  {/if}

  {#if popover.shown}
    <div
      class="popover"
      class:closing={popover.closing}
      class:single
      role="menu"
      tabindex="-1"
      aria-label={strings.composer.picker}
        data-testid="composer-picker-menu"
      bind:this={menu}
      use:floating={{ anchor: () => root?.closest<HTMLElement>("[data-testid=composer]") ?? root ?? null, dismiss: () => popover.hide() }}
      use:popover.attach
      onanimationend={popover.end}
      {onkeydown}
    >
      <button class="refresh" type="button" data-testid="picker-refresh" aria-label={strings.composer.refreshModels} title={strings.composer.refreshModels} disabled={disabled || probing || pickPending || needsInstall} onclick={() => void refreshModels()}><RefreshCw size={14} class={probing || pickPending ? 'spin' : ''} /></button>
      {#if !single}
        <div class="column rail">
          <ProviderTiles {store} {choice} {locked} current={shown?.id ?? null} {favoritesOpen} onfavorites={() => { favoritesOpen = true; modelQuery = ''; }} onpick={pickTile} onmore={openInstall} />
        </div>
      {/if}

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
            disabled={disabled || pickPending}
            onclick={() => pickModel(model)}
          >
            <span class="mark"></span>
            <span class="name ui-label">{model.name}</span>
            {#if model.badge === 'new'}
              <span class="badge ui-label-box"><span class="ui-label">{strings.composer.newBadge}</span></span>
            {/if}
          </button>
          <button type="button" class="favorite-button" data-testid="model-favorite" data-favorite-model={model.id} aria-label={favorite(model) ? strings.composer.unfavorite : strings.composer.favorite} aria-pressed={favorite(model)} onclick={() => { if (shown && shownAccountId) store.toggleFavorite(shown.id, shownAccountId, model); }}><Star size={14} fill={favorite(model) ? 'currentColor' : 'none'} /></button>
          </div>
        {/snippet}

        {#if favoritesOpen}
          <div class="head"><span class="provider-name ui-label">{strings.composer.favorites}</span></div>
          <div class="model-list">
          {#each favorites as entry (`${entry.providerId}:${entry.accountId}:${entry.model.id}`)}
            <div class="model-entry">
              <button type="button" class="row model favorite-row" role="menuitem" data-row data-testid="favorite-model" disabled={disabled || pickPending || !store.providerOf(entry.providerId)?.available} onclick={() => void pickFavorite(entry)}>
                <ProviderLogo providerId={entry.providerId} size={16} /><span class="name">{store.modelsOf(entry.providerId, entry.accountId).find(m => m.id === entry.model.id)?.name ?? entry.model.name}{#if favorites.some(other => other.providerId === entry.providerId && other.model.id === entry.model.id && other.accountId !== entry.accountId)}<span class="account-label">{store.accountOf(entry.accountId)?.label}</span>{/if}</span>
              </button>
              <button type="button" class="favorite-button" aria-label={strings.composer.unfavorite} onclick={() => store.toggleFavorite(entry.providerId, entry.accountId, entry.model)}><Star size={14} fill="currentColor" /></button>
            </div>
          {:else}<p class="none subtle" data-testid="favorites-empty">{strings.composer.favoritesEmpty}</p>{/each}
          </div>
        {:else}
        <div class="head">
          <span class="provider-name ui-label">{shown ? shown.name : strings.composer.models}</span>
          <AccountSeats {shown} {seats} {shownAccountId} {choice} {locked} busy={disabled || pickPending} onpick={pickSeat} />
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
              <span class="ui-label">{strings.composer.installInSettings}</span>
            </button>
          {/if}
        {:else if pending}
          <!-- The first answer is on its way: the descriptor's list would jump
               to another one, so the column holds placeholders until it lands.
               The reading line comes first, where a short phone column still shows it. -->
          <p class="none subtle probing first" data-testid="picker-probing">{strings.composer.probing}</p>
          <div class="skeletons" aria-hidden="true">
            {#each [0, 1, 2] as index (index)}<span class="skeleton"></span>{/each}
          </div>
        {:else}
          <ModelSearch bind:value={modelQuery} bind:input={searchBox} />
          {#if grouped}
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
            {#if capped}
              <button type="button" class="row fold small" data-row data-testid="picker-show-all" onclick={() => { expandedFor = shown?.id ?? null; searchBox?.focus(); }}><span class="ui-label">{fill(strings.composer.showAllModels, { count: String(filteredCurrent.length) })}</span></button>
            {/if}
          {:else}
            {#each filteredCurrent as model (model.id)}
              {@render modelRow(model)}
            {/each}
          {/if}
          {#if !pinnedModel && filteredCurrent.length === 0 && (modelQuery.trim() !== '' || (shownModels.length === 0 && !probing))}
            <p class="none subtle" data-testid="picker-no-models">{shownModels.length === 0 ? strings.composer.noModelsAvailable : strings.composer.noModels}</p>
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
              <span class="name muted ui-label">{strings.composer.legacyModels}</span>
              <ChevronRight size={14} strokeWidth={2} />
            </button>
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
  {#if popover.shown && legacy.shown && !favoritesOpen && !pending && filteredLegacy.length > 0}
    <div class="popover legacy-menu" class:closing={legacy.closing} role="menu" tabindex="-1" data-testid="picker-legacy-menu" aria-label={strings.composer.legacyModels} use:legacy.attach onanimationend={legacy.end} use:floating={{ anchor: () => menu ?? null, side: 'right' }} {onkeydown}>
      <div class="column models">
        <div class="head"><button type="button" class="icon small legacy-back" aria-label={strings.settings.back} onclick={() => legacy.hide()}><ChevronRight size={14} style="transform: rotate(180deg)" /></button><span class="provider-name ui-label">{strings.composer.legacyModels}</span></div>
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
                    <span class="name ui-label">{model.name}</span>
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
    background: var(--control-glaze) var(--color-control-hover);
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
    grid-template-columns: calc(var(--control-lg) + 20px) minmax(0, 1fr);
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
    gap: 2px;
    padding: 4px;
    background: var(--color-surface);
  }

  .models > * { flex-shrink: 0; }
  .main-models { grid-area: 1 / 2 / 3 / 3; overflow: hidden; padding: 0; gap: 0; border-left: 1px solid var(--color-border); }
  .main-models .head { flex-direction: column; align-items: stretch; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--color-border); }
  .model-list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; padding: 6px; }
  .rail { grid-area: 1 / 1; }
  /* One provider: its model list is the whole popover, the refresh sits in the list's head. */
  /* No provider to switch to, so no height to hold steady: it is as tall as its models. */
  .popover.single { grid-template-columns: minmax(0, 1fr); width: min(320px, calc(100vw - 32px)); height: auto; }
  .single .main-models { grid-area: 1 / 1 / 3 / 2; border-left: none; }
  .single .main-models .head { padding-right: 44px; }
  .single .refresh { position: absolute; top: 6px; right: 6px; margin: 0; width: var(--control-sm); height: var(--control-sm); border: none; background: transparent; }
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

  .locked-note {
    padding: 0 4px 6px;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }

  .to-settings {
    align-self: flex-start;
    margin: 2px 0 0 4px;
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

  /* The agent is being asked for its models; on a refresh the listed ones stay above. */
  p.probing {
    margin-top: 2px;
    font-size: var(--text-sm);
  }
  p.probing.first { margin: 0 0 4px; }

  /* Placeholder rows while the first answer is read, the size of a model row. */
  .skeletons { display: flex; flex-direction: column; gap: 1px; }
  .skeleton {
    display: block;
    min-height: var(--row);
    margin: 0 8px;
    border-radius: var(--radius-sm);
    background: var(--color-hover);
    animation: skeleton-pulse calc(var(--dur-whip) * 3) var(--ease-out-quint) infinite alternate;
  }
  .skeleton:nth-child(2) { margin-right: 25%; }
  .skeleton:nth-child(3) { margin-right: 40%; }
  @keyframes skeleton-pulse { to { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }
  :global(html[data-motion='reduced']) .skeleton { animation: none; }

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

    /* The rail is the finger's first stop on a phone, so its tiles (ProviderTiles)
       and the refresh button take a full touch target like every other control. */
    .main-models { grid-area: 2 / 1 / 3 / 3; border-left: none; }
    .refresh { grid-area: 1 / 2; align-self: center; justify-self: end; justify-content: center; width: var(--touch-target); padding: 0; border: none; }
    .refresh {
      width: var(--touch-target);
      height: var(--touch-target);
    }
    .popover.single { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
    .single .main-models { grid-area: 1 / 1 / 2 / 2; }
    .single .main-models .head { padding-right: calc(var(--touch-target) + 8px); }
    .single .refresh { top: 0; right: 0; }
  }
</style>
