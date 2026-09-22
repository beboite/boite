<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { Plus, ArrowUpRight, RefreshCw, Unplug, X } from '@lucide/svelte';
  import { workspace, machineIcons } from '../lib/workspace.svelte';
  import { store as primary } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import MachineIcon from './MachineIcon.svelte';
  import RemoteCoordination from './RemoteCoordination.svelte';
  let { mobile = false }: { mobile?: boolean } = $props();
  let label = $state(''),
    link = $state(''),
    url = $state(''),
    token = $state('');
  let busy = $state(false);
  let origins = $state('');
  /** The add form stays folded behind its button, unless there is nothing else to show. */
  let adding = $state(false);
  let open = $derived(adding || workspace.machines.length === 0);
  /** The one card whose icon choices are unfolded. */
  let customizing = $state<string | null>(null);
  let linkInput = $state<HTMLInputElement | null>(null);
  $effect(() => {
    origins = (workspace.active.settings?.browserOrigins ?? []).join('\n');
  });
  function startAdding() {
    adding = true;
    requestAnimationFrame(() => linkInput?.focus());
  }
  function stopAdding() {
    adding = false;
    link = '';
    token = '';
    url = '';
    label = '';
  }
  async function add(manual = false) {
    if (busy) return;
    busy = true;
    try {
      const ok = manual
        ? await workspace.add({ url: url.trim(), token }, label)
        : await workspace.pair(link.trim(), label);
      if (ok) stopAdding();
    } finally {
      busy = false;
    }
  }
</script>

