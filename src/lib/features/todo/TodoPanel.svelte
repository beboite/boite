<script lang="ts">
  import { onMount } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { app } from "$lib/app/store.svelte";
  import { projectDisplayName } from "$lib/shared/project-label";
  import { todos } from "./store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import AgentAccess from "./AgentAccess.svelte";
  import TodoList from "./TodoList.svelte";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import Eraser from "@lucide/svelte/icons/eraser";
  import PanelDockActions from "$lib/features/panes/PanelDockActions.svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Plus from "@lucide/svelte/icons/plus";

  /**
   * The todo list as a column: the cards, and the three things that only make
   * sense around a surface of its own.
   *
   * Everything you can do to a card lives in `TodoList`, which the project
   * dashboard draws too. What is left here is the header (whose project this
   * is, and clearing what is done), the input that appends to it, and the agent
   * section — a column has the room for a folding block of MCP rows and a
   * dashboard card does not.
   */

  // The pane's project when it has one, the selected project otherwise: the
  // mobile tab has no pane around it.
  // The two column verbs, passed only by SidePanel: see PanelDockActions.
  type Props = {
    projectId?: string | null;
    onClose?: () => void;
  };
  let { projectId: paneProjectId = null, onClose }: Props = $props();

  const projectId = $derived(paneProjectId ?? app.currentProjectId);
  const project = $derived(
    projectId ? app.projects.find((p) => p.id === projectId) ?? null : null,
  );
  const items = $derived(todos.forProject(projectId));
  const doneCount = $derived(items.filter((t) => t.state === "done").length);

  let draft = $state("");

  // What the shared section says is still waiting on the user, so the folded
  // header can wear the count. Held here rather than derived: the state it
  // comes from belongs to AgentAccess.
  let agentsPending = $state(0);

  // null until the user has an opinion, and then theirs holds. Folding the
  // section away the moment the last agent goes green would take the panel out
  // from under someone who had just opened it to read something.
  let agentsOpen = $state<boolean | null>(null);
  const agentsShown = $derived(agentsOpen ?? agentsPending > 0);

  // A different project has different agents wired, so the automatic answer
  // applies again.
  $effect(() => {
    projectId;
    agentsOpen = null;
  });

  onMount(() => {
    void todos.ensureLoaded();
  });

  function submitDraft(e: Event) {
    e.preventDefault();
    if (!projectId) return;
    const text = draft;
    draft = "";
    void todos.add(projectId, text);
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
    <ListTodo class="size-4 text-muted-foreground" />
    {#if project}
      <span class="truncate text-xs font-medium text-foreground/90">{projectDisplayName(project)}</span>
    {:else}
      <span class="truncate text-xs text-muted-foreground">No project</span>
    {/if}
    <button
      type="button"
      class="ml-auto rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:opacity-40"
      onclick={() => projectId && todos.clearDone(projectId)}
      disabled={doneCount === 0}
      use:tip={doneCount === 0
        ? t("todo.nothingDone")
        : t("todo.clearDone", { count: doneCount })}
      aria-label={t("todo.clearDoneLabel")}
    >
      <Eraser class="size-3.5" />
    </button>
    {#if onClose}
      <PanelDockActions {onClose} />
    {/if}
  </header>

  {#if !projectId}
    <p class="px-3 py-6 text-center text-xs text-muted-foreground">
      {t("todo.noProject")}
    </p>
  {:else}
    <TodoList {projectId} class="min-h-0 flex-1 scroll-pane overflow-y-auto" />

    <!-- Right under the list it appends to, not below the agent section: the
         input parked at the very bottom of the panel read as chrome, and
         "where do I add one" was the panel's most asked question. -->
    <form
      class="flex shrink-0 items-center gap-1.5 border-t border-border p-2"
      onsubmit={submitDraft}
    >
      <Plus class="size-3.5 shrink-0 text-muted-foreground/70" />
      <input
        type="text"
        bind:value={draft}
        placeholder={t("todo.newItem")}
        aria-label={t("todo.newItem")}
        class="min-w-0 flex-1 rounded-md border border-border bg-[var(--color-surface-2)] px-2 py-1 text-sm text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-foreground/30"
      />
    </form>

    <section class="shrink-0 border-t border-border">
      <button
        type="button"
        class="flex h-7 w-full items-center gap-1.5 px-3 text-left transition hover:bg-[var(--color-surface-2)]"
        onclick={() => (agentsOpen = !agentsShown)}
        aria-expanded={agentsShown}
      >
        <ChevronDown
          class="size-3 shrink-0 text-muted-foreground transition {agentsShown ? '' : '-rotate-90'}"
        />
        <span
          class="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {t("todo.agentAccess")}
        </span>
        <!-- Only ever counts what is waiting on the user. A section that is
             folded away because everything is wired should not also be wearing
             a number. -->
        {#if agentsPending > 0}
          <span
            class="shrink-0 rounded-full bg-[var(--color-surface-2)] px-1.5 text-2xs text-foreground/75"
          >
            {agentsPending}
          </span>
        {/if}
      </button>
      {#if agentsShown}
        <div class="border-t border-border px-3 py-2">
          <AgentAccess {project} onPending={(n) => (agentsPending = n)} />
        </div>
      {/if}
    </section>
  {/if}
</div>
