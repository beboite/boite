/**
 * The app's tooltip, in place of the engine's.
 *
 * A hundred and twenty-six controls carried `title={t(...)}`, and inside a
 * webview that attribute is drawn by the OS: a grey box after a delay nothing
 * in the app chose, in the system font at the system size, ignoring the theme,
 * the interface font setting and the UI scale, and unable to hold anything but
 * a run of text. It was the one surface in Boite that looked like it belonged
 * to another program.
 *
 * An action rather than a component because the call sites are already written:
 * `title={t("x")}` becomes `use:tip={t("x")}` and nothing else about the markup
 * moves. The string stays a `t()` at the call site, so the key derivation that
 * `bun run check` reads is untouched.
 *
 * One node for the whole app, parked on `document.body`. A tooltip per target
 * would be a hundred and twenty-six hidden nodes in the tree, and only one is
 * ever on screen.
 */

export type TipOptions = {
  text: string;
  /** Drawn as a key cap after the text, for a control that has a shortcut. */
  kbd?: string;
  /** Which side to try first. Flips when there is no room. */
  placement?: "top" | "bottom" | "left" | "right";
  /** Skips the wait. For a control whose meaning is not guessable at all. */
  instant?: boolean;
};

export type TipParam = string | TipOptions | null | undefined;

/** Long enough that crossing a toolbar raises nothing. */
const DELAY_MS = 460;
/**
 * After one tooltip has been read, the next is immediate: a toolbar being
 * scanned is one gesture, and re-serving the delay per button turns it into a
 * stutter. The window is short enough that coming back a minute later waits
 * again.
 */
const WARM_MS = 320;
/** Between the control and the box. */
const GAP = 8;
/** Never closer than this to the window edge. */
const MARGIN = 6;

const TIP_ID = "boite-tip";

let tipEl: HTMLDivElement | null = null;
let textEl: HTMLSpanElement | null = null;
let kbdEl: HTMLElement | null = null;
let owner: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let lastHiddenAt = 0;

function ensureEl(): HTMLDivElement {
  if (tipEl) return tipEl;
  const el = document.createElement("div");
  el.id = TIP_ID;
  el.className = "boite-tip";
  el.setAttribute("role", "tooltip");
  // Out of the tab order and out of the hit test: a box that follows the
  // pointer must never be the thing the pointer is over.
  el.setAttribute("aria-hidden", "true");
  textEl = document.createElement("span");
  kbdEl = document.createElement("kbd");
  kbdEl.className = "kbd";
  el.append(textEl, kbdEl);
  document.body.appendChild(el);
  tipEl = el;
  return el;
}

function hide() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (!owner) return;
  owner.removeAttribute("aria-describedby");
  owner = null;
  lastHiddenAt = performance.now();
  tipEl?.removeAttribute("data-open");
}

/**
 * Anchored to the target's box rather than to the pointer. A box that tracks
 * the pointer inside a wide control reads as a cursor decoration; one pinned to
 * the control reads as a label for it, which is what it is.
 */
function place(node: HTMLElement, el: HTMLDivElement, placement: NonNullable<TipOptions["placement"]>) {
  const anchor = node.getBoundingClientRect();
  // Measured while already laid out but before it is shown, so the first frame
  // is drawn in the right place instead of arriving and then jumping.
  const box = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let side = placement;
  // The flip, once, towards whichever side actually has the room. A second
  // flip could only send it back where it came from.
  if (side === "top" && anchor.top - box.height - GAP < MARGIN) side = "bottom";
  else if (side === "bottom" && anchor.bottom + box.height + GAP > vh - MARGIN) side = "top";
  else if (side === "left" && anchor.left - box.width - GAP < MARGIN) side = "right";
  else if (side === "right" && anchor.right + box.width + GAP > vw - MARGIN) side = "left";

  let x: number;
  let y: number;
  if (side === "top" || side === "bottom") {
    x = anchor.left + anchor.width / 2 - box.width / 2;
    y = side === "top" ? anchor.top - box.height - GAP : anchor.bottom + GAP;
  } else {
    x = side === "left" ? anchor.left - box.width - GAP : anchor.right + GAP;
    y = anchor.top + anchor.height / 2 - box.height / 2;
  }

  // Clamped rather than shifted along with an arrow: with no arrow to point
  // with, a box held inside the window and centred where it can be is the whole
  // of the positioning.
  x = Math.min(Math.max(x, MARGIN), Math.max(MARGIN, vw - box.width - MARGIN));
  y = Math.min(Math.max(y, MARGIN), Math.max(MARGIN, vh - box.height - MARGIN));

  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  el.dataset.side = side;
}

