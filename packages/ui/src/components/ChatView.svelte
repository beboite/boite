<script lang="ts">
  import { untrack } from 'svelte';
  import { ChevronDown, FolderOpen } from '@lucide/svelte';
  import type { ProjectId } from '@boite/contracts';
  import { separator, type MenuItem } from '../lib/menu';
  import { fill, strings } from '../lib/strings';
  import { levelName, projectName } from '../lib/format';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { DRAFT_STASH_KEY } from '../lib/prefs';
  import { lastIndexById } from '../lib/thread-rows';
  import Composer from './Composer.svelte';
  import FolderGoneNotice from './FolderGoneNotice.svelte';
  import AgentDock from './AgentDock.svelte';
  import Menu from './Menu.svelte';
  import MessageList from './MessageList.svelte';
  import ThreadRecovery from './ThreadRecovery.svelte';
  import BackgroundHistory from './BackgroundHistory.svelte';
  import ForkReturn from './ForkReturn.svelte';
  import ProjectTile from './ProjectTile.svelte';
  import DoneThreadNotice from './DoneThreadNotice.svelte';

  let { store }: { store: Store } = $props();

  let thread = $derived(store.openThread);
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
  let effortLabel = $derived.by(() => { const level = draftModel?.effort?.levels.find((level) => level.id === draftEffort); return level ? levelName(level) : draftEffort; });
  let modelLabel = $derived(draftModel?.name ?? draftChoice?.model ?? draftProvider?.name ?? '');

  const OPEN_FOLDER = 'open-folder';

  /**
   * Every machine's drafts first, whether the core has made them yet or not,
   * then its projects, the draft's own marked, and for the owner the way to
   * open a folder: what the heading's dropdown lists.
   */
  let projectItems = $derived<MenuItem[]>([
    ...(workspace.machines.length ? workspace.machines : [{ id: '', label: '', store }]).flatMap(machine => {
      const here = machine.store === store;
      const drafts = machine.store.draftsProject;
      // One machine names no machine: the path alone tells the projects apart.
      const place = workspace.machines.length > 1 ? machine.label : '';
      return [
        {
          id: JSON.stringify([machine.id, null]),
          label: strings.drafts.name,
          hint: place ? `${place} · ${strings.drafts.hint}` : strings.drafts.hint,
          active: here && store.draftInDrafts,
          projectTile: drafts ? { project: drafts, store: machine.store } : undefined
        },
        ...machine.store.projects.filter((entry) => entry.id !== drafts?.id && entry.archived !== true).map((entry) => ({
          id: JSON.stringify([machine.id, entry.id]),
          label: projectName(entry),
          hint: place ? `${place} · ${entry.path}` : entry.path,
          active: here && entry.id === store.draft?.projectId,
          projectTile: { project: entry, store: machine.store }
        }))
      ];
    }),
    ...(store.owner ? [separator(), { id: OPEN_FOLDER, label: strings.drafts.pickFolder }] : [])
  ]);

  function pickProject(id: string) {
    if (id === OPEN_FOLDER) {
      store.projectPickerOpen = true;
      return;
    }
    const [machineId, projectId] = JSON.parse(id) as [string, ProjectId | null];
    const target = workspace.machines.find(m => m.id === machineId)?.store ?? store;
    if (target === store) store.setDraftProject(projectId);
    else if (projectId !== null) void workspace.select(target, undefined, projectId);
    else void workspace.select(target).then(() => target.startDraft(null));
  }
</script>

