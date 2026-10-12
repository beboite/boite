<script lang="ts">
  import { PencilLine, Pin } from '@lucide/svelte';
  import type { ThreadSummary } from '@boite/contracts';
  import type { Machine } from '../lib/workspace.svelte';
  import type { Store } from '../lib/store.svelte';
  import { agentLabel } from '../lib/format';
  import { hasUnsentDraft } from '../lib/composer-queue';
  import { agentDirectory } from '../lib/agent-directory.svelte';
  import { stewardChip } from '../lib/steward';
  import { strings } from '../lib/strings';
  import MachineIcon from './MachineIcon.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import ThreadState from './ThreadState.svelte';
  import AgentAvatar from './agents/AgentAvatar.svelte';

  /**
   * A thread row's first line, in the sidebar and in a phone's list: who runs
   * it (a steward's robot, the agent it belongs or was entrusted to, else the
   * provider's logo, whose tooltip names the provider and the model), the
   * title, an unsent draft, the pin, then the state or the time.
   */
  let {
    owner,
    thread,
    now,
    machine,
    open = false,
    wrap = false
  }: {
    owner: Store;
    thread: ThreadSummary;
    /** Without it the row draws the state itself, elsewhere. */
    now?: number;
    /** The machine's icon before the picture, once there are two machines. */
    machine?: Machine;
    /** The open thread shows its box: its row marks no draft. */
    open?: boolean;
    /** A phone's list: the title wraps over several lines instead of ending in an ellipsis. */
    wrap?: boolean;
  } = $props();
  let agent = $derived(agentLabel(owner, thread));
  let draft = $derived(!open && hasUnsentDraft(owner.composerStates[thread.id]));
  /** A persistent agent's thread, a sub-thread and an entrusted thread wear that agent's picture where the logo goes. */
  let runner = $derived(thread.agentSessionId || thread.parentThreadId ? agentDirectory(owner).ownerOf(thread) : agentDirectory(owner).entrustmentOf(thread.id)?.agent ?? null);
  /** A steward's own thread wears the robot its id draws, the picture its projects show. */
  let steward = $derived(owner.stewards?.find(grant => grant.threadId === thread.id) ?? null);
</script>

<span class="headline" class:wrap class:unread={thread.unread && !wrap}>
  {#if machine}
    <span class="machine" class:offline={owner.connection !== 'ready'}
      title={`${machine.label} · ${strings.connection[owner.connection]}`} aria-label={machine.label}>
      <MachineIcon icon={machine.icon} os={owner.core?.os} />
    </span>
  {/if}
  {#if steward}
    <span class="picture" data-testid="thread-steward" role="img" title={`${stewardChip(steward)} · ${agent}`} aria-label={stewardChip(steward)}>
      <AgentAvatar kind="profile" id={thread.id} name={thread.title} size={16} />
    </span>
  {:else if runner}
    <span class="picture" data-testid="thread-agent" role="img" title={`${runner.name} · ${agent}`} aria-label={runner.name}>
      <AgentAvatar kind="profile" id={runner.id} name={runner.name} avatar={runner.avatar} size={16} />
    </span>
  {:else}
    <span class="picture" data-testid="thread-provider" role="img" title={agent} aria-label={agent}>
      <ProviderLogo providerId={thread.providerId} size={wrap ? 13 : 12} />
    </span>
  {/if}
  <span class="title" class:ui-label={!wrap}>{thread.title}</span>
  {#if draft}<span class="draft" data-testid="thread-draft" title={strings.sidebar.unsentDraft} aria-label={strings.sidebar.unsentDraft}><PencilLine size={12} /></span>{/if}
  {#if thread.pinned}<span class="pin"><Pin size={12} /></span>{/if}
  {#if now !== undefined}<ThreadState {thread} {now} subagents={owner.subagents(thread.id)} />{/if}
</span>

<style>
  .headline {
    display: flex;
    align-items: center;
    min-height: 1lh; /* Keep the row stable when machine glyphs appear. */
    gap: 8px;
    min-width: 0;
  }
  .title {
    flex: 1;
    min-width: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-foreground);
    font-weight: 400;
  }
  .unread .title {
    font-weight: 600;
  }
  .picture,
  .machine,
  .draft,
  .pin {
    display: inline-flex;
    align-items: center;
    flex: none;
  }
  .machine {
    color: var(--color-muted-foreground);
  }
  .machine.offline {
    color: var(--color-danger);
  }
  /* A draft left in the box: the accent, so it reads as the user's own work waiting. */
  .draft {
    color: var(--color-accent);
  }
  /* On a phone the line is text: the marks flow with the title and it wraps. */
  .wrap {
    display: block;
    font-size: var(--text-base);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .wrap .title {
    display: inline;
    overflow: visible;
    white-space: normal;
    font-weight: inherit;
  }
  .wrap .picture {
    margin-right: 6px;
    vertical-align: -2px;
  }
  .wrap .draft {
    margin-left: 6px;
    vertical-align: -1px;
  }
  .wrap .pin {
    margin-left: 4px;
    vertical-align: -1px;
    color: var(--color-muted-foreground);
  }
</style>
