<script lang="ts">
  import { onMount } from 'svelte';
  import type { Window as TauriWindow } from '@tauri-apps/api/window';
  import { windowsShell } from '../lib/shell-platform';

  const windows = windowsShell();
  type ResizeDirection = Parameters<TauriWindow['startResizeDragging']>[0];
  const directions: ResizeDirection[] = ['North', 'NorthEast', 'East', 'SouthEast', 'South', 'SouthWest', 'West', 'NorthWest'];
  let win: TauriWindow | undefined;
  let resizable = $state(false);

  onMount(() => {
    if (!windows) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    let updating = false;
    let pending = false;
    async function update() {
      if (updating) { pending = true; return; }
      updating = true;
      try {
        do {
          pending = false;
          const [maximized, fullscreen] = await Promise.all([win!.isMaximized(), win!.isFullscreen()]);
          if (!disposed) resizable = !maximized && !fullscreen;
        } while (pending && !disposed);
      } catch (error) {
        resizable = false;
        console.warn('Cannot read desktop window state', error);
      } finally { updating = false; }
    }
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      if (disposed) return;
      win = getCurrentWindow();
      stop = await win.onResized(update);
      if (disposed) { stop(); return; }
      await update();
    }).catch(error => console.warn('Cannot initialize desktop resize handles', error));
    return () => { disposed = true; stop?.(); };
  });

  function resize(event: MouseEvent, direction: ResizeDirection) {
    if (event.button !== 0 || !resizable || !win) return;
    event.preventDefault();
    event.stopPropagation();
    void win.startResizeDragging(direction).catch(error => console.warn('Cannot resize desktop window', error));
  }
</script>

<!-- Windows 10 has no non-client frame when shadow(false) removes its grey
     border. WebView2 receives the edge clicks, so forward them to the native
     resize loop, which retains Windows' constraints, snapping and DPI rules. -->
{#if resizable}
  {#each directions as direction}
    <div class="resize-handle" class:west={direction.includes('West')} class:east={direction.includes('East')}
      class:north={direction.includes('North')} class:south={direction.includes('South')}
      role="presentation" aria-hidden="true" data-resize-direction={direction}
      onmousedown={(event) => resize(event, direction)}></div>
  {/each}
{/if}

<style>
  .resize-handle { position: fixed; z-index: var(--z-window-resize); }
  .north { top: 0; height: var(--window-resize-edge); cursor: ns-resize; }
  .south { bottom: 0; height: var(--window-resize-edge); cursor: ns-resize; }
  .west { left: 0; width: var(--window-resize-edge); cursor: ew-resize; }
  .east { right: 0; width: var(--window-resize-edge); cursor: ew-resize; }
  .north:not(.west, .east), .south:not(.west, .east) { left: var(--window-resize-corner); right: var(--window-resize-corner); }
  .west:not(.north, .south), .east:not(.north, .south) { top: var(--window-resize-corner); bottom: var(--window-resize-corner); }
  .north.west, .north.east, .south.west, .south.east { width: var(--window-resize-corner); height: var(--window-resize-corner); }
  /* Caption buttons keep their complete hit areas, including a throw into
     the top-right corner to close. The northeast grip sits beside the group. */
  .north:not(.west, .east) { right: calc(3 * var(--caption) + var(--window-resize-corner)); }
  .north.east { right: calc(3 * var(--caption)); }
  .east:not(.north, .south) { top: var(--titlebar); }
  .north.west, .south.east { cursor: nwse-resize; }
  .north.east, .south.west { cursor: nesw-resize; }
</style>
