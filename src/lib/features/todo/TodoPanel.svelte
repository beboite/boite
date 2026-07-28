<script module lang="ts">
  import type { McpRegistration } from "$lib/features/thread/agentMcp";

  type AgentRow = {
    key: string;
    label: string;
    cmd: string;
    auto: boolean;
    cli: string | null;
    reg: McpRegistration;
  };

  // Survives the component, keyed by project. Filled in by the resolve effect
  // below; read on mount so a rebuilt panel starts from the last answer instead
  // of from nothing.
  const lastAgentRows = new Map<string, AgentRow[]>();
</script>

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
    agentSetupTarget,
    agentRegisterCli,
    agentRegistration,
    mcpPaths,
    registerAgentMcp,
  } from "$lib/features/thread/agentMcp";
  import { writeText } from "$lib/platform/clipboard";
  import { openUrl } from "$lib/platform/opener";
  import { claimGitState, type ClaimGit } from "./claimGit";
  import type { TodoItem } from "$lib/types";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import CornerDownRight from "@lucide/svelte/icons/corner-down-right";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Eraser from "@lucide/svelte/icons/eraser";
  import Check from "@lucide/svelte/icons/check";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Bot from "@lucide/svelte/icons/bot";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";

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
        reg: "none",
      });
    }
    return [...seen.values()];
  });

  // Outside the component for the same reason the commit lookups are: the panel
  // is destroyed on a switch to Files and rebuilt on the way back, and starting
  // from nothing made the section blink through "empty" before re-answering
  // questions whose answers had not changed. The probe still runs on mount; it
  // just no longer has to finish before anything can be shown.
  // Seeded by the resolve effect below rather than here: it sets the cached
  // rows synchronously before its first await, so nothing paints empty, and
  // reading the project id at initialiser time would capture only its first
  // value anyway.
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

  function sameRows(a: AgentRow[], b: AgentRow[]): boolean {
    return (
      a.length === b.length &&
      a.every((row, i) => {
        const other = b[i];
        return (
          row.key === other.key &&
          row.reg === other.reg &&
          row.cmd === other.cmd &&
          row.auto === other.auto &&
          row.cli === other.cli
        );
      })
    );
  }

  async function resolveAgents(rows: AgentRow[], id: string, cwd: string | null) {
    const present = await Promise.all(rows.map((r) => agentIsInstalled(r.cmd)));
    const here = rows.filter((_, i) => present[i]);
    // Only the ones Boite cannot wire at launch have a config to look into;
    // claude and codex are handed everything and keep nothing on disk.
    const regs = await Promise.all(
      here.map((r) => (r.auto ? Promise.resolve("this" as const) : agentRegistration(r.key as never, id, cwd))),
    );
    return here.map((r, i) => ({ ...r, reg: regs[i] }));
  }

  $effect(() => {
    const rows = candidates;
    const id = projectId;
    const cwd = project?.cwd ?? null;
    if (!id) {
      agentsHere = [];
      return;
    }
    agentsHere = lastAgentRows.get(id) ?? [];
    let cancelled = false;
    const run = () =>
      void resolveAgents(rows, id, cwd).then((next) => {
        lastAgentRows.set(id, next);
        // The poll below re-answers the same question every five seconds and
        // the answer almost never changes. Assigning anyway would rebuild this
        // section on a timer, so the array is only swapped when a row moved.
        if (!cancelled && !sameRows(agentsHere, next)) agentsHere = next;
      });
    run();
    // The registration happens outside Boite — the user pastes a line into
    // their agent — so nothing here would ever hear about it. Re-reading a
    // handful of small config files is the cheapest way to notice, and it stops
    // as soon as every agent is wired.
    const timer = setInterval(() => {
      if (agentsHere.length > 0 && agentsHere.every((a) => a.reg === "this")) return;
      run();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  });

  async function copySetup(agent: AgentRow) {
    if (!shimPath || !credsPath) return;
    const snippet = agentSetupSnippet(agent.key as never, shimPath, credsPath);
    if (!snippet) return copyPath();
    await writeText(snippet);
    // A command says where it goes; a JSON fragment does not, so name the file.
    const file = agentSetupTarget(agent.key as never);
    notifications.success(
      file
        ? t("todo.agentSetupCopiedFile", { file })
        : t("todo.agentSetupCopied", { agent: agent.label }),
    );
  }

  async function copyPath() {
    if (!shimPath) return;
    await writeText(shimPath);
    notifications.success(t("todo.agentPathCopied"));
  }

  // Agents still waiting on the user. An unreachable endpoint or a missing shim
  // counts too: nothing works in either case, and the row saying so is the only
  // place that says it.
  const agentsPending = $derived.by(() => {
    if (!settings.state.agentTodoAccess) return 0;
    if (shimPath === null || !endpointUp) return 1;
    return agentsHere.filter((a) => a.reg !== "this").length;
  });

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

  // The repository the sha has to exist in. gitRoot is only filled in once the
  // project has been inspected, so the cwd stands in — git resolves a sha from
  // anywhere inside the work tree.
  const gitRoot = $derived(project?.gitRoot ?? project?.cwd ?? null);

  function gitState(item: TodoItem): Promise<ClaimGit | null> {
    const sha = item.commitSha;
    const root = gitRoot;
    if (!sha || !root) return Promise.resolve(null);
    return claimGitState(root, sha);
  }

  function openPr(url: string) {
    if (url) void openUrl(url);
  }

  // The same box the Confirm/Reopen buttons draw, minus its resting border, so
  // the strip stays a line of text until a pointer is on it.
  const CHIP =
    "rounded border border-transparent px-1 py-0.5 transition hover:border-border hover:bg-[var(--color-surface-2)] hover:text-foreground";

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
          <div class="flex items-center gap-2">
            <!-- The native control was the one white rectangle in the app: it
                 draws itself, ignores the border and surface tokens, and sits on
                 its own baseline rather than the row's. This is the same box the
                 rest of Boite draws. -->
            <button
              type="button"
              role="checkbox"
              aria-checked={item.state === "done"}
              aria-label={item.state === "done" ? t("todo.markNotDone") : t("todo.markDone")}
              class="grid size-[15px] shrink-0 place-items-center rounded-[4px] border transition {item.state ===
              'done'
                ? 'border-foreground/30 bg-foreground/80 text-[var(--color-surface)]'
                : 'border-border text-transparent hover:border-foreground/40'}"
              onclick={() =>
                todos.setState(item.id, item.state === "done" ? "open" : "done")}
            >
              <Check class="size-2.5" strokeWidth={3.5} />
            </button>
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
              class="grid size-[22px] shrink-0 place-items-center rounded text-muted-foreground/50 opacity-0 transition group-hover:opacity-100 hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground/50"
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
              class="grid size-[22px] shrink-0 place-items-center rounded text-muted-foreground/50 opacity-0 transition group-hover:opacity-100 hover:bg-danger/15 hover:text-danger"
              onclick={() => todos.remove(item.id)}
              title={t("todo.remove")}
              aria-label={t("todo.removeLabel")}
            >
              <Trash2 class="size-3.5" />
            </button>
          </div>

          <!-- Shown while the task is still live — claimed, or reopened after a
               claim — because that is when where the work landed is something
               you act on. A ticked box is a closed matter and collapses back to
               one line. Nothing is cleared either way: unticking brings the same
               strip back rather than an empty one. -->
          {#if item.state !== "done" && (item.claimedBy || item.commitSha || item.note)}
            <!-- What the agent said, reduced to what can be checked. The
                 sentence it wrote is not shown at all: it is the one part of a
                 claim nothing can back, and the badge next to it says who by.
                 It is still stored, and still what a reopened task is judged on.

                 Not selectable: this is a readout, and every chip on it is a
                 hover target, so dragging across one only produced a highlight
                 nobody asked for. -->
            <div
              class="mt-1 flex select-none items-center gap-1 pl-[23px] text-[10.5px] text-muted-foreground"
            >
              <!-- A label, not a control: nothing hides behind it, so it gets
                   no box and no hover of its own. -->
              <span class="flex shrink-0 items-center px-0.5">
                {#if item.claimedBy}
                  <ShortcutIcon iconKey={item.claimedBy} size={12} />
                {:else}
                  <!-- Claimed through a credentials file, which names a project
                       and no thread: Boite did not launch this one and cannot
                       say which agent it was. -->
                  <Bot class="size-3 shrink-0 text-muted-foreground/70" />
                {/if}
              </span>
              {#await gitState(item) then g}
                {#if !item.commitSha}
                  <span class="px-1 text-muted-foreground/70">{t("todo.gitNoCommit")}</span>
                {:else if !g}
                  <!-- Nowhere to look it up: no project folder to run git in.
                       Shown bare rather than judged — not finding a repository
                       is not the same as not finding the commit. -->
                  <code class="px-1 font-mono text-muted-foreground/70">
                    {item.commitSha.slice(0, 7)}
                  </code>
                {:else if !g.commit.known}
                  <!-- Reported a sha the repository has never heard of. Said
                       plainly: this is the one claim git can flatly contradict. -->
                  <span class="group/tip relative text-warning {CHIP}">
                    {t("todo.gitUnknownCommit")}
                    {@render tip(item.commitSha)}
                  </span>
                {:else}
                  <!-- The branch first: it says where the work is, which is the
                       question being asked. The sha is what was verified, so it
                       stays reachable rather than on show. -->
                  <span class="group/tip relative min-w-0 {CHIP}">
                    <span class="block truncate text-foreground/80">
                      {g.commit.branch ?? g.commit.short}
                    </span>
                    {@render tip(
                      `${g.commit.short}${g.commit.subject ? ` — ${g.commit.subject}` : ""}`,
                    )}
                  </span>
                  <span class="shrink-0 text-muted-foreground/40">·</span>
                  <span
                    class="shrink-0 px-1 {g.commit.pushed ? '' : 'text-muted-foreground/70'}"
                  >
                    {g.commit.pushed ? t("todo.gitPushed") : t("todo.gitLocal")}
                  </span>
                  {#if g.pr.kind === "found"}
                    <span class="shrink-0 text-muted-foreground/40">·</span>
                    <button
                      type="button"
                      class="group/tip relative shrink-0 {CHIP}"
                      onclick={() => openPr(g.pr.kind === "found" ? g.pr.pr.url : "")}
                    >
                      {t("todo.gitPr", { number: String(g.pr.pr.number) })}
                      {@render tip(g.pr.pr.url)}
                    </button>
                  {:else if g.pr.kind === "failed"}
                    <!-- gh was there and refused. Said, because unlike a missing
                         gh this is a state the user can be in without knowing —
                         and the signed-out case they can fix in one command. -->
                    <span class="shrink-0 text-muted-foreground/40">·</span>
                    <span class="group/tip relative shrink-0 text-warning/80 {CHIP}">
                      {g.pr.auth ? t("todo.gitPrNoAuth") : t("todo.gitPrFailed")}
                      {@render tip(g.pr.auth ? t("todo.gitPrNoAuthHint") : g.pr.detail)}
                    </span>
                  {/if}
                {/if}
              {/await}
            </div>
          {/if}

          {#if item.state === "claimed"}
            <!-- An agent said it finished, and it stops here on purpose: a model
                 that can tick its own boxes will, and the list would then record
                 assertions instead of verified work. -->
            <div class="mt-1 flex gap-1 pl-[23px]">
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
          class="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {t("todo.agentAccess")}
        </span>
        <!-- Only ever counts what is waiting on the user. A section that is
             folded away because everything is wired should not also be wearing
             a number. -->
        {#if agentsPending > 0}
          <span
            class="shrink-0 rounded-full bg-[var(--color-surface-2)] px-1.5 text-[10px] text-foreground/75"
          >
            {agentsPending}
          </span>
        {/if}
      </button>
      {#if agentsShown}
        <div class="border-t border-border px-3 py-2">
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
              {#if agent.auto || agent.reg === "this"}
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
      {/if}
    </section>

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

{#snippet tip(text: string)}
  <!-- Replaces the native `title`, whose ~1s delay is the browser's and cannot
       be configured. Appears on hover with nothing in between.
       Below the chip, not above: the list scrolls, and anything absolute is
       clipped by that container at whichever edge it crosses. Measured — above
       the chip it lost 4.5px off the top row, which is the row that is always on
       screen, while below it there is nearly always list left. Left-aligned to
       the chip so a long one grows into the panel rather than off it. -->
  <span
    class="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-max max-w-[240px] rounded border border-border bg-[var(--color-surface-2)] px-1.5 py-0.5 text-left text-[10.5px] leading-snug text-foreground shadow-md group-hover/tip:block"
  >
    {text}
  </span>
{/snippet}
