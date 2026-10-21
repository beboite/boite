<script lang="ts">
  import type { ThreadSummary } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { trackThreadPullRequest } from '../lib/thread-pull-request.svelte';
  import PullRequestBadge from './PullRequestBadge.svelte';
  let { owner, thread }: { owner: Store; thread: ThreadSummary } = $props();
  const pr = trackThreadPullRequest(() => ({ owner, thread }));
</script>

{#if pr.value}<PullRequestBadge pullRequest={pr.value} />{/if}