{#if !thread && !store.draft}
  <div class="none" data-testid="no-thread">
    <h1>{strings.thread.none}</h1>
    <p class="muted">{strings.thread.noneBody}</p>
  </div>
{:else}
  <section class="chat" class:drafting={!thread} data-testid="chat">
    {#if thread?.forkOrigin}{#key thread.id}<ForkReturn {store} {thread} />{/key}{/if}
    {#if thread}
      <!-- One timeline per thread: the heights it measured and the ids that
           already played the rise belong to that thread alone, and kept across
           a switch they grew for every message the page had ever shown. -->
      {#key thread.id}
        {#if store.loadingThreadId === thread.id && messages.length === 0}
          <div class="draft-body" data-testid="thread-loading"><p class="muted">{strings.app.loading}</p></div>
        {:else}
          <MessageList {store} threadId={thread.id} {messages} />
        {/if}
      {/key}
    {:else if sending}
      <MessageList {store} threadId={DRAFT_STASH_KEY} {messages} />
    {:else}
      <div class="draft-body" data-testid="draft-empty">
        <div class="mobile-welcome">
          <img src="./icons/icon.svg" alt="" width="42" height="42" />
          <h1>{strings.mobile.draftTitle}</h1>
          <p>{strings.mobile.draftHint}</p>
          <span class="project-choice"><Menu items={projectItems} onpick={pickProject} variant="text" label={strings.thread.changeProject} testid="mobile-draft-project">{#if project}<ProjectTile {project} {store} />{:else}<FolderOpen size={15} />{/if}<span class="project-label ui-label">{project ? projectName(project) : strings.drafts.name}</span><ChevronDown size={14} /></Menu></span>
          {#if draftChoice}<small>{strings.thread.draftMode[draftChoice.permissionMode]}</small>{/if}
          {#if store.draft?.worktree}<small>{strings.thread.inWorktree}</small>{/if}
        </div>
        <div class="draft-heading" data-testid="draft-sentence">
          <h1 class="start">
            <span class="ui-label">{strings.thread.start}</span>
            <span class="ui-label">{strings.thread.inProject}</span>
            <!-- It opens upward, into the empty half of the column: under the
                 heading it would land on the composer. -->
            <span class="project-choice"><Menu
              items={projectItems}
              onpick={pickProject}
              variant="text"
              label={strings.thread.changeProject}
              testid="draft-project"
            >
              {#if project}<ProjectTile {project} {store} />{:else}<FolderOpen size={15} />{/if}
              <span class="project-label ui-label">{project ? projectName(project) : strings.drafts.name}</span>
              <ChevronDown size={14} strokeWidth={2} />
            </Menu></span>
          </h1>
          {#if draftChoice || store.draft?.worktree}
            <p class="draft-details">
              {#if store.draft?.worktree}<span>{strings.thread.inWorktree}</span>{/if}
              {#if draftChoice}
                <span>{strings.thread.draftMode[draftChoice.permissionMode]}</span>
                <span>{strings.thread.using} {modelLabel}</span>
                {#if effortLabel}<span>{fill(strings.thread.onEffort, { effort: effortLabel })}</span>{/if}
              {/if}
            </p>
          {/if}
        </div>
      </div>
    {/if}

    {#if thread}<AgentDock {store} threadId={thread.id} />{/if}
    {#if thread?.backgroundHistory?.length}<BackgroundHistory tasks={thread.backgroundHistory} />{/if}
    {#if thread}<ThreadRecovery {store} />{/if}
    {#if !thread?.agentSessionId}
      {#if store.openProject?.missing === true}<FolderGoneNotice {store} project={store.openProject} />{/if}
      {#if thread?.archived}<DoneThreadNotice {store} threadId={thread.id} />{:else}<Composer {store} centered={!thread && !sending} />{/if}
    {/if}

    <!-- The draft's heading and composer are one block in the middle of the
         column: the body above and this tail below share the free space. -->
    {#if !thread && !sending}
      <div class="draft-tail">
        <!-- In the drafts the agent gets a fresh folder; someone with work of
             their own is one click from pointing it there instead. -->
        {#if store.draftInDrafts && store.owner}
          <button type="button" class="ghost small open-folder" data-testid="draft-open-folder" onclick={() => (store.projectPickerOpen = true)}>
            <FolderOpen size={14} strokeWidth={1.75} />
            <span class="ui-label">{strings.drafts.openFolder}</span>
          </button>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .project-choice { display: inline-flex; max-width: 100%; border: 1px dashed var(--color-muted-foreground); border-radius: var(--radius-md); }
  .project-choice:hover, .project-choice:focus-within { border-color: var(--color-accent); }
  .project-choice :global(.menu) { min-width: 0; max-width: 100%; }
  .project-choice :global(.trigger) { min-height: var(--row); height: auto; max-width: 100%; padding: 7px 12px; gap: 8px; }
  .project-label { min-width: 0; overflow-wrap: anywhere; }
  .mobile-welcome { display: none; }
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
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .chat.drafting {
    --composer-input-height: 80px;
    --composer-input-padding: 18px 20px 12px;
    --composer-bar-padding: 8px 16px 16px;
  }

  /* Zero basis on both halves, so the heading sits exactly as far below the
     top as the composer sits above the bottom: one centred block. */
  .draft-body {
    flex: 1 1 0;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 24px 20px 32px;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .draft-tail {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    justify-content: center;
    align-items: flex-start;
  }

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

  .draft-details {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 4px 6px;
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
      --composer-input-padding: 16px 16px 10px;
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
    .draft-body {
      padding: 24px; align-items: center; min-height: 0; overflow-y: auto;
    }
    :global(html[data-keyboard='open']) .draft-body { align-items: flex-start; }
  }
</style>