<div class="page machines-page" data-testid="machines-page">
  <header class="head">
    <div>
      <h1>{strings.machines.heading}<InfoTip topic={strings.machines.heading} text={strings.machines.intro} /></h1>
    </div>
    {#if !open}
      <button class="primary add-open" data-testid="machine-add-open" onclick={startAdding}><Plus size={15} />{strings.machines.add}</button>
    {/if}
  </header>

  <div class="reveal" class:open inert={!open}>
    <div>
      <section class="card add" data-testid="machine-add-card" aria-label={strings.machines.add}>
        <div class="add-head">
          <h2>{strings.machines.add}<InfoTip topic={strings.machines.add} text={strings.machines.addHint} /></h2>
          {#if workspace.machines.length > 0}
            <button class="ghost icon-only" data-testid="machine-add-close" aria-label={strings.common.cancel} title={strings.common.cancel} onclick={stopAdding}><X size={15} /></button>
          {/if}
        </div>
        <form
          onsubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label>{strings.machines.link}<input
              bind:this={linkInput}
              bind:value={link}
              data-testid="machine-link"
              type="password"
              autocomplete="off"
              spellcheck="false"
            /></label>
          <label>{strings.machines.labelOptional}<input bind:value={label} data-testid="machine-name" autocomplete="off" placeholder={strings.machines.labelPlaceholder} /></label>
          <button type="submit" class="primary" data-testid="machine-add" disabled={busy || !link.trim()}
            ><Plus size={14} />{busy ? strings.machines.adding : strings.machines.connect}</button
          >
        </form>
        <details class="disclosure">
          <summary>{strings.machines.manual}</summary>
          <form
            onsubmit={(e) => {
              e.preventDefault();
              void add(true);
            }}
          >
            <label>{strings.settings.coreUrl}<input bind:value={url} data-testid="machine-url" autocomplete="off" spellcheck="false" /></label>
            <label>{strings.settings.token}<input bind:value={token} data-testid="machine-token" type="password" autocomplete="off" /></label>
            <button class="primary" disabled={busy || !url.trim() || !token}
              >{busy ? strings.machines.adding : strings.machines.connect}</button
            >
          </form>
        </details>
        {#if workspace.error}<p class="error" role="alert">{workspace.error}</p>{/if}
      </section>
    </div>
  </div>

  <div class="machines">
    {#each workspace.machines as machine (machine.id)}
      <section class="card machine-card" data-testid="machine-card" data-machine-id={machine.id}>
        <div class="main">
          <button
            class="ghost logo"
            data-testid="machine-customize"
            aria-label={strings.machines.icon}
            title={strings.machines.icon}
            aria-expanded={customizing === machine.id}
            onclick={() => (customizing = customizing === machine.id ? null : machine.id)}
          ><MachineIcon icon={machine.icon} os={machine.store.core?.os} size={20} /></button>
          <div class="identity">
            <input class="machine-name" data-testid="machine-rename" aria-label={strings.machines.label} value={machine.label} maxlength="80" onchange={(event) => { workspace.customize(machine.id, event.currentTarget.value, machine.icon); event.currentTarget.value = machine.label; }} />
            <span class="meta">
              <span class="dot" class:ready={machine.store.connection === 'ready'} aria-hidden="true"></span>
              <span class="status" class:ready={machine.store.connection === 'ready'}>{strings.connection[machine.store.connection]}</span>
              <span class="address">{machine.store.localCore ? strings.machines.local : machine.id}</span>
            </span>
          </div>
          <div class="actions">
            {#if machine.store.connection === 'closed'}
              <button class="ghost icon-only" aria-label={strings.common.refresh} title={strings.common.refresh} onclick={() => void machine.store.connect()}><RefreshCw size={15} /></button>
            {/if}
            {#if machine.store !== primary}
              <button class="ghost icon-only" data-testid="machine-remove" aria-label={strings.machines.remove} title={strings.machines.remove} onclick={() => void workspace.remove(machine.id)}><Unplug size={15} /></button>
            {/if}
            <button class="ghost small" data-testid="machine-open" onclick={() => void workspace.select(machine.store)}
              >{strings.machines.open}<ArrowUpRight size={13} /></button
            >
          </div>
        </div>
        <div class="reveal" class:open={customizing === machine.id} inert={customizing !== machine.id}>
          <div>
            <div class="icon-choices" role="group" aria-label={strings.machines.icon}>
              {#each machineIcons as icon (icon)}
                <button class="ghost icon" class:chosen={machine.icon === icon} data-testid="machine-icon-{icon}" aria-label={strings.machines.icons[icon]} title={strings.machines.icons[icon]} aria-pressed={machine.icon === icon} onclick={() => workspace.customize(machine.id, machine.label, icon)}><MachineIcon {icon} size={17} /></button>
              {/each}
            </div>
          </div>
        </div>
        {#if machine.store.error}<p class="error">{machine.store.error}</p>{/if}
      </section>
    {/each}
  </div>

  {#if !mobile && workspace.machines.some(machine => machine.store.owner)}
    <RemoteCoordination />
  {/if}

  {#if workspace.active.owner && !mobile}
    <details class="card origins disclosure">
      <summary>{strings.machines.browserOrigins}</summary>
      <p class="hint">{strings.machines.browserOriginsHint}</p>
      <textarea bind:value={origins} aria-label={strings.machines.browserOrigins} rows="3"></textarea>
      <button
        onclick={() =>
          void workspace.active.saveSettings({
            browserOrigins: origins
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean)
          })}>{strings.settings.save}</button
      >
    </details>
  {/if}
</div>

<style>
  .machines-page {
    padding: 36px clamp(20px, 4vw, 64px);
  }
  .machines-page > :global(*) { max-width: var(--settings-width); }
  .machines-page > .reveal { margin-bottom: 20px; }
  .machines-page > .reveal:not(.open) { margin-bottom: 0; }
  .machines { margin-bottom: 20px; }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }
  h1 {
    font-size: var(--text-lg);
    margin: 0 0 8px;
  }
  h2 {
    font-size: var(--text-base);
    margin: 0;
  }
  .hint {
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    line-height: 1.6;
  }
  .add-open {
    flex: none;
    margin-top: 2px;
  }

  /* Folds on its row height, so a close animates as much as an open. */
  .reveal {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition: grid-template-rows var(--dur-3) var(--ease-out-quint), opacity var(--dur-2);
  }
  .reveal.open {
    grid-template-rows: 1fr;
    opacity: 1;
  }
  .reveal > div {
    overflow: hidden;
    min-height: 0;
  }

  .add {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .add-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
    margin-top: 6px;
  }

  .machines {
    display: grid;
    gap: 8px;
  }
  .machine-card {
    display: flex;
    flex-direction: column;
    padding: 12px 14px;
  }
  .main {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .logo {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border-radius: var(--radius-md);
    background: var(--color-surface-3);
    color: var(--color-muted-foreground);
    flex: none;
  }
  .logo:hover,
  .logo[aria-expanded='true'] {
    color: var(--color-foreground);
    box-shadow: inset 0 0 0 1px var(--color-edge);
  }
  .identity {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  /* A name that reads as a title until it is clicked. */
  .machine-name {
    width: 100%;
    height: var(--control-sm);
    padding: 0 6px;
    margin-left: -6px;
    font-weight: 600;
    background: transparent;
    border-color: transparent;
  }
  .machine-name:hover {
    border-color: var(--color-border);
  }
  .machine-name:focus {
    background: var(--color-surface-2);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--color-subtle);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-live);
    flex: none;
  }
  .dot.ready {
    background: var(--color-success);
  }
  .status {
    color: var(--color-live);
    flex: none;
  }
  .status.ready {
    color: var(--color-success);
  }
  .address {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .address::before {
    content: '·';
    margin-right: 6px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  .icon-only {
    width: var(--control);
    padding: 0;
    color: var(--color-muted-foreground);
  }
  .icon-choices {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 10px 0 2px 52px;
  }
  .icon-choices .chosen {
    color: var(--color-foreground);
    background: var(--color-surface-3);
    box-shadow: inset 0 0 0 1px var(--color-border);
  }

  .origins {
    padding: 14px 20px;
  }
  .origins summary {
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }
  .origins[open] summary {
    margin-bottom: 10px;
    color: var(--color-foreground);
  }
  textarea {
    display: block;
    width: 100%;
    margin: 12px 0;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
  }
  input {
    width: 100%;
  }
  details:not(.origins) {
    margin-top: 8px;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }
  summary {
    cursor: pointer;
  }
  .error {
    color: var(--color-danger);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
    margin-top: 8px;
  }
  @media (prefers-reduced-motion: reduce) {
    .reveal {
      transition: none;
    }
  }
  @media (max-width: 720px) {
    .machines-page {
      padding: 16px;
    }
    .head {
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
    }
    .add-open {
      width: 100%;
      min-height: var(--touch-target);
    }
    .main {
      flex-wrap: wrap;
    }
    .identity {
      flex-basis: calc(100% - 52px);
    }
    .actions {
      width: 100%;
      justify-content: flex-end;
    }
    .icon-choices {
      padding-left: 0;
    }
  }
</style>
