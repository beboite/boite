<script lang="ts">
  import { paneStore, countLeaves } from "./store.svelte";
  import type { LayoutNode, PaneGroup } from "./types";
  import { MIN_PANE_PX, MIN_RATIO, SPLITTER_PX } from "./types";
  import PaneHeader, { headerId } from "./PaneHeader.svelte";
  import PaneContentView from "./PaneContentView.svelte";
  import { t } from "$lib/i18n/index.svelte";

  type Props = { group: PaneGroup };
  let { group }: Props = $props();

  const multi = $derived(countLeaves(group.root) > 1);

  // The rect is the pane's BODY, not the pane: a thread's terminal is positioned
  // over this rectangle from the page, and including the header would slide
  // every terminal up under its own title bar.
  function measure(el: HTMLElement, paneId: string) {
    let observer: ResizeObserver | null = null;
    let frame: number | null = null;
    let currentId = paneId;

    const update = () => {
      frame = null;
      const root = el.closest("[data-pane-viewport]") as HTMLElement | null;
      if (!root) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const rRoot = root.getBoundingClientRect();
      paneStore.setRect(currentId, {
        x: r.left - rRoot.left,
        y: r.top - rRoot.top,
        w: r.width,
        h: r.height,
      });
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(update);
    };

    observer = new ResizeObserver(schedule);
    observer.observe(el);
    // Straight away, not on the next frame. The element is in the document by
    // the time an action runs, so its box is one forced layout away — and this
    // measurement is what lets the terminal mount, so deferring it cost a frame
    // of black pane on every thread that opened.
    update();
    window.addEventListener("resize", schedule);

    return {
      update(next: string) {
        if (next === currentId) return;
        // The previous id's rect described this box, and this box is about to
        // describe someone else. Leaving it behind is what let a drop match a
        // pane that had moved on.
        paneStore.clearRect(currentId);
        currentId = next;
        schedule();
      },
      destroy() {
        if (frame !== null) cancelAnimationFrame(frame);
        paneStore.clearRect(currentId);
        observer?.disconnect();
        window.removeEventListener("resize", schedule);
      },
    };
  }

  function startDrag(
    splitId: string,
    index: number,
    dir: "row" | "column",
    el: HTMLElement,
    e: PointerEvent,
  ) {
    e.preventDefault();
    const parent = el.parentElement as HTMLElement | null;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const nodeAtSplit = findSplit(group.root, splitId);
    if (!nodeAtSplit) return;
    // The ratios only share out what is left after the splitters, so measuring
    // against the full parent made every delta short by SPLITTER_PX*(n-1)/total:
    // the divider lagged behind the cursor, and the gap grew with the pane count.
    const gutters = SPLITTER_PX * (nodeAtSplit.children.length - 1);
    const total = (dir === "row" ? parentRect.width : parentRect.height) - gutters;
    if (total <= 0) return;
    // Ratios are flex-grow values, so they are proportional rather than
    // normalised; the pixel width of one cell is total * ratio / ratioTotal.
    const ratioTotal = nodeAtSplit.ratios.reduce((sum, r) => sum + r, 0) || 1;
    const startRatios = [...nodeAtSplit.ratios];
    const startCoord = dir === "row" ? e.clientX : e.clientY;
    el.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const coord = dir === "row" ? ev.clientX : ev.clientY;
      const delta = (coord - startCoord) / total;
      let a = startRatios[index] + delta;
      let b = startRatios[index + 1] - delta;
      // Whichever floor bites first: the fraction, or the pixel width below which
      // a terminal stops being readable. A ratio r takes total*r/allRatios pixels,
      // so the pixel floor in ratio terms is MIN_PANE_PX*allRatios/total. Capped
      // at half the pair's share, or a narrow window would pin the divider.
      const pairSum = startRatios[index] + startRatios[index + 1];
      const min = Math.min(
        Math.max(MIN_RATIO, (MIN_PANE_PX * ratioTotal) / total),
        pairSum / 2,
      );
      if (a < min) {
        b -= min - a;
        a = min;
      }
      if (b < min) {
        a -= min - b;
        b = min;
      }
      const ratios = [...startRatios];
      ratios[index] = a;
      ratios[index + 1] = b;
      paneStore.setRatios(group.id, splitId, ratios);
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  function findSplit(
    node: LayoutNode,
    splitId: string,
  ): Extract<LayoutNode, { kind: "split" }> | null {
    if (node.kind === "leaf") return null;
    if (node.id === splitId) return node;
    for (const c of node.children) {
      const r = findSplit(c, splitId);
      if (r) return r;
    }
    return null;
  }
</script>

{#snippet renderNode(node: LayoutNode)}
  {#if node.kind === "leaf"}
    {@const isThread = node.content.kind === "thread"}
    <!-- A terminal alone in its group grows no chrome: the sidebar already names
         it. Anything else needs its header, if only for the close button. -->
    {@const showHeader = multi || !isThread}
    <!-- Named by its own header when it has one, which is how a screen reader
         says which pane it just entered. The rail this replaced was a tablist
         whose body carried aria-labelledby; panes are not tabs (they are all on
         screen at once), so the same job is done with a labelled group. -->
    <div
      class="pane-leaf"
      data-pane-leaf={node.paneId}
      role={showHeader ? "group" : undefined}
      aria-labelledby={showHeader ? headerId(node.paneId) : undefined}
    >
      {#if showHeader}
        <PaneHeader
          paneId={node.paneId}
          content={node.content}
          groupId={group.id}
          focused={group.focusedPaneId === node.paneId}
          closable={!isThread || multi}
        />
      {/if}
      <!-- Measured whether or not anything is drawn inside it: for a thread the
           terminal arrives from the page as an absolutely positioned overlay,
           and this rectangle is the only thing that tells it where to go. -->
      <div class="pane-body" use:measure={node.paneId}>
        {#if !isThread}
          <PaneContentView content={node.content} projectId={group.projectId} />
        {/if}
      </div>
    </div>
  {:else}
    <div class="pane-split" class:row={node.dir === "row"} class:column={node.dir === "column"}>
      {#each node.children as child, i (child.kind === "leaf" ? child.paneId : child.id)}
        <div class="pane-cell" style:flex={node.ratios[i]}>
          {@render renderNode(child)}
        </div>
        {#if i < node.children.length - 1}
          <button
            type="button"
            class="splitter"
            class:row={node.dir === "row"}
            class:column={node.dir === "column"}
            aria-label={t("panes.resize")}
            onpointerdown={(e) => startDrag(node.id, i, node.dir, e.currentTarget, e)}
          ></button>
        {/if}
      {/each}
    </div>
  {/if}
{/snippet}

<div class="pane-shell-root">
  {@render renderNode(group.root)}
</div>

<style>
  /* Nothing between the viewport and a lone leaf: no padding, no border, no
     gap. `unmeasuredRect` places that leaf at 0,0 over the whole viewport
     before anything has been measured, and an inset of any kind here would make
     the first frame the wrong size — the terminal would fit itself twice, once
     against a rect that was never true. */
  .pane-shell-root {
    width: 100%;
    height: 100%;
    display: flex;
    padding: 0;
    border: 0;
    gap: 0;
  }
  .pane-shell-root > :global(*) {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .pane-leaf {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    padding: 0;
    border: 0;
    margin: 0;
  }
  .pane-body {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .pane-split {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }
  .pane-split.row {
    flex-direction: row;
  }
  .pane-split.column {
    flex-direction: column;
  }
  .pane-cell {
    min-width: 0;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }
  .pane-cell > :global(*) {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .splitter {
    position: relative;
    flex: 0 0 4px;
    align-self: stretch;
    border: 0;
    padding: 0;
    background: transparent;
    cursor: col-resize;
    transition: background var(--dur-1) var(--ease-out-quint);
    touch-action: none;
  }
  /* Same 6px-per-side grab area the sidebar and side-panel handles use, grown
     into the gutter rather than over the terminals on either side. */
  .splitter::after {
    content: "";
    position: absolute;
    inset: 0 -3px;
  }
  .splitter.column::after {
    inset: -3px 0;
  }
  .splitter.column {
    cursor: row-resize;
  }
  .splitter:hover,
  .splitter:active {
    background: var(--color-border-strong);
  }
</style>
