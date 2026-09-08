<script lang="ts">
  import { ChevronDown, ChevronRight, Search, Sparkles } from '@lucide/svelte';
  import type { Account, ModelInfo, ProviderInstallState, ProviderSummary } from '@boite/contracts';
  import InstallControl from './InstallControl.svelte';
  import { strings } from '../lib/strings';
  import type { Choice, PickPatch, Store } from '../lib/store.svelte';

  /**
   * T3 Code's picker: providers and their accounts on the left, the models of
   * the highlighted one on the right. One click on an account switches to it
   * with its default model; one click on a model closes the picker.
   */
  let {
    store,
    choice,
    locked = false,
    onpick
  }: {
    store: Store;
    choice: Choice | null;
    /** A thread keeps its provider and account; only the model may change. */
    locked?: boolean;
    onpick: (patch: PickPatch) => void;
  } = $props();

  /** Past this many models the column stops being a plain scroll and gets a search field. */
  const SEARCH_FROM = 12;

  let open = $state(false);
  let legacyOpen = $state(false);
  let root = $state<HTMLDivElement | undefined>(undefined);
  let searchBox = $state<HTMLInputElement | undefined>(undefined);
  /** What the model column is filtered on; empty while the list is short. */
  let modelQuery = $state('');
  /** The provider whose models the right column shows: the choice's until another account is clicked. */
  let shownProviderId = $state<string | null>(null);

  interface Row {
    provider: ProviderSummary;
    account: Account | null;
    disabled: boolean;
    hint: string | null;
    /** Set on the one row a provider gets while its files are still to download. */
    install: ProviderInstallState | null;
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
  let shownModels = $derived(shown ? store.modelsOf(shown.id, shownAccountId) : []);
  let probing = $derived(shown ? store.isProbing(shown.id, shownAccountId) : false);

  // An ACP agent owns its model list, so the descriptor cannot carry it: the
  // core reads it from one short-lived agent process the first time the picker
  // shows that instance, and the answer stands for the rest of the session.
  $effect(() => {
    if (!open || !shown || (shown.protocol !== 'acp' && shown.protocol !== 'codex-appserver' && shown.protocol !== 'pi'))
      return;
    const accountId = shownAccountId;
    if (accountId === null) return;
    void store.probeModels(shown.id, accountId);
  });

  let label = $derived.by(() => {
    if (!choice || !provider) return strings.composer.noProvider;
    const model = store.modelsOf(provider.id, choice.accountId).find((m) => m.id === choice.model);
    const name = model?.name ?? provider.name;
    const level = model?.effort?.levels.find((l) => l.id === choice.effort);
    // The default level is what the model does anyway, so only a change is worth the room.
    const withEffort = level && level.id !== model?.effort?.default ? `${name} · ${level.label}` : name;
    const siblings = store.accountsOf(provider.id);
    return siblings.length > 1 && account ? `${withEffort} · ${account.label}` : withEffort;
  });

  let rows = $derived.by((): Row[] => {
    const out: Row[] = [];
    const ordered = [...store.providers].sort((a, b) => Number(b.available) - Number(a.available));
    for (const entry of ordered) {
      // A provider whose release is not on the machine yet gets one row with the
      // download in it, whatever accounts it has: nothing can run until it lands.
      const install = store.installOf(entry.id);
      if (install !== null && install.state !== 'installed') {
        out.push({ provider: entry, account: null, disabled: true, hint: null, install });
        continue;
      }
      const accounts = store.accountsOf(entry.id);
      if (accounts.length === 0) {
        out.push({ provider: entry, account: null, disabled: true, hint: strings.composer.noAccount, install: null });
        continue;
      }
      for (const acc of accounts) {
        const same = choice?.providerId === entry.id && choice?.accountId === acc.id;
        const hints: string[] = [];
        if (!entry.available) hints.push(strings.composer.unavailable);
        if (acc.status === 'unauthenticated') hints.push(strings.accounts.status.unauthenticated);
        out.push({
          provider: entry,
          account: acc,
          disabled: !entry.available || (locked && !same),
          hint: hints.join(', ') || null,
          install: null
        });
      }
    }
    return out;
  });

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

  /** The Reasoning row belongs to the model the choice is on, legacy ones included. */
  let effortModel = $derived.by((): ModelInfo | null => {
    if (!shown || !choice || choice.providerId !== shown.id) return null;
    return shownModels.find((m) => m.id === choice.model && m.effort) ?? null;
  });
  let effortLevels = $derived(effortModel?.effort?.levels ?? []);
  let activeEffort = $derived(choice?.effort ?? effortModel?.effort?.default ?? null);

  function isCurrentInstance(row: Row): boolean {
    return row.account !== null && choice?.providerId === row.provider.id && choice?.accountId === row.account.id;
  }

  function isCurrentModel(model: ModelInfo): boolean {
    return shown !== null && choice?.providerId === shown.id && choice?.model === model.id;
  }

  // A column that opens on a long list is a column you are about to type in.
  $effect(() => {
    if (!open || !searchable) return;
    searchBox?.focus();
  });

  function toggle(event: MouseEvent) {
    event.stopPropagation();
    open = !open;
    if (open) {
      shownProviderId = choice?.providerId ?? null;
      legacyOpen = false;
      modelQuery = '';
    }
  }

  function pickInstance(row: Row) {
    if (row.disabled || !row.account) return;
    shownProviderId = row.provider.id;
    modelQuery = '';
    if (isCurrentInstance(row)) return;
    onpick({ providerId: row.provider.id, accountId: row.account.id, model: store.defaultModelOf(row.provider) });
  }

  function pickModel(model: ModelInfo) {
    if (!shown) return;
    const instance =
      choice && choice.providerId === shown.id
        ? { providerId: choice.providerId, accountId: choice.accountId }
        : firstInstanceOf(shown.id);
    if (!instance) return;
    onpick({ ...instance, model: model.id });
    open = false;
  }

  /** The popover stays open: an effort is a setting of the model just picked, not a choice of its own. */
  function pickEffort(id: string) {
    if (id === activeEffort) return;
    onpick({ effort: id });
  }

  function firstInstanceOf(providerId: string): { providerId: string; accountId: string } | null {
    const row = rows.find((r) => r.provider.id === providerId && r.account && !r.disabled);
    return row && row.account ? { providerId, accountId: row.account.id } : null;
  }

  function focusable(): HTMLElement[] {
    return root ? Array.from(root.querySelectorAll<HTMLElement>('.popover [data-row]:not(:disabled)')) : [];
  }

  /** The model rows alone: what the arrows walk once the search field has the focus. */
  function modelRows(): HTMLElement[] {
    return root ? Array.from(root.querySelectorAll<HTMLElement>('.popover .models [data-row]:not(:disabled)')) : [];
  }

  function onkeydown(event: KeyboardEvent) {
    if (!open) return;
    const active = document.activeElement as HTMLElement | null;
    const searching = searchable && (active === searchBox || (active?.hasAttribute('data-model') ?? false));

    if (event.key === 'Escape') {
      event.stopPropagation();
      // The query goes first: closing on it would throw away what was just typed.
      if (searchable && modelQuery !== '') {
        modelQuery = '';
        searchBox?.focus();
        return;
      }
      open = false;
      return;
    }
    if (event.key === 'Enter' && searching) {
      // A focused row is activated by the browser too; taking the default keeps it to one pick.
      event.preventDefault();
      const row = active === searchBox ? modelRows()[0] : active;
      row?.click();
      return;
    }
    if (searching && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const list = modelRows();
      const here = active === searchBox || !active ? -1 : list.indexOf(active);
      if (event.key === 'ArrowDown') list[Math.min(here + 1, list.length - 1)]?.focus();
      else if (here <= 0) searchBox?.focus();
      else list[here - 1]?.focus();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const steps = root ? Array.from(root.querySelectorAll<HTMLElement>('.popover [data-effort]')) : [];
      const here = steps.indexOf(document.activeElement as HTMLElement);
      if (here === -1) return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      steps[(here + step + steps.length) % steps.length]?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const list = focusable();
    if (list.length === 0) return;
    event.preventDefault();
    const index = active ? list.indexOf(active) : -1;
    const next = event.key === 'ArrowDown' ? (index + 1) % list.length : (index - 1 + list.length) % list.length;
    list[next]?.focus();
  }

  function onWindowPointerdown(event: PointerEvent) {
    if (!open) return;
    if (root && event.target instanceof Node && root.contains(event.target)) return;
    open = false;
  }
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

<div class="picker" bind:this={root}>
  <button
    type="button"
    class="chip trigger"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={strings.composer.picker}
    title={locked ? strings.composer.lockedHint : strings.composer.picker}
    data-testid="composer-picker"
    onclick={toggle}
    {onkeydown}
  >
    <Sparkles size={13} strokeWidth={1.75} />
    <span class="label">{label}</span>
    <ChevronDown size={12} strokeWidth={2} />
  </button>

  {#if open}
    <div class="popover" role="menu" tabindex="-1" aria-label={strings.composer.picker} data-testid="composer-picker-menu" {onkeydown}>
      <div class="column instances">
        <span class="section-label head">{strings.composer.providers}</span>
        {#each rows as row (row.account ? `${row.provider.id}::${row.account.id}` : row.provider.id)}
          {#if row.account}
            <button
              type="button"
              class="row"
              class:current={isCurrentInstance(row)}
              disabled={row.disabled}
              role="menuitem"
              data-row
              data-instance="{row.provider.id}::{row.account.id}"
              title={row.disabled && locked ? strings.composer.lockedHint : row.account.identity ?? undefined}
              onclick={() => pickInstance(row)}
            >
              <span class="mark"></span>
              <span class="text">
                <span class="name">{row.provider.name}</span>
                <span class="sub">{row.hint ?? row.account.label}</span>
              </span>
            </button>
          {:else if row.install}
            <div class="row managed" data-instance="{row.provider.id}::">
              <span class="mark"></span>
              <span class="text">
                <span class="name">{row.provider.name}</span>
              </span>
              <InstallControl {store} provider={row.provider} />
            </div>
          {:else}
            <div class="row none" data-instance="{row.provider.id}::">
              <span class="mark"></span>
              <span class="text">
                <span class="name">{row.provider.name}</span>
                <span class="sub">{row.hint}</span>
              </span>
            </div>
          {/if}
        {/each}
      </div>

      <div class="column models">
        {#snippet modelRow(model: ModelInfo)}
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
        {/snippet}

        <span class="section-label head">{shown ? shown.name : strings.composer.models}</span>

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
            class="row fold"
            data-row
            data-testid="picker-legacy"
            aria-expanded={legacyOpen}
            onclick={() => (legacyOpen = !legacyOpen)}
          >
            <span class="caret" class:open={legacyOpen}><ChevronRight size={12} strokeWidth={2} /></span>
            <span class="name muted">{strings.composer.legacyModels}</span>
            <span class="count">{filteredLegacy.length}</span>
          </button>
          {#if legacyOpen}
            {#each filteredLegacy as model (model.id)}
              <button
                type="button"
                class="row model legacy"
                class:current={isCurrentModel(model)}
                role="menuitem"
                data-row
                data-model={model.id}
                onclick={() => pickModel(model)}
              >
                <span class="mark"></span>
                <span class="name">{model.name}</span>
              </button>
            {/each}
          {/if}
        {/if}
        {#if shown && shownModels.length === 0 && !probing}
          <p class="none subtle">{strings.thread.defaultModel}</p>
        {/if}
        {#if probing}
          <p class="none subtle probing" data-testid="picker-probing">{strings.composer.probing}</p>
        {/if}

        {#if effortLevels.length > 0}
          <div class="effort" data-testid="picker-effort">
            <span class="section-label">{strings.composer.reasoning}</span>
            <div class="steps" role="group" aria-label={strings.composer.reasoning}>
              {#each effortLevels as level (level.id)}
                <button
                  type="button"
                  class="step"
                  data-effort={level.id}
                  aria-pressed={level.id === activeEffort}
                  title={level.description ?? level.label}
                  onclick={() => pickEffort(level.id)}
                >
                  {level.label}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
    display: inline-flex;
    min-width: 0;
  }

  .trigger {
    cursor: pointer;
    height: 24px;
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
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 40;
    display: grid;
    grid-template-columns: 200px minmax(220px, 1fr);
    width: min(520px, calc(100vw - 32px));
    max-height: 340px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-e2);
    animation: pop var(--dur-2) var(--ease-out-quint);
    transform-origin: bottom left;
    overflow: hidden;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px;
    min-height: 0;
    overflow: auto;
  }

  .instances {
    border-right: 1px solid var(--color-border);
    background: var(--color-surface);
  }

  .head {
    padding: 4px 8px 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    height: 28px;
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
    min-height: 30px;
    padding: 3px 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-foreground);
    text-align: left;
    white-space: normal;
  }

  .row:hover:not(:disabled):not(.none),
  .row:focus-visible {
    background: var(--color-surface-3);
    outline: none;
  }

  .row:active:not(:disabled) {
    transform: none;
  }

  .row:disabled,
  .row.none {
    opacity: 0.5;
    cursor: default;
  }

  /* The download is the row's point, so it keeps full contrast and a line of its
     own under the name: a bar squeezed beside it would cross the provider name. */
  .row.managed {
    flex-wrap: wrap;
    row-gap: 5px;
    padding-bottom: 6px;
    cursor: default;
  }

  .row.managed .text {
    flex: 1 0 auto;
  }

  .row.managed :global(.install) {
    flex: 1 0 100%;
    padding-left: 14px;
    justify-content: flex-start;
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

  .text {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
  }

  .name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub {
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
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
    font-size: 10px;
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
    min-height: 26px;
  }

  .caret {
    display: inline-flex;
    width: 6px;
    justify-content: center;
    color: var(--color-subtle);
    transition: transform var(--dur-2) var(--ease-out-quint);
  }

  .caret.open {
    transform: rotate(90deg);
  }

  .count {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--color-subtle);
    font-variant-numeric: tabular-nums;
  }

  p.none {
    padding: 6px 8px;
    font-size: var(--text-sm);
  }

  /* The agent is being asked for its models; the descriptor's stay above. */
  p.probing {
    margin-top: 2px;
    font-size: var(--text-xs);
  }

  .effort {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
    padding: 8px 8px 2px;
    border-top: 1px solid var(--color-border);
  }

  .steps {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }

  .step {
    flex: 1 1 auto;
    min-height: 22px;
    padding: 2px 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-weight: 500;
    white-space: nowrap;
    transition:
      background var(--dur-2) var(--ease-out-quint),
      color var(--dur-2) var(--ease-out-quint);
  }

  .step:hover,
  .step:focus-visible {
    background: var(--color-surface-3);
    color: var(--color-foreground);
    outline: none;
  }

  .step[aria-pressed='true'] {
    background: var(--color-surface-3);
    color: var(--color-foreground);
    box-shadow: var(--shadow-e1);
  }

  @media (max-width: 720px) {
    .popover {
      grid-template-columns: 1fr;
      max-height: 60vh;
    }

    .instances {
      border-right: none;
      border-bottom: 1px solid var(--color-border);
      max-height: 40%;
    }
  }
</style>
