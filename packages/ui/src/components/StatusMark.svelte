<script lang="ts">
  import type { StatusMarkProps } from '../lib/thread-state';

  /**
   * The ring every status wears: threads, agents, workflow runs and steps.
   * `threadTone` and `workflowTone` pick its tone and label. `corner` pins it
   * to the bottom right of a picture, cut out of it by a `--ring` halo.
   */
  let { tone, label, corner = false }: StatusMarkProps & { corner?: boolean } = $props();
</script>

{#if corner}
  <span class="corner"><span class="mark {tone}" title={label} aria-label={label} data-tone={tone}></span></span>
{:else}
  <span class="mark {tone}" title={label} aria-label={label} data-tone={tone}></span>
{/if}

<style>
  .mark {
    display: inline-block;
    width: var(--mark-size, 8px);
    height: var(--mark-size, 8px);
    border-radius: 50%;
    flex: none;
    background: transparent;
    border: 1.5px solid var(--color-edge);
    transition: background var(--dur-2) var(--ease-out-quint);
  }
  .mark.unread { background: var(--color-foreground); border-color: var(--color-foreground); }
  /* Working is the accent everywhere, the sidebar's rows included; yellow is for the user's turn. */
  .mark.running {
    background: var(--color-accent);
    border-color: var(--color-accent);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .mark.waiting {
    border-color: var(--color-live);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-live) 35%, transparent);
  }
  .mark.paused { border-color: var(--color-live); }
  .mark.queued { border-color: var(--color-muted-foreground); border-style: dashed; }
  .mark.skipped { border-color: var(--color-subtle); border-style: dashed; }
  .mark.error { background: var(--color-danger); border-color: var(--color-danger); }
  .mark.done { background: var(--color-success); border-color: var(--color-success); }
  .mark.stopped { background: var(--color-muted-foreground); border-color: var(--color-muted-foreground); }

  .corner {
    position: absolute;
    right: -3px;
    bottom: -3px;
    display: grid;
    place-items: center;
    padding: 2px;
    border-radius: 50%;
    background: var(--ring, var(--color-surface));
  }

  /* An endless loop stops under reduced motion; the static mark keeps its colour. */
  @media (prefers-reduced-motion: reduce) { .mark.running { animation: none; } }
  :global(html[data-motion='reduced']) .mark.running { animation: none; }
</style>
