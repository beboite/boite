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

  type Variant = "primary" | "secondary" | "ghost" | "danger";
  type Size = "sm" | "md";

  type Props = {
    variant?: Variant;
    size?: Size;
    /** Square, for a glyph with no label. `title` and `aria-label` still apply. */
    icon?: boolean;
    type?: "button" | "submit";
    disabled?: boolean;
    title?: string;
    ariaLabel?: string;
    class?: string;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
  };

  let {
    variant = "secondary",
    size = "md",
    icon = false,
    type = "button",
    disabled = false,
    title,
    ariaLabel,
    class: extra = "",
    onclick,
    children,
  }: Props = $props();

  const SIZES: Record<Size, string> = {
    sm: "h-6 text-2xs gap-1",
    md: "h-7 text-xs gap-1.5",
  };
  const PADDING: Record<Size, string> = { sm: "px-2", md: "px-2.5" };
  const SQUARE: Record<Size, string> = { sm: "w-6", md: "w-7" };

  const VARIANTS: Record<Variant, string> = {
    primary:
      "bg-foreground text-[var(--color-surface)] hover:opacity-90 border border-transparent",
    secondary:
      "border border-border bg-[var(--color-surface-2)] text-foreground hover:border-foreground/30",
    ghost:
      "border border-transparent text-muted-foreground hover:bg-[var(--color-surface-3)] hover:text-foreground",
    danger:
      "border border-border text-muted-foreground hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]",
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

<button {type} {disabled} {title} aria-label={ariaLabel} class={classes} {onclick}>
  {@render children()}
</button>
