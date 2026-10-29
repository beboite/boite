<script lang="ts">
  import { untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { experimentOn } from '../lib/experiments.svelte';
  import { pinnedQuotas, PINNED_QUOTA_WIDTH } from '../lib/pinned-quotas.svelte';
  import Deferred, { parts } from './Deferred.svelte';
  import { ChevronDown, FolderOpen, VenetianMask } from '@lucide/svelte';
  import { fill, strings } from '../lib/strings';
  import { modePhrase } from '../lib/permission-modes';
  import { effortName, projectName } from '../lib/format';
  import type { Store } from '../lib/store.svelte';
  import { DRAFT_STASH_KEY } from '../lib/prefs';
  import { lastIndexById } from '../lib/thread-rows';
  import { slideFrom } from '../lib/motion';
  import Composer from './Composer.svelte';
  import FolderGoneNotice from './FolderGoneNotice.svelte';
  import AgentDock from './AgentDock.svelte';
  import ProjectChoice from './ProjectChoice.svelte';
  import MessageList from './MessageList.svelte';
  import ThreadLoading from './ThreadLoading.svelte';
  import ThreadRecovery from './ThreadRecovery.svelte';
  import ThreadRetry from './ThreadRetry.svelte';
  import ForkReturn from './ForkReturn.svelte';
  import ProjectTile from './ProjectTile.svelte';
  import MachineIcon from './MachineIcon.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import DoneThreadNotice from './DoneThreadNotice.svelte';
  import WorktreeGoneNotice from './WorktreeGoneNotice.svelte';
  import ContactHoldNotice from './ContactHoldNotice.svelte';

  /** `locked`: the conversation reads but takes nothing more, said in place of the composer (an archived agent's). */
  let { store, locked = null }: { store: Store; locked?: string | null } = $props();

  let thread = $derived(store.openThread);
  const phone = new MediaQuery('(max-width: 720px)');
  let dockAvailable = $derived(phone.current ? store.page === 'chat' && store.sidebarOpen : !store.sidebarCollapsed);
  let pinnedHere = $derived(experimentOn('pinned-quotas') && pinnedQuotas.current.pinned
    && (!phone.current || !store.sidebarOpen)
    && !(pinnedQuotas.wantsDock(store) && dockAvailable));
  let discussion = $state<HTMLElement>();
  let quotaRoom = $state<HTMLElement>();
  /** How tall the subagent bar stands over the composer: the band of tasks floats above it, not over it. */
  let agentDockRoom = $state(0);
  $effect(() => {
    const box = discussion, column = quotaRoom, owner = store;
    if (!box || !column || !experimentOn('pinned-quotas') || !pinnedQuotas.current.pinned) return;
    const measure = () => pinnedQuotas.crowded.set(owner, (box.clientWidth - column.clientWidth) / 2 < PINNED_QUOTA_WIDTH + 24);
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
    observer.observe(box);
    observer.observe(column);
    untrack(measure);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); pinnedQuotas.crowded.delete(owner); };
  });
  /**
   * The prompt on its way to the core, drawn after what the thread holds. A
   * draft shows it too, while its thread is still being created. One whose
   * turn the thread already holds has landed and is not drawn twice.
   */
  let sending = $derived.by(() => {
    const local = store.staged[thread?.id ?? DRAFT_STASH_KEY];
    if (!local || !thread) return local;
    for (let at = thread.messages.length - 1; at >= Math.max(0, thread.messages.length - 8); at--) {
      if (thread.messages[at]!.turnId === local.turnId) return undefined;
    }
    return local;
  });
  let quotaInDraft = $derived(!thread && !sending && !phone.current);
  /** An edit or a retry in flight: the message it replaces and what follows leave the screen before the core answers. */
  let kept = $derived.by(() => {
    const held = thread?.messages ?? [];
    const cut = thread ? store.rewinding[thread.id] : undefined;
    const at = cut === undefined ? -1 : lastIndexById(held, cut);
    return at < 0 ? held : held.slice(0, at);
  });
  let messages = $derived(sending ? [...kept, sending] : kept);
  // The timeline still needs agent messages after reload, even with settings hidden.
  let threadId = $derived(thread?.id);
  let agentSession = $derived(!!thread?.agentSessionId);
  $effect(() => {
    const id = threadId;
    if (id && !agentSession) untrack(() => void store.loadCoordination(id, false));
  });
  let project = $derived(store.openProject);
  let draftChoice = $derived(store.defaultChoice());
  let draftModel = $derived(store.modelOf(draftChoice));
  let draftProvider = $derived(draftChoice ? store.providerOf(draftChoice.providerId) : null);
  let draftEffort = $derived(draftChoice?.effort ?? draftModel?.effort?.default ?? null);
  let effortLabel = $derived(draftEffort ? effortName(draftModel, draftEffort) : null);
  let modelLabel = $derived(draftModel?.name ?? draftChoice?.model ?? draftProvider?.name ?? '');
  /** The machine the draft's project is on: the heading ends with it, one machine or several. */
  let machine = $derived(workspace.machinesOr(store).find((entry) => entry.store === store) ?? null);

  /**
   * A draft's first prompt takes the composer from the middle of the column to
   * the bottom. Its place is read before the layout changes, then it slides
   * from there instead of jumping.
   */
  let chat = $state<HTMLElement>();
  let leftFrom: number | null = null;
  let leaving = $derived(!thread && !!sending);
  $effect.pre(() => {
    if (leaving) leftFrom = untrack(() => chat?.querySelector('[data-testid=composer]')?.getBoundingClientRect().top ?? null);
  });
  $effect(() => {
    const composer = leaving ? chat?.querySelector<HTMLElement>('[data-testid=composer]') : null;
    if (composer && leftFrom !== null) slideFrom(composer, leftFrom);
    leftFrom = null;
  });
