<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { ptyWrite } from "$lib/storage/pty";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import CornerDownRight from "@lucide/svelte/icons/corner-down-right";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Eraser from "@lucide/svelte/icons/eraser";

  const encoder = new TextEncoder();

  const projectId = $derived(app.currentProjectId);
  const project = $derived(
    projectId ? app.projects.find((p) => p.id === projectId) ?? null : null,
  );
  const items = $derived(settings.todosFor(projectId));
  const doneCount = $derived(items.filter((t) => t.done).length);

  // Handing an item over writes into whatever thread is in front. A thread with
  // no live PTY (never started, or exited) has nothing to receive it.
  const target = $derived(app.activeThread);
  const canSend = $derived(!!target?.ptyId);

  let draft = $state("");

  function submitDraft(e: Event) {
    e.preventDefault();
    if (!projectId) return;
    const text = draft;
    draft = "";
    void settings.addTodo(projectId, text);
  }

  /**
   * Types the item into the active terminal without submitting it. Sending the
   * newline too would launch an agent run from a single mis-click, and an agent
   * turn is expensive and hard to call back — the user presses Enter.
   */
  function handOff(text: string) {
    const ptyId = target?.ptyId;
    if (!ptyId) return;
    // Any newline in the payload would submit on the agent's behalf, so a
    // multi-line item collapses to one line before it is written.
    const oneLine = text.replace(/[\r\n]+/g, " ").trim();
    if (!oneLine) return;
    void ptyWrite(ptyId, encoder.encode(oneLine)).catch((err) => {
      notifications.error(`Could not reach the terminal: ${err}`);
    });
    app.view = "terminal";
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
    <ListTodo class="size-4 text-muted-foreground" />
    {#if project}
      <span class="truncate text-xs font-medium text-foreground/90">{project.name}</span>
    {:else}
      <span class="truncate text-xs text-muted-foreground">No project</span>
    {/if}
    <button
      type="button"
      class="ml-auto rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:opacity-40"
      onclick={() => projectId && settings.clearDoneTodos(projectId)}
      disabled={doneCount === 0}
      title={doneCount === 0 ? "Nothing done yet" : `Clear ${doneCount} done`}
      aria-label="Clear done items"
    >
      <Eraser class="size-3.5" />
    </button>
  </header>

  {#if !projectId}
    <p class="px-3 py-6 text-center text-xs text-muted-foreground">
      Pick a project to keep notes against it.
    </p>
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if items.length === 0}
        <p class="px-3 py-6 text-center text-xs text-muted-foreground">
          Nothing noted for this project.
        </p>
      {/if}
      {#each items as item (item.id)}
        <div
          class="group flex items-start gap-2 border-b border-border/50 px-3 py-1.5 transition hover:bg-[var(--color-surface-2)]"
        >
          <input
            type="checkbox"
            class="mt-[3px] size-3.5 shrink-0 accent-[var(--color-foreground)]"
            checked={item.done}
            onchange={(e) =>
              projectId &&
              settings.setTodoDone(
                projectId,
                item.id,
                (e.currentTarget as HTMLInputElement).checked,
              )}
            aria-label={item.done ? "Mark not done" : "Mark done"}
          />
          <input
            type="text"
            value={item.text}
            onchange={(e) =>
              projectId &&
              settings.updateTodoText(
                projectId,
                item.id,
                (e.currentTarget as HTMLInputElement).value,
              )}
            class="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[12px] leading-snug outline-none transition focus:border-border focus:bg-[var(--color-surface)] {item.done
              ? 'text-muted-foreground/60 line-through'
              : 'text-foreground'}"
          />
          <button
            type="button"
            class="mt-[1px] shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-0 transition group-hover:opacity-100 hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground/50"
            onclick={() => handOff(item.text)}
            disabled={!canSend}
            title={canSend
              ? `Type this into ${target?.title ?? target?.label ?? "the terminal"} (you press Enter)`
              : "No running terminal to send it to"}
            aria-label="Send to the active terminal"
          >
            <CornerDownRight class="size-3.5" />
          </button>
          <button
            type="button"
            class="mt-[1px] shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-0 transition group-hover:opacity-100 hover:bg-danger/15 hover:text-danger"
            onclick={() => projectId && settings.removeTodo(projectId, item.id)}
            title="Remove"
            aria-label="Remove item"
          >
            <Trash2 class="size-3" />
          </button>
        </div>
      {/each}
    </div>

    <form class="shrink-0 border-t border-border p-2" onsubmit={submitDraft}>
      <input
        type="text"
        bind:value={draft}
        placeholder="New item…"
        class="w-full rounded-md border border-border bg-[var(--color-surface-2)] px-2 py-1 text-[12px] text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-foreground/30"
      />
    </form>
  {/if}
</div>
