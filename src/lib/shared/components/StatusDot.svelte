<script lang="ts">
  import type { ThreadStatus } from "$lib/types";
  import { tip } from "$lib/shared/actions/tooltip";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import UnicodeSpinner from "./UnicodeSpinner.svelte";

  type Props = { status: ThreadStatus; asleep?: boolean; keepAwake?: boolean };
  let { status, asleep = false, keepAwake = false }: Props = $props();

  const colorByStatus: Record<ThreadStatus, string> = {
    idle: "bg-muted-foreground/30",
    running: "bg-warning",
    waiting: "bg-warning",
    ready: "bg-success",
    done: "bg-success",
    exited: "bg-danger",
    error: "bg-danger",
    stopped: "bg-muted-foreground/30",
  };

  // The dot used to hand the raw enum to assistive tech, so a screen reader
  // announced "exited" in whatever language the app was not in.
  const labelByStatus: Record<ThreadStatus, MessageKey> = {
    idle: "status.idle",
    running: "status.running",
    waiting: "status.waiting",
    ready: "status.ready",
    done: "status.done",
    exited: "status.exited",
    error: "status.error",
    stopped: "status.stopped",
  };

  const statusLabel = $derived(t(labelByStatus[status]));
</script>

{#if keepAwake}
  {#if status === "running"}
    <span
      class="inline-flex size-2.5 shrink-0 items-center justify-center text-awake"
      aria-label={t("status.keptAwake")}
      use:tip={t("status.keptAwakeHint")}
    >
      <UnicodeSpinner size={12} />
    </span>
  {:else}
    <span
      class="inline-block size-2.5 shrink-0 rounded-full bg-awake"
      aria-label={t("status.keptAwake")}
      use:tip={t("status.keptAwakeHint")}
    ></span>
  {/if}
{:else if asleep}
  <span
    class="inline-flex size-2.5 shrink-0 items-center justify-center text-success"
    aria-label={t("status.asleep")}
    use:tip={t("status.asleepHint")}
  >
    <UnicodeSpinner
      size={12}
      intervalMs={200}
      frames={["⠀", "⠄", "⠆", "⠇", "⠧", "⠷", "⠿", "⠷", "⠧", "⠇", "⠆", "⠄"]}
    />
  </span>
{:else if status === "running"}
  <span
    class="inline-flex size-2.5 shrink-0 items-center justify-center text-warning"
    aria-label={statusLabel}
    use:tip={statusLabel}
  >
    <UnicodeSpinner size={12} />
  </span>
{:else if status === "waiting"}
  <!-- Amber like running, because both are the agent's turn still open, but a
       pulsing disc rather than a moving spinner: nothing is progressing, and the
       only thing that will move it is the user. -->
  <span
    class="dot-waiting inline-block size-2.5 shrink-0 rounded-full bg-warning"
    aria-label={statusLabel}
    use:tip={statusLabel}
  ></span>
{:else}
  <span
    class="inline-block size-2.5 shrink-0 rounded-full {colorByStatus[status]}"
    aria-label={statusLabel}
    use:tip={statusLabel}
  ></span>
{/if}

<style>
  .dot-waiting {
    animation: dot-waiting-pulse 1.2s ease-in-out infinite;
  }
  @keyframes dot-waiting-pulse {
    50% {
      opacity: 0.3;
    }
  }
  /* A blinking dot is exactly what a vestibular or photosensitivity setting asks
     to be spared, and the colour alone still separates it from ready. */
  @media (prefers-reduced-motion: reduce) {
    .dot-waiting {
      animation: none;
    }
  }
</style>