</script>

{#if !thread && !store.draft}
  <div class="none" data-testid="no-thread">
    <h1>{strings.thread.none}</h1>
    <p class="muted">{strings.thread.noneBody}</p>
  </div>
{:else}
  <!-- The draft's roomier composer belongs to the middle of the column: once
     the prompt is on its way the composer is at the bottom, at its thread size,
     or it shrinks a second time when the thread opens. -->
  <section class="chat" class:drafting={!thread && !sending} bind:this={chat} data-testid="chat" style:--agent-dock-room={thread ? `${agentDockRoom}px` : undefined}>
    {#if thread?.forkOrigin}{#key thread.id}<ForkReturn {store} {thread} />{/key}{/if}
    <div class="discussion" class:draft-body={!thread && !sending} bind:this={discussion} data-testid={!thread && !sending ? 'draft-empty' : undefined}>
    {#if experimentOn('pinned-quotas') && pinnedQuotas.current.pinned}<div class="quota-room" bind:this={quotaRoom} aria-hidden="true"></div>{/if}
    {#if thread}
      <!-- One timeline per thread: the heights it measured and the ids that
           already played the rise belong to that thread alone, and kept across
           a switch they grew for every message the page had ever shown. -->
      {#key thread.id}
        {#if store.loadingThreadId === thread.id && messages.length === 0}
          <ThreadLoading progress={store.loadingBytes?.threadId === thread.id ? store.loadingBytes : null} />
        {:else}
          <MessageList {store} threadId={thread.id} {messages} />
        {/if}
      {/key}
    {:else if sending}
      <MessageList {store} threadId={DRAFT_STASH_KEY} {messages} />
    {:else}
        <div class="mobile-welcome">
          <img src="./icons/icon.svg" alt="" width="42" height="42" />
          <h1>{strings.mobile.draftTitle}</h1>
          <p>{strings.mobile.draftHint}</p>
          <span class="mobile-place">
            <span class="project-choice"><ProjectChoice {store} testid="mobile-draft-project" phone>{#if project}<ProjectTile {project} {store} />{:else}<FolderOpen size={15} />{/if}<span class="project-label ui-label">{project ? projectName(project) : strings.drafts.name}</span><ChevronDown size={14} /></ProjectChoice></span>
            {#if machine}<span class="ui-label">{strings.thread.onMachine}</span><span class="machine" data-testid="mobile-draft-machine"><MachineIcon icon={machine.icon} os={store.core?.os} size={15} /><span class="ui-label">{machine.label}</span></span>{/if}
          </span>
          {#if draftChoice}<small>{modePhrase(draftChoice.permissionMode, draftProvider)}</small>{/if}
          {#if store.draft?.worktree}<small>{strings.thread.inWorktree}</small>{/if}
          <!-- On a phone the composer holds the bottom: the cards read under the welcome instead. -->
          {#if phone.current}{#await import('./HomeCards.svelte') then module}<module.default {store} phone />{/await}{/if}
        </div>
        <div class="draft-heading" data-testid="draft-sentence">
          <h1 class="start">
            <span class="ui-label">{strings.thread.start}</span>
            <span class="ui-label">{strings.thread.inProject}</span>
            <!-- It opens upward, into the empty half of the column: under the
                 heading it would land on the composer. -->
            <span class="project-choice"><ProjectChoice {store} testid="draft-project">
              {#if project}<ProjectTile {project} {store} />{:else}<FolderOpen size={15} />{/if}
              <span class="project-label ui-label">{project ? projectName(project) : strings.drafts.name}</span>
              <ChevronDown size={14} strokeWidth={2} />
            </ProjectChoice></span>
            {#if machine}
              <span class="ui-label">{strings.thread.onMachine}</span>
              <span class="machine" data-testid="draft-machine"><MachineIcon icon={machine.icon} os={store.core?.os} size={20} /><span class="ui-label">{machine.label}</span></span>
            {/if}
          </h1>
          {#if draftChoice || store.draft?.worktree}
            <p class="draft-details">
              {#if store.draft?.worktree}<span>{strings.thread.inWorktree}</span>{/if}
              {#if draftChoice}
                <span>{modePhrase(draftChoice.permissionMode, draftProvider)}</span>
                <span>{strings.thread.using} {modelLabel}</span>
                {#if effortLabel}<span>{fill(strings.thread.onEffort, { effort: effortLabel })}</span>{/if}
              {/if}
            </p>
          {/if}
        </div>
    {/if}

    {#if pinnedHere && !quotaInDraft && (!pinnedQuotas.crowded.get(store) || (!thread && !sending))}<Deferred part={parts.PinnedQuota} quiet>{#snippet children(PinnedQuota)}<PinnedQuota {store} area={discussion} />{/snippet}</Deferred>{/if}
    </div>

    {#if pinnedHere && pinnedQuotas.crowded.get(store) && (thread || sending)}<Deferred part={parts.PinnedQuota} quiet>{#snippet children(PinnedQuota)}<PinnedQuota {store} inline area={discussion} />{/snippet}</Deferred>{/if}

    {#if thread}<ThreadRecovery {store} /><ThreadRetry {store} />{/if}
    {#if store.openProject?.missing === true && !thread?.agentSessionId}<FolderGoneNotice {store} project={store.openProject} />{/if}
    {#if thread?.worktreeRemoved}<WorktreeGoneNotice removal={thread.worktreeRemoved} archived={thread.archived} />{/if}
    {#if thread?.contactHold && !thread.archived}<ContactHoldNotice {store} threadId={thread.id} contacts={thread.contactHold.contacts} />{/if}
    <!-- Right on the composer, so the band of tasks rises by this bar's height alone, whatever notice stands above. -->
    {#if thread}<div bind:offsetHeight={agentDockRoom}><AgentDock {store} threadId={thread.id} /></div>{/if}
    {#if locked}<p class="locked" data-testid="chat-locked">{locked}</p>
    {:else if thread?.archived}<DoneThreadNotice {store} threadId={thread.id} />{:else}<Composer {store} centered={!thread && !sending} />{/if}

    <!-- The draft's heading and composer are one block in the middle of the
         column: the body above and this tail below share the free space. -->
    {#if !thread && !sending}
      <div class="draft-tail">
        <!-- In the drafts the agent gets a fresh folder; someone with work of
             their own is one click from pointing it there instead. -->
        {#if store.draftInDrafts && store.draft?.incognito}
          <!-- What the header's switch means, said where the eyes are. -->
          <p class="incognito-note" data-testid="draft-incognito-note">
            <VenetianMask size={14} strokeWidth={1.75} />
            {strings.drafts.incognitoOn}
          </p>
        {:else if store.draftInDrafts && store.owner}
          <button type="button" class="ghost small open-folder" data-testid="draft-open-folder" onclick={() => (store.projectPickerOpen = true)}>
            <FolderOpen size={14} strokeWidth={1.75} />
            <span class="ui-label">{strings.drafts.openFolder}</span>
          </button>
        {/if}
        <!-- The owner's status cards, read at a glance before a thread is opened. Loaded apart: most owners have none. -->
        {#if !phone.current}{#await import('./HomeCards.svelte') then module}<module.default {store} />{/await}{/if}
      </div>
    {/if}
    <!-- Desktop drafts anchor against the whole chat so their centered heading stays clear. -->
    {#if pinnedHere && quotaInDraft}<Deferred part={parts.PinnedQuota} quiet>{#snippet children(PinnedQuota)}<PinnedQuota {store} area={chat} />{/snippet}</Deferred>{/if}
  </section>
{/if}

<style>
  .project-choice { display: inline-flex; max-width: 100%; border: 1px dashed var(--color-muted-foreground); border-radius: var(--radius-md); }
  .project-choice:hover, .project-choice:focus-within { border-color: var(--color-accent); }
  .project-choice :global(.choice) { min-width: 0; max-width: 100%; }
  .project-choice :global(.trigger) { min-height: var(--row); height: auto; max-width: 100%; padding: 7px 12px; gap: 8px; }
  .project-label { min-width: 0; overflow-wrap: anywhere; }
  .mobile-welcome { display: none; }
  /* The machine reads as part of the sentence: no outline, since nothing opens from it. */
  .machine { display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
  .machine :global(svg) { flex: none; color: var(--color-muted-foreground); }
  .machine .ui-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .locked {
    width: min(calc(100% - 40px), var(--content));
    margin: 0 auto 16px;
    padding: 12px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    text-align: center;
  }

  .none {
    margin: auto;
    padding: 40px;
    text-align: center;
    color: var(--color-muted-foreground);
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .none h1 {
    color: var(--color-foreground);
    margin-bottom: 4px;
  }

  .chat {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .discussion { position: relative; display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .quota-room { position: absolute; width: 100%; max-width: var(--content); height: 0; pointer-events: none; }

  .chat.drafting {
    --composer-input-height: 80px;
    --composer-input-padding: 18px 20px 0;
    --composer-input-gap: 12px;
    --composer-bar-padding: 8px 16px 16px;
  }

  /* Zero basis on both halves, so the heading sits exactly as far below the
     top as the composer sits above the bottom: one centred block. */
  .draft-body {
    flex: 1 1 0;
    min-height: auto;
    display: flex;
    flex-direction: row;
    align-items: flex-end;
    justify-content: center;
    padding: 24px 20px 32px;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .draft-tail {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    overflow-y: auto;
  }

  /* Inline, so the mark stays with the first word when the line wraps on a phone. */
  .incognito-note {
    margin: 10px 20px 0;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
    text-align: center;
  }

  .incognito-note :global(svg) { vertical-align: -2px; margin-right: 4px; }

  .open-folder {
    margin-top: 10px;
    gap: 6px;
    color: var(--color-muted-foreground);
  }

  .draft-heading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    width: 100%;
    max-width: var(--content);
    text-align: center;
  }

  /* One sentence cut in phrases that wrap whole: the gap between two is a word space, not 6 px. */
  .draft-details {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 4px 0.28em;
    color: var(--color-muted-foreground);
    font-size: var(--text-base);
    line-height: 1.6;
  }

  .start {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 8px;
    width: 100%;
    max-width: var(--content);
    font-size: calc(var(--text-lg) * 1.2);
    font-weight: 600;
    color: var(--color-foreground);
    text-align: center;
    line-height: 1.6;
  }

  @media (max-width: 720px) {
    .chat.drafting {
      --composer-input-height: 64px;
      --composer-input-padding: 16px 16px 0;
      --composer-input-gap: 10px;
      --composer-bar-padding: 4px 12px 12px;
    }
    .project-choice :global(.trigger) { min-height: var(--touch-target); }
    .draft-heading { display: none; }
    .draft-tail { display: none; }
    .mobile-welcome { display: flex; flex-direction: column; align-items: center; max-width: 340px; text-align: center; gap: 14px; }
    .mobile-welcome img { border-radius: var(--radius-lg); }
    .mobile-welcome h1 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.6px; line-height: 1.2; }
    .mobile-welcome p { margin: 0 0 6px; font-size: var(--text-sm); line-height: 1.6; color: var(--color-muted-foreground); }
    .mobile-welcome small { color: var(--color-muted-foreground); font-size: var(--text-xs); }
    .mobile-place { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; max-width: 100%; font-size: var(--text-md); font-weight: 600; }
    .mobile-place .machine { gap: 6px; }
    /* Safe: a welcome taller than the room, home cards included, starts at the top instead of above it. */
    .draft-body {
      padding: 24px; align-items: center; align-items: safe center; min-height: 0; overflow-y: auto;
    }
    :global(html[data-keyboard='open']) .draft-body { align-items: flex-start; }
  }
</style>
