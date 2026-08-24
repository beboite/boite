<script lang="ts">
  /**
   * One file the two machines disagree about.
   *
   * Three regions, top to bottom: the two sides aligned so the shape of the
   * disagreement is visible at a glance, one row per difference where it is
   * decided, and the file that will actually be written.
   *
   * The controls are a list rather than widgets planted inside the diff. That is
   * a deliberate trade and worth naming: block widgets sit closer to what they
   * change, and they are imperative DOM this repo's test setup — node, no jsdom
   * — cannot see at all. A list is keyboard-reachable by default, reads in order
   * to a screen reader, and every decision behind it is a pure function in
   * `hunks.ts` that is tested. The diff above still carries the context.
   */
  import DiffView from "$lib/features/editor/DiffView.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import type { SyncConflict } from "$lib/backend";

  import {
    applyChoice,
    buildHunks,
    compose,
    defaultChoices,
    fillUndecided,
    undecided,
    unionSafeSyntax,
    type Choice,
  } from "./hunks";
  import { validate } from "./validate";

  type Props = {
    conflict: SyncConflict;
    /** Carried by the overlay so navigating away and back loses nothing. */
    choices: Choice[] | null;
    onChoices: (choices: Choice[]) => void;
    onApply: (content: string) => void;
    onSkip: () => void;
  };

  let { conflict, choices, onChoices, onApply, onSkip }: Props = $props();

  const mine = $derived(conflict.local ?? "");
  const theirs = $derived(conflict.remote ?? "");
  const unionSafe = $derived(unionSafeSyntax(conflict.syntax));
  const hunks = $derived(buildHunks(mine, theirs));
  const current = $derived(choices ?? defaultChoices(hunks, unionSafe));
  const merged = $derived(compose(mine, theirs, hunks, current));
  const verdict = $derived(validate(merged, conflict.syntax));
  const left = $derived(undecided(current));
  const ready = $derived(left === 0 && verdict.ok);

  const LABELS: { choice: Exclude<Choice, null>; key: "mine" | "theirs" | "both" | "swap" }[] = [
    { choice: "mine", key: "mine" },
    { choice: "theirs", key: "theirs" },
    { choice: "both", key: "both" },
    { choice: "bothReversed", key: "swap" },
  ];

  function label(key: "mine" | "theirs" | "both" | "swap"): string {
    if (key === "mine") return t("syncMerge.mine");
    if (key === "theirs") return t("syncMerge.theirs");
    if (key === "both") return t("syncMerge.both");
    return t("syncMerge.bothReversed");
  }

  function decide(id: number, choice: Choice) {
    onChoices(applyChoice(current, id, choice));
  }
</script>

<div class="flex h-full min-h-0 flex-col gap-2">
  <div class="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
    <DiffView
      leftContent={mine}
      rightContent={theirs}
      leftLabel={t("syncMerge.mineLabel")}
      rightLabel={t("syncMerge.theirsLabel")}
      filename={conflict.path}
    />
  </div>

  <div class="max-h-[34%] shrink-0 overflow-y-auto rounded-lg border border-border">
    {#if hunks.length === 0}
      <p class="p-3 text-xs text-muted-foreground">{t("syncMerge.noDifferences")}</p>
    {:else}
      {#each hunks as hunk (hunk.id)}
        <div
          class="border-b border-border/60 p-2.5 last:border-b-0"
          class:bg-[var(--color-surface-2)]={current[hunk.id] === null}
        >
          <div
            role="radiogroup"
            aria-label={t("syncMerge.differenceOf", {
              index: hunk.id + 1,
              total: hunks.length,
            })}
            class="flex flex-wrap items-center gap-1.5"
          >
            <span class="mr-1 text-xs uppercase tracking-wider text-muted-foreground">
              {t("syncMerge.differenceOf", { index: hunk.id + 1, total: hunks.length })}
            </span>
            {#each LABELS as option (option.choice)}
              <button
                type="button"
                role="radio"
                aria-checked={current[hunk.id] === option.choice}
                class="rounded-md border px-2 py-0.5 text-xs transition"
                class:border-foreground={current[hunk.id] === option.choice}
                class:bg-foreground={current[hunk.id] === option.choice}
                class:text-[var(--color-surface)]={current[hunk.id] === option.choice}
                class:border-border={current[hunk.id] !== option.choice}
                class:text-foreground={current[hunk.id] !== option.choice}
                onclick={() => decide(hunk.id, option.choice)}
              >
                {label(option.key)}
              </button>
            {/each}
          </div>
          <div class="mt-1.5 grid gap-1 md:grid-cols-2">
            <pre
              class="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-surface-2)] p-1.5 font-mono text-xs text-foreground">{hunk.mineText ||
                t("syncMerge.nothingHere")}</pre>
            <pre
              class="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-surface-2)] p-1.5 font-mono text-xs text-foreground">{hunk.theirsText ||
                t("syncMerge.nothingHere")}</pre>
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <div class="shrink-0 rounded-lg border border-border p-2.5">
    <div class="mb-1.5 flex items-center justify-between gap-3">
      <span class="text-xs uppercase tracking-wider text-muted-foreground">
        {t("syncMerge.result")}
      </span>
      <div class="flex items-center gap-2">
        {#if left > 0}
          <span class="text-xs text-muted-foreground">
            {t("syncMerge.undecided", { count: left })}
          </span>
          <button
            type="button"
            class="rounded-md border border-border px-2 py-0.5 text-xs text-foreground transition hover:bg-[var(--color-surface-3)]"
            onclick={() => onChoices(fillUndecided(current, "both"))}
          >
            {t("syncMerge.keepAllBoth")}
          </button>
        {/if}
        <button
          type="button"
          class="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition hover:bg-[var(--color-surface-3)]"
          onclick={onSkip}
        >
          {t("syncMerge.skip")}
        </button>
        <button
          type="button"
          class="rounded-md bg-foreground px-2.5 py-0.5 text-xs text-[var(--color-surface)] transition disabled:opacity-50"
          disabled={!ready}
          onclick={() => onApply(merged)}
        >
          {t("syncMerge.apply")}
        </button>
      </div>
    </div>
    {#if !verdict.ok}
      <!-- The check that stops a stacked JSON object reaching ~/.claude and
           breaking the agent on every machine the repository touches. -->
      <p class="mb-1.5 text-xs text-[var(--color-danger)]">
        {verdict.line
          ? t("syncMerge.invalidAtLine", { line: verdict.line, error: verdict.message ?? "" })
          : t("syncMerge.invalid", { error: verdict.message ?? "" })}
      </p>
    {/if}
    <pre
      class="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-surface-2)] p-2 font-mono text-xs text-foreground"
      aria-label={t("syncMerge.result")}>{merged}</pre>
  </div>
</div>
