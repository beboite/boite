<script lang="ts">
  import { paneStore } from "./store.svelte";
  import type { LayoutNode, PaneGroup } from "./types";
  import { MIN_PANE_PX, MIN_RATIO, SPLITTER_PX } from "./types";
  import PaneContentView from "./PaneContentView.svelte";
  import { paneLabel } from "./label";
  import { findSplit } from "./tree";
  import { t } from "$lib/i18n/index.svelte";

  type Props = { group: PaneGroup };
  let { group }: Props = $props();

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

  // What an arrow key moves the divider by, and what Shift moves it by. A
  // divider that can only be dragged cannot be moved at all without a pointer,
  // which is what `tabindex="-1"` on every handle in the app used to admit.
  const STEP_PX = 24;
  const BIG_STEP_PX = 96;

  /**
   * The two ratios either side of a splitter once it has moved by `delta`.
   *
   * Whichever floor bites first: the fraction, or the pixel width below which a
   * terminal stops being readable. A ratio r takes total*r/allRatios pixels, so
   * the pixel floor in ratio terms is MIN_PANE_PX*allRatios/total. Capped at
   * half the pair's share, or a narrow window would pin the divider.
   */
  function movedPair(
    ratios: readonly number[],
    index: number,
    delta: number,
    total: number,
    ratioTotal: number,
  ): [number, number] {
    let a = ratios[index] + delta;
    let b = ratios[index + 1] - delta;
    const pairSum = ratios[index] + ratios[index + 1];
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
    return [a, b];
  }

  /** The parent's usable length, gutters taken off, or 0 when it has none. */
  function splitTotal(
    nodeAtSplit: { children: readonly unknown[] },
    dir: "row" | "column",
    parent: HTMLElement,
  ): number {
    const parentRect = parent.getBoundingClientRect();
    // The ratios only share out what is left after the splitters, so measuring
    // against the full parent made every delta short by SPLITTER_PX*(n-1)/total:
    // the divider lagged behind the cursor, and the gap grew with the pane count.
    const gutters = SPLITTER_PX * (nodeAtSplit.children.length - 1);
    return (dir === "row" ? parentRect.width : parentRect.height) - gutters;
  }

  function nudge(
    splitId: string,
    index: number,
    dir: "row" | "column",
    el: HTMLElement,
    px: number,
  ) {
    const parent = el.parentElement as HTMLElement | null;
    const nodeAtSplit = findSplit(group.root, splitId);
    if (!parent || !nodeAtSplit) return;
    const total = splitTotal(nodeAtSplit, dir, parent);
    if (total <= 0) return;
    const ratioTotal = nodeAtSplit.ratios.reduce((sum, r) => sum + r, 0) || 1;
    const ratios = [...nodeAtSplit.ratios];
    const [a, b] = movedPair(ratios, index, px / total, total, ratioTotal);
    ratios[index] = a;
    ratios[index + 1] = b;
    paneStore.setRatios(group.id, splitId, ratios);
  }

  function splitterKeydown(
    splitId: string,
    index: number,
    dir: "row" | "column",
    e: KeyboardEvent,
  ) {
    const back = dir === "row" ? "ArrowLeft" : "ArrowUp";
    const forward = dir === "row" ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    const step = e.shiftKey ? BIG_STEP_PX : STEP_PX;
    nudge(splitId, index, dir, e.currentTarget as HTMLElement, e.key === forward ? step : -step);
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
    const nodeAtSplit = findSplit(group.root, splitId);
    if (!nodeAtSplit) return;
    const total = splitTotal(nodeAtSplit, dir, parent);
    if (total <= 0) return;
    // Ratios are flex-grow values, so they are proportional rather than
    // normalised; the pixel width of one cell is total * ratio / ratioTotal.
    const ratioTotal = nodeAtSplit.ratios.reduce((sum, r) => sum + r, 0) || 1;
    const startRatios = [...nodeAtSplit.ratios];
    const startCoord = dir === "row" ? e.clientX : e.clientY;
    el.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const coord = dir === "row" ? ev.clientX : ev.clientY;
      const [a, b] = movedPair(
        startRatios,
        index,
        (coord - startCoord) / total,
        total,
        ratioTotal,
      );
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
</script>

{#snippet renderNode(node: LayoutNode)}
  {#if node.kind === "leaf"}
    {@const isThread = node.content.kind === "thread"}
    <!-- No chrome of its own, on any pane. The strip that used to name each one
         repeated the sidebar over a terminal and the panel's own header over a
         panel, and it cost 26px of every pane to do it. What it also carried is
         elsewhere now: the panels are toggled from the titlebar, and closing a
         pane is a palette command. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="pane-leaf"
      data-pane-leaf={node.paneId}
      role="group"
      aria-label={paneLabel(node.content)}
      onpointerdown={() => paneStore.setFocused(group.id, node.paneId)}
    >
      <!-- Measured whether or not anything is drawn inside it: for a thread the
           terminal arrives from the page as an absolutely positioned overlay,
           and this rectangle is the only thing that tells it where to go. -->
      <div class="pane-body" use:measure={node.paneId}>
        {#if !isThread}
          <PaneContentView
            content={node.content}
            projectId={group.projectId}
            paneId={node.paneId}
          />
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
          {@const share = Math.round(
            (node.ratios[i] / (node.ratios.reduce((sum, r) => sum + r, 0) || 1)) * 100,
          )}
          <!-- A separator rather than a button: it has a position on a scale
               and the arrows move it, which is not what pressing a button
               means. It was a button and therefore announced as one, with a
               name that promised a resize nothing but a pointer could do.
               The two rules below read `separator` as decoration; a separator
               with a value and bounds is the window-splitter pattern, and it is
               focusable and keyboard-driven by definition. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            class="splitter"
            class:row={node.dir === "row"}
            class:column={node.dir === "column"}
            role="separator"
            tabindex="0"
            aria-orientation={node.dir === "row" ? "vertical" : "horizontal"}
            aria-valuenow={share}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("panes.resize")}
            onpointerdown={(e) => startDrag(node.id, i, node.dir, e.currentTarget, e)}
            onkeydown={(e) => splitterKeydown(node.id, i, node.dir, e)}
          ></div>
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
  /* 4px of gutter with nothing in it: the ring is the only way to tell which
     divider the arrows are about to move. Drawn inside, because a splitter that
     grew by two pixels on focus would push the terminals either side of it. */
  .splitter:focus-visible {
    background: var(--color-border-strong);
    outline: 2px solid color-mix(in srgb, var(--color-foreground) 45%, transparent);
    outline-offset: -2px;
  }
</style>
