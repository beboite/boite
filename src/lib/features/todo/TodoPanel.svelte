<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { todos } from "./store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { ptyWrite } from "$lib/storage/pty";
  import {
    agentAcceptsInjection,
    agentApiReady,
    agentCredentialsPath,
    agentIsInstalled,
    agentSetupSnippet,
    agentRegisterCli,
    mcpPaths,
    registerAgentMcp,
  } from "$lib/features/thread/agentMcp";
  import { writeText } from "$lib/platform/clipboard";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import CornerDownRight from "@lucide/svelte/icons/corner-down-right";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Eraser from "@lucide/svelte/icons/eraser";
  import Check from "@lucide/svelte/icons/check";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import Bot from "@lucide/svelte/icons/bot";

  const encoder = new TextEncoder();

  const projectId = $derived(app.currentProjectId);
  const project = $derived(
    projectId ? app.projects.find((p) => p.id === projectId) ?? null : null,
  );
  const items = $derived(todos.forProject(projectId));
  const doneCount = $derived(items.filter((t) => t.state === "done").length);

  // Handing an item over writes into whatever thread is in front. A thread with
  // no live PTY (never started, or exited) has nothing to receive it.
  const target = $derived(app.activeThread);
  const canSend = $derived(!!target?.ptyId);

  let draft = $state("");
  let shimPath = $state<string | null>(null);
  let endpointUp = $state(true);
  let credsPath = $state<string | null>(null);

  type AgentRow = {
    key: string;
    label: string;
    cmd: string;
    auto: boolean;
    cli: string | null;
  };

  // Candidates from the project's threads. A thread outlives the tool that made
  // it — clicking a shortcut once on a machine without that CLI leaves the
  // thread behind for good — so the binary is probed before any of this is
  // shown, and the probe uses the thread's own command rather than the icon.
  const candidates = $derived.by(() => {
    if (!projectId) return [] as AgentRow[];
    const seen = new Map<string, AgentRow>();
    for (const th of app.threadsByProject(projectId)) {
      const key = th.iconKey;
      if (!key || key === "terminal" || seen.has(key)) continue;
      seen.set(key, {
        key,
        label: key.charAt(0).toUpperCase() + key.slice(1),
        cmd: th.cmd,
        auto: agentAcceptsInjection(key),
        cli: agentRegisterCli(key),
      });
    }
    return [...seen.values()];
  });

  let agentsHere = $state<AgentRow[]>([]);

  // The credentials file is per project, so it is re-read whenever the project
  // changes rather than once on mount.
  $effect(() => {
    const id = projectId;
    if (!id) {
      credsPath = null;
      return;
    }
    let cancelled = false;
    void agentCredentialsPath(id).then((p) => {
      if (!cancelled) credsPath = p;
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const rows = candidates;
    let cancelled = false;
    void Promise.all(rows.map((r) => agentIsInstalled(r.cmd))).then((present) => {
      if (!cancelled) agentsHere = rows.filter((_, i) => present[i]);
    });
    return () => {
      cancelled = true;
    };
  });

  async function copySetup(agent: AgentRow) {
    if (!shimPath || !credsPath) return;
    const snippet = agentSetupSnippet(agent.key as never, shimPath, credsPath);
    if (!snippet) return copyPath();
    await writeText(snippet);
    notifications.success(t("todo.agentSetupCopied", { agent: agent.label }));
  }

  async function copyPath() {
    if (!shimPath) return;
    await writeText(shimPath);
    notifications.success(t("todo.agentPathCopied"));
  }

  let adding = $state<string | null>(null);

  async function addToAgent(label: string, cli: string) {
    adding = cli;
    try {
      await registerAgentMcp(cli);
      notifications.success(t("todo.agentAdded", { agent: label }));
    } catch (err) {
      notifications.error(t("todo.agentAddFailed", { agent: label, error: String(err) }));
    } finally {
      adding = null;
    }
  }

  onMount(() => {
    void todos.ensureLoaded();
    void mcpPaths().then((p) => (shimPath = p?.sidecarPath ?? null));
    void agentApiReady().then((up) => (endpointUp = up));
  });

  function submitDraft(e: Event) {
    e.preventDefault();
    if (!projectId) return;
    const text = draft;
    draft = "";
    void todos.add(projectId, text);
  }

  /**
   * Types the scaffolded task into the active terminal without submitting it.
   * Sending the newline too would launch an agent run from a single mis-click,
   * and an agent turn is expensive and hard to call back — the user presses
   * Enter. The prompt carries the todo id so the agent can claim it back.
   */
  function handOff(id: string, text: string) {
    const ptyId = target?.ptyId;
    if (!ptyId) return;
    const prompt = settings.state.todoPromptTemplate
      .replaceAll("{{task}}", text)
      .replaceAll("{{id}}", id);
    // Any newline in the payload would submit on the agent's behalf, so the
    // whole scaffold collapses to one line before it is written.
    const oneLine = prompt.replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (!oneLine) return;
    void ptyWrite(ptyId, encoder.encode(oneLine)).catch((err) => {
      notifications.error(t("todo.terminalUnreachable", { error: String(err) }));
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
      onclick={() => projectId && todos.clearDone(projectId)}
      disabled={doneCount === 0}
      title={doneCount === 0
        ? t("todo.nothingDone")
        : t("todo.clearDone", { count: doneCount })}
      aria-label={t("todo.clearDoneLabel")}
    >
      <Eraser class="size-3.5" />
    </button>
  </header>

  {#if !projectId}
    <p class="px-3 py-6 text-center text-xs text-muted-foreground">
      {t("todo.noProject")}
    </p>
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if items.length === 0 && !todos.loading}
        <p class="px-3 py-6 text-center text-xs text-muted-foreground">
          {t("todo.empty")}
        </p>
      {/if}
      {#each items as item (item.id)}
        <div
          class="group border-b border-border/50 px-3 py-1.5 transition hover:bg-[var(--color-surface-2)] {item.state ===
          'claimed'
            ? 'bg-[var(--color-surface-2)]/60'
            : ''}"
        >
          <div class="flex items-start gap-2">
            <input
              type="checkbox"
              class="mt-[3px] size-3.5 shrink-0 accent-[var(--color-foreground)]"
              checked={item.state === "done"}
              onchange={(e) =>
                todos.setState(
                  item.id,
                  (e.currentTarget as HTMLInputElement).checked ? "done" : "open",
                )}
              aria-label={item.state === "done" ? t("todo.markNotDone") : t("todo.markDone")}
            />
            <input
              type="text"
              value={item.text}
              onchange={(e) =>
                todos.setText(item.id, (e.currentTarget as HTMLInputElement).value)}
              class="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[12px] leading-snug outline-none transition focus:border-border focus:bg-[var(--color-surface)] {item.state ===
              'done'
                ? 'text-muted-foreground/60 line-through'
                : 'text-foreground'}"
            />
            <button
              type="button"
              class="mt-[1px] shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-0 transition group-hover:opacity-100 hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground/50"
              onclick={() => handOff(item.id, item.text)}
              disabled={!canSend}
              title={canSend
                ? t("todo.sendTo", {
                    target: target?.title ?? target?.label ?? "the terminal",
                  })
                : t("todo.sendNoTerminal")}
              aria-label={t("todo.sendLabel")}
            >
              <CornerDownRight class="size-3.5" />
            </button>
            <button
              type="button"
              class="mt-[1px] shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-0 transition group-hover:opacity-100 hover:bg-danger/15 hover:text-danger"
              onclick={() => todos.remove(item.id)}
              title={t("todo.remove")}
              aria-label={t("todo.removeLabel")}
            >
              <Trash2 class="size-3" />
            </button>
          </div>

          {#if item.state === "claimed"}
            <!-- An agent said it finished. It stops here on purpose: a model
                 that can tick its own boxes will, and the list would then record
                 assertions instead of verified work. -->
            <div class="mt-1 flex items-start gap-1.5 pl-[22px]">
              <Bot class="mt-[2px] size-3 shrink-0 text-muted-foreground/70" />
              <p class="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
                {item.note ?? t("todo.agentReported")}
              </p>
            </div>
            <div class="mt-1 flex gap-1 pl-[22px]">
              <button
                type="button"
                class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
                onclick={() => todos.setState(item.id, "done")}
              >
                <Check class="size-3" />
                {t("todo.confirm")}
              </button>
              <button
                type="button"
                class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
                onclick={() => todos.setState(item.id, "open")}
              >
                <Undo2 class="size-3" />
                {t("todo.reopen")}
              </button>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <div class="shrink-0 border-t border-border px-3 py-2">
        <p class="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
          {t("todo.agentAccess")}
        </p>
        {#if !settings.state.agentTodoAccess}
          <p class="text-[11px] text-muted-foreground">{t("todo.agentOff")}</p>
        {:else if shimPath === null}
          <p class="text-[11px] text-muted-foreground">{t("todo.agentUnavailable")}</p>
        {:else if !endpointUp}
          <p class="text-[11px] text-muted-foreground">{t("todo.agentEndpointDown")}</p>
        {:else}
          {#each agentsHere as agent (agent.key)}
            <div class="flex items-center gap-2 py-0.5">
              <span class="min-w-0 flex-1 truncate text-[11.5px] text-foreground/85">
                {agent.label}
              </span>
              {#if agent.auto}
                <span
                  class="shrink-0 text-[10.5px] text-muted-foreground"
                  title={t("todo.agentReadyHint")}
                >
                  {t("todo.agentActive")}
                </span>
              {:else if agent.cli}
                <button
                  type="button"
                  class="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
                  onclick={() => addToAgent(agent.label, agent.cli!)}
                  disabled={adding !== null}
                >
                  {t("todo.agentAdd")}
                </button>
              {:else}
                <!-- No verified way to register this one from a command line.
                     Inventing `<agent> mcp add …` from the label was wrong twice
                     over: the binary is not always the label (copilot runs as
                     `gh copilot`) and the subcommand is not always
                     non-interactive (copilot's opens a form). So offer the path
                     and let the user register it the way their agent documents. -->
                <button
                  type="button"
                  class="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
                  onclick={() => copySetup(agent)}
                >
                  {agentSetupSnippet(agent.key as never, "x", "y")
                    ? t("todo.agentSetup")
                    : t("todo.agentCopyPath")}
                </button>
              {/if}
            </div>
          {/each}
          {#if agentsHere.length === 0}
            <!-- Nothing to wire automatically: a project of plain shells, or one
                 whose first agent has not been launched. The shim still exists,
                 so say where it is rather than leave the panel silent. -->
            <p class="text-[11px] leading-snug text-muted-foreground">
              {t("todo.agentNone")}
            </p>
            <button
              type="button"
              class="mt-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
              onclick={copyPath}
            >
              {t("todo.agentCopyPath")}
            </button>
          {/if}
        {/if}
      </div>

    <form class="shrink-0 border-t border-border p-2" onsubmit={submitDraft}>
      <input
        type="text"
        bind:value={draft}
        placeholder={t("todo.newItem")}
        class="w-full rounded-md border border-border bg-[var(--color-surface-2)] px-2 py-1 text-[12px] text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-foreground/30"
      />
    </form>
  {/if}
</div>
