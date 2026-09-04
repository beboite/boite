<!--
  The one button.

  Every panel had grown its own: `px-2 py-1`, `px-2.5 py-1`, `p-1.5`, three
  borders and four hover rules, so two buttons side by side in the same row were
  a pixel or two different heights and no two cards agreed. The sizes here are
  fixed heights rather than padding, which is the only thing that makes an icon
  button and a labelled one line up: padding plus a 13px glyph and padding plus a
  12px line box are not the same number.

  `variant` says what the button is for, never what it looks like, so a theme
  change is one file. `icon` is a square of the same height, for a button whose
  label is its `title`.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { tip as tooltip, type TipParam } from "$lib/shared/actions/tooltip";

  type Variant = "primary" | "secondary" | "ghost" | "danger";
  type Size = "sm" | "md" | "lg";

  type Props = {
    variant?: Variant;
    size?: Size;
    /** Square, for a glyph with no label. `title` and `aria-label` still apply. */
    icon?: boolean;
    type?: "button" | "submit";
    disabled?: boolean;
    title?: string;
    /** The app tooltip, for a control whose label does not say what it does. */
    tip?: TipParam;
    ariaLabel?: string;
    /** A handle for the end-to-end scenarios, when no label is stable enough. */
    testid?: string;
    /** Toggle state, for a button that is on or off rather than an action. */
    pressed?: boolean;
    /** Something is running behind it, for a control that stays enabled. */
    busy?: boolean;
    class?: string;
    onclick?: (event: MouseEvent) => void;
    /** Push-to-talk and the like: a press that begins and ends, not a click. */
    onpointerdown?: (event: PointerEvent) => void;
    onpointerup?: (event: PointerEvent) => void;
    onpointercancel?: (event: PointerEvent) => void;
    onpointerleave?: (event: PointerEvent) => void;
    children: Snippet;
  };

  let {
    variant = "secondary",
    size = "md",
    icon = false,
    type = "button",
    disabled = false,
    title,
    tip,
    ariaLabel,
    testid,
    pressed,
    busy,
    class: extra = "",
    onclick,
    onpointerdown,
    onpointerup,
    onpointercancel,
    onpointerleave,
    children,
  }: Props = $props();

  const SIZES: Record<Size, string> = {
    sm: "h-6 text-xs gap-1",
    md: "h-7 text-xs gap-1.5",
    lg: "h-9 text-sm gap-2",
  };
  const PADDING: Record<Size, string> = { sm: "px-2", md: "px-2.5", lg: "px-3" };
  const SQUARE: Record<Size, string> = { sm: "w-6", md: "w-7", lg: "w-9" };

  const VARIANTS: Record<Variant, string> = {
    primary:
      "bg-foreground text-[var(--color-surface)] hover:opacity-90 border border-transparent",
    secondary:
      "border border-edge bg-[var(--color-surface-2)] text-foreground hover:border-foreground/30",
    ghost:
      "border border-transparent text-muted-foreground hover:bg-[var(--color-surface-3)] hover:text-foreground",
    danger:
      "border border-edge text-muted-foreground hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]",
  };

  const classes = $derived(
    [
      "inline-flex shrink-0 items-center justify-center rounded-md font-medium transition",
      "disabled:cursor-not-allowed disabled:opacity-40",
      SIZES[size],
      icon ? SQUARE[size] : PADDING[size],
      VARIANTS[variant],
      extra,
    ]
      .filter(Boolean)
      .join(" "),
  );
</script>

<button
  {type}
  {disabled}
  {title}
  use:tooltip={tip}
  aria-label={ariaLabel}
  data-testid={testid}
  aria-pressed={pressed}
  aria-busy={busy}
  class={classes}
  {onclick}
  {onpointerdown}
  {onpointerup}
  {onpointercancel}
  {onpointerleave}
>
  {@render children()}
</button>
