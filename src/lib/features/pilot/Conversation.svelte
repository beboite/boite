<script lang="ts">
  /**
   * A chat thread's timeline, without the pane around it.
   *
   * The Home card draws the orchestrator's conversation and the chat pane draws
   * a worker's, and both are the same rows read the same way: the pane owns a
   * composer, a header and a model picker, none of which Home wants, and the
   * timeline is what is left. Its own component rather than a flag on
   * `ChatPane.svelte`, so the Home card can hold it behind one `import()` and
   * the boot path keeps the ceiling `bundle-budget.json` writes down.
   *
   * The subscription is this component's: `load` reads the timeline by cursor
   * and then subscribes, `release` drops the feed. Held by an effect rather than
   * by `onDestroy`, so a card whose scope changes under it lets go of the thread
   * it was showing instead of feeding two.
   */
  import { app } from "$lib/app/store.svelte";
  import { threadCwd } from "$lib/features/thread/cwd";
  import Timeline from "./Timeline.svelte";
  import { load, pilotThread, release } from "./store.svelte";

  type Props = { threadId: string };
  let { threadId }: Props = $props();

  const thread = $derived(app.threadById(threadId));
  const project = $derived(thread ? app.projectById(thread.projectId) : null);
  const repoPath = $derived(thread ? threadCwd(thread, project) : null);
  const view = $derived(pilotThread(threadId));

  $effect(() => {
    const id = threadId;
    void load(id);
    return () => release(id);
  });
</script>

<Timeline
  {threadId}
  items={view.items}
  {repoPath}
  projectId={thread?.projectId ?? ""}
  status={view.status}
/>
