<script lang="ts">
  import type { ThreadStatus } from "$lib/types";
  import type { IconKey } from "$lib/types";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { t } from "$lib/i18n/index.svelte";

  /**
   * One mark per thread, carrying what it is and how it is doing.
   *
   * The sidebar row used to wear two: a status dot on the left and the agent's
   * logo on the right, at opposite ends of the same short label. Two glyphs on a
   * 200px row read as two objects, and neither one is the row.
   *
   * The card itself carries the status now, so there is no ring: a circle around
   * a logo that is already inside a lit card is a second frame drawn around one
   * fact. What is left is the logo on its own, and keep-awake is a violet pip on
   * the corner rather than a tint on the mark, because the mark is already
   * spending its colour on the state.
   */
  type Props = {
    status: ThreadStatus;
    iconKey?: IconKey;
    agent?: string;
    /** The model tint, when the thread came from fastpick. */
    color?: string | null;
    keepAwake?: boolean;
    size?: number;
    /** Rendered as a span rather than a button. For drag ghosts and read-only
        lists, where a nested button would swallow the row's own click. */
    inert?: boolean;
    onToggleKeepAwake?: () => void;
    title?: string;
    label?: string;
  };
  let {
    status,
    iconKey = null,
    agent,
    color = null,
    keepAwake = false,
    size = 20,
    inert = false,
    title,
    label,
  }: Props = $props();

  const glyphSize = $derived(Math.round(size * 0.7));

  function agentNameFromIcon(key?: IconKey): string {
    switch (key) {
      case "claude":
        return "Claude";
      case "codex":
        return "Codex";
      case "opencode":
        return "Opencode";
      case "cursor":
        return "Cursor";
      case "antigravity":
        return "Antigravity";
      case "copilot":
        return "Copilot";
      case "grok":
        return "Grok";
      case "hermes":
        return "Hermes";
      case "pi":
        return "Pi";
      case "muse":
        return "Muse";
      case "bun":
        return "Bun";
      case "terminal":
      default:
        return "Terminal";
    }
  }

  const resolvedAgent = $derived(agent ?? agentNameFromIcon(iconKey));

  const computedLabel = $derived.by(() => {
    if (label) return label;
    if (keepAwake) {
      return t("glyph.keepAwake", { agent: resolvedAgent });
    }
    switch (status) {
      case "running":
        return t("glyph.running", { agent: resolvedAgent });
      case "waiting":
        return t("glyph.waiting", { agent: resolvedAgent });
      case "ready":
        return t("glyph.ready", { agent: resolvedAgent });
      case "done":
        return t("glyph.done", { agent: resolvedAgent });
      case "exited":
        return t("glyph.exited", { agent: resolvedAgent });
      case "error":
        return t("glyph.error", { agent: resolvedAgent });
      case "stopped":
        return t("glyph.stopped", { agent: resolvedAgent });
      case "idle":
      default:
        return t("glyph.idle", { agent: resolvedAgent });
    }
  });
</script>

{#snippet body()}
  <ShortcutIcon {iconKey} size={glyphSize} {color} />
  {#if keepAwake}
    <span class="pip" aria-hidden="true"></span>
  {/if}
{/snippet}

<span
  class="glyph"
  class:inert
  role="img"
  style:width="{size}px"
  style:height="{size}px"
  {title}
  aria-label={computedLabel}
>
  {@render body()}
</span>

<style>
  /* The glyph is the logo and nothing else. No ring, no track, no second
     circle: the lit card is where the state lives, and a mark drawn around a
     mark is how a 200px row runs out of room. */
  .glyph {
    position: relative;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    cursor: default;
  }
  .glyph.inert {
    cursor: default;
  }

  /* Keep-awake, on the corner. Ringed in the surface colour so it stays a
     separate object over a logo of any shape. */
  .pip {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 5px;
    height: 5px;
    border-radius: 9999px;
    background: var(--color-awake);
    box-shadow: 0 0 0 1.5px var(--color-surface-2);
    pointer-events: none;
  }
</style>