function show(node: HTMLElement, opts: TipOptions) {
  const el = ensureEl();
  owner = node;
  if (textEl) textEl.textContent = opts.text;
  if (kbdEl) {
    kbdEl.textContent = opts.kbd ?? "";
    kbdEl.hidden = !opts.kbd;
  }
  node.setAttribute("aria-describedby", TIP_ID);
  // Laid out first, positioned second, revealed third: `data-open` is the only
  // thing that makes it visible, so the two reads above happen on a box that is
  // the right size and that nobody has seen yet.
  place(node, el, opts.placement ?? "top");
  el.dataset.open = "";
}

function normalise(param: TipParam): TipOptions | null {
  if (!param) return null;
  if (typeof param === "string") return param ? { text: param } : null;
  return param.text ? param : null;
}

export function tip(node: HTMLElement, param: TipParam) {
  let opts = normalise(param);

  /**
   * The label the `title` attribute used to be worth to a screen reader.
   * Only when the control has neither of the two things that outrank it: an
   * icon-only button loses its whole name without this, and a button with a
   * word in it would be read twice with it.
   */
  function syncLabel() {
    if (!opts) {
      if (node.dataset.tipLabel !== undefined) {
        node.removeAttribute("aria-label");
        delete node.dataset.tipLabel;
      }
      return;
    }
    const owned = node.dataset.tipLabel !== undefined;
    if (!owned && (node.getAttribute("aria-label") || node.getAttribute("aria-labelledby"))) return;
    node.setAttribute("aria-label", opts.text);
    node.dataset.tipLabel = "";
  }

  function open() {
    if (!opts) return;
    show(node, opts);
  }

  function enter() {
    if (!opts) return;
    if (showTimer) clearTimeout(showTimer);
    // Whatever was up belongs to the control the pointer just left.
    if (owner && owner !== node) hide();
    const warm = performance.now() - lastHiddenAt < WARM_MS;
    if (opts.instant || warm) {
      open();
      return;
    }
    showTimer = setTimeout(open, DELAY_MS);
  }

  function leave() {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    if (owner === node) hide();
  }

  // A press is the answer to the question the tooltip was asking, and a menu or
  // a dialog opening under a box explaining the button that opened it is the
  // usual way these outstay their welcome.
  function press() {
    leave();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && owner === node) hide();
  }

  node.addEventListener("pointerenter", enter);
  node.addEventListener("pointerleave", leave);
  node.addEventListener("pointerdown", press);
  // Keyboard focus raises it with no wait: nobody tabs onto a control to hover
  // it, and the delay would only ever be dead time.
  node.addEventListener("focus", open);
  node.addEventListener("blur", leave);
  node.addEventListener("keydown", onKey);

  syncLabel();

  return {
    update(next: TipParam) {
      opts = normalise(next);
      syncLabel();
      if (owner === node) {
        if (!opts) hide();
        else open();
      }
    },
    destroy() {
      leave();
      node.removeEventListener("pointerenter", enter);
      node.removeEventListener("pointerleave", leave);
      node.removeEventListener("pointerdown", press);
      node.removeEventListener("focus", open);
      node.removeEventListener("blur", leave);
      node.removeEventListener("keydown", onKey);
    },
  };
}

/**
 * A scroll moves the control and leaves the box behind, and there is no useful
 * answer other than taking it down. Captured at the root so a scroll in any
 * pane counts, and passive because nothing here cancels anything.
 *
 * Kept out of the action so it is one pair of listeners for the app rather than
 * one per tooltipped control, and installed lazily so importing the module in a
 * test does not reach for a window.
 */
if (typeof window !== "undefined") {
  window.addEventListener("scroll", () => hide(), { capture: true, passive: true });
  window.addEventListener("resize", () => hide(), { passive: true });
  window.addEventListener("blur", () => hide());
}
