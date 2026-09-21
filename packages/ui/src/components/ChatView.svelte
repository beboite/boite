<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import type { ProjectId } from '@boite/contracts';
  import { type MenuItem } from '../lib/menu';
  import { fill, strings } from '../lib/i18n.svelte';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import Composer from './Composer.svelte';
  import Menu from './Menu.svelte';
  import MessageList from './MessageList.svelte';

  let { store }: { store: Store } = $props();

  let thread = $derived(store.openThread);
  let project = $derived(store.openProject);
  let draftChoice = $derived(store.defaultChoice());
  let draftModel = $derived(store.modelOf(draftChoice));
  let draftProvider = $derived(draftChoice ? store.providerOf(draftChoice.providerId) : null);
  let draftEffort = $derived(draftChoice?.effort ?? draftModel?.effort?.default ?? null);
  let effortLabel = $derived(draftModel?.effort?.levels.find((level) => level.id === draftEffort)?.label ?? draftEffort);
  let modelLabel = $derived(draftModel?.name ?? draftChoice?.model ?? draftProvider?.name ?? '');

  /** Every project, the draft's own marked: what the heading's dropdown lists. */
  let projectItems = $derived<MenuItem[]>(
    (workspace.machines.length ? workspace.machines : [{ id: '', label: '', store }]).flatMap(machine => machine.store.projects.map((entry) => ({
      id: JSON.stringify([machine.id, entry.id]),
      label: entry.name,
      hint: `${machine.label} · ${entry.path}`,
      active: machine.store === store && entry.id === store.draft?.projectId
    })))
  );

  function pickProject(id: string) {
    const [machineId, projectId] = JSON.parse(id) as [string, ProjectId];
    const target = workspace.machines.find(m => m.id === machineId)?.store ?? store;
    if (target === store) store.setDraftProject(projectId);
    else void workspace.select(target, undefined, projectId);
  }
</script>

{#if !thread && !store.draft}
  <div class="none">
    <h1>{strings.thread.none}</h1>
    <p class="muted">{strings.thread.noneBody}</p>
  </div>
{:else}
  <section class="chat" data-testid="chat">


    {#if thread}
      <!-- One timeline per thread: the heights it measured and the ids that
           already played the rise belong to that thread alone, and kept across
           a switch they grew for every message the page had ever shown. -->
      {#key thread.id}
        <MessageList {store} threadId={thread.id} messages={thread.messages} />
      {/key}
    {:else}
      <div class="draft-body" data-testid="draft-empty">
        <h1 class="start" data-testid="draft-sentence">
          <span>{strings.thread.start}</span>
          {#if store.draft?.worktree}<span>{strings.thread.inWorktree}</span>{/if}
          {#if draftChoice}<span>{strings.thread.draftMode[draftChoice.permissionMode]}</span>{/if}
          <span>{strings.thread.inProject}</span>
          <!-- It opens upward, into the empty half of the column: under the
               heading it would land on the composer. -->
          <Menu
            items={projectItems}
            onpick={pickProject}
            variant="text"
            label={strings.thread.changeProject}
            testid="draft-project"
          >
            &quot;{project?.name ?? ''}&quot;
            <ChevronDown size={14} strokeWidth={2} />
          </Menu>
          {#if draftChoice}
            <span>{strings.thread.using} {modelLabel}</span>
            {#if effortLabel}<span>{fill(strings.thread.onEffort, { effort: effortLabel })}</span>{/if}
          {/if}
        </h1>
      </div>
    {/if}

    <Composer {store} centered={!thread} />

    <!-- The draft's heading and composer are one block in the middle of the
         column: the body above and this tail below share the free space. -->
    {#if !thread}
      <div class="draft-tail"></div>
    {/if}
  </section>
{/if}

<style>
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

  /* Zero basis on both halves, so the heading sits exactly as far below the
     top as the composer sits above the bottom: one centred block. */
  .draft-body {
    flex: 1 1 0;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 24px 20px 16px;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .draft-tail {
    flex: 1 1 0;
    min-height: 0;
  }

  .start {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 2px 5px;
    width: 100%;
    max-width: var(--content);
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--color-foreground);
    text-align: center;
    line-height: 1.6;
  }

  @media (max-width: 720px) {
    .draft-body {
      padding: 16px 10px;
    }
  }
</style>
