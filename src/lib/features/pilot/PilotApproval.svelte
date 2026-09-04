<script lang="ts">
  /**
   * One chat thread's open question, in the dock.
   *
   * The approvals row carries the thread and the request id and nothing else,
   * on purpose: what the card shows comes out of the stored request beside it
   * (`boite_core::pilot::open_approval`). So this loads the thread's timeline,
   * which is what holds the request as the driver sent it, and hands it to the
   * same `RequestCard` the pane draws. Two cards for one question would be two
   * ideas of what the user agreed to.
   *
   * The load is the store's own and is idempotent: a pane already showing this
   * thread has it loaded, and this is then a read.
   */
  import RequestCard from "./RequestCard.svelte";
  import { load, pilotThread } from "./store.svelte";
  import { t } from "$lib/i18n/index.svelte";

  type Props = { threadId: string; requestId: string };
  let { threadId, requestId }: Props = $props();

  $effect(() => {
    void load(threadId);
  });

  const state = $derived(pilotThread(threadId));
  const request = $derived(state.requests.find((row) => row.id === requestId) ?? null);
</script>

{#if request}
  <RequestCard {threadId} {request} compact />
{:else}
  <p class="px-1 text-sm text-muted-2">{t("common.loading")}</p>
{/if}
