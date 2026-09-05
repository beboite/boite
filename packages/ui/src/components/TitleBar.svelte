<script lang="ts">
  import { Minus, Square, X } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import BoiteMark from './BoiteMark.svelte';

  let { store }: { store: Store } = $props();

  async function windowOf() {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow();
  }

  async function minimize() {
    await (await windowOf()).minimize();
  }

  async function maximize() {
    await (await windowOf()).toggleMaximize();
  }

  /** The shell turns this into a hide to the tray. */
  async function close() {
    await (await windowOf()).close();
  }

  let title = $derived(store.openProject?.name ?? strings.app.name);
</script>

<header class="titlebar" data-tauri-drag-region>
  <div class="left" data-tauri-drag-region>
    <BoiteMark size={16} />
    <span class="state {store.connection}" title={strings.connection[store.connection]}></span>
  </div>
  <div class="center" data-tauri-drag-region>{title}</div>
  <div class="controls">
    <button type="button" class="ctl" aria-label={strings.titlebar.minimize} onclick={() => void minimize()}>
      <Minus size={14} strokeWidth={1.75} />
    </button>
    <button type="button" class="ctl" aria-label={strings.titlebar.maximize} onclick={() => void maximize()}>
      <Square size={11} strokeWidth={1.75} />
    </button>
    <button type="button" class="ctl close" aria-label={strings.titlebar.close} onclick={() => void close()}>
      <X size={15} strokeWidth={1.75} />
    </button>
  </div>
</header>

<style>
  .titlebar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    height: var(--titlebar);
    background: var(--color-titlebar);
    border-bottom: 1px solid var(--color-border);
    user-select: none;
    -webkit-user-select: none;
    flex: none;
  }

  .left {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-left: 12px;
    height: 100%;
  }

  .state {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-subtle);
  }

  .state.ready {
    background: var(--color-success);
  }

  .state.connecting {
    background: var(--color-live);
    animation: pulse 1.6s ease-in-out infinite;
  }

  .state.closed {
    background: var(--color-danger);
  }

  .center {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-muted-foreground);
    height: 100%;
    display: flex;
    align-items: center;
  }

  .controls {
    display: flex;
    justify-content: flex-end;
    height: 100%;
  }

  .ctl {
    width: 44px;
    height: 100%;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--color-muted-foreground);
  }

  .ctl:hover:not(:disabled) {
    background: var(--color-surface-3);
    color: var(--color-foreground);
  }

  .ctl:active:not(:disabled) {
    transform: none;
  }

  .ctl.close:hover:not(:disabled) {
    background: var(--color-danger);
    color: #ffffff;
  }
</style>
