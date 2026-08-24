<script module lang="ts">
  import type { McpRegistration } from "$lib/features/thread/agentMcp";
  import { tip } from "$lib/shared/actions/tooltip";

  type AgentRow = {
    key: string;
    label: string;
    cmd: string;
    auto: boolean;
    cli: string | null;
    reg: McpRegistration;
  };

  // Survives the component, keyed by project. The panel this lives in is
  // destroyed on a switch to Files and rebuilt on the way back, and starting
  // from nothing made the section blink through "empty" before re-answering
  // questions whose answers had not changed. The probe still runs on mount; it
  // just no longer has to finish before anything can be shown. Shared across
  // instances too, so the dashboard's copy and the panel's agree on arrival.
  const lastAgentRows = new Map<string, AgentRow[]>();
</script>

<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { workspace } from "$lib/backend";
  import { settings } from "$lib/features/settings/store.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { logger } from "$lib/shared/services/logger.svelte";
  import {
    agentAcceptsInjection,
    agentApiReady,
    agentCredentialsPath,
    agentHostFor,
    agentIsInstalled,
    agentSetupSnippet,
    agentSetupTarget,
    agentRegisterCli,
    agentRegistration,
    mcpPaths,
    registerAgentMcp,
  } from "$lib/features/thread/agentMcp";
  import { writeText } from "$lib/platform/clipboard";
  import { t } from "$lib/i18n/index.svelte";
  import type { Project, WorkspaceOrigin } from "$lib/types";

  /**
   * Which agents can reach this project's MCP endpoint, and what is left to do
   * about the ones that cannot.
   *
   * Its own component because two places need the same answer: the todo panel,
   * where an unwired agent explains why the list is not filling up, and the
   * project dashboard, where it is one of the things you check on arrival.
   * `onPending` exists for the panel's collapsed header — the count is derived
   * from state only this component holds.
   */
  type Props = {
    project: Project | null;
    onPending?: (count: number) => void;
  };
  let { project, onPending }: Props = $props();

  const projectId = $derived(project?.id ?? null);
  // Every answer below is a property of the machine that spawns this project's
  // agents, and this window can only ask one machine. The card used to mix the
  // two: a local shim path, a local credentials file and a local endpoint's
  // health beside one answer that had come from the boite.
  const origin = $derived(project?.origin);
  const host = $derived(agentHostFor(origin));

  let shimPath = $state<string | null>(null);
  let endpointUp = $state(true);
  let credsPath = $state<string | null>(null);
  let adding = $state<string | null>(null);

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

  // Seeded by the resolve effect below rather than here: it sets the cached
  // rows synchronously before its first await, so nothing paints empty, and
  // reading the project id at initialiser time would capture only its first
  // value anyway.
  let agentsHere = $state<AgentRow[]>([]);

  // The credentials file is per project, so it is re-read whenever the project
  // changes rather than once on mount.
  $effect(() => {
    const id = projectId;
    const at = origin;
    if (!id) {
      credsPath = null;
      return;
    }
    let cancelled = false;
    void agentCredentialsPath(id, at).then((p) => {
      if (!cancelled) credsPath = p;
    });
    return () => {
      cancelled = true;
    };
  });

  // The shim and the endpoint belong to a machine, not to a project, but which
  // machine changes with the project in dynamic mode. On mount alone they were
  // read once, against whichever project happened to be up first.
  $effect(() => {
    const at = origin;
    if (host !== "here") {
      shimPath = null;
      return;
    }
    let cancelled = false;
    void mcpPaths(at).then((p) => {
      if (!cancelled) shimPath = p?.sidecarPath ?? null;
    });
    void agentApiReady(at).then((up) => {
      if (!cancelled) endpointUp = up;
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

  async function resolveAgents(
    rows: AgentRow[],
    id: string,
    cwd: string | null,
    at: WorkspaceOrigin | undefined,
  ) {
    const present = await Promise.all(rows.map((r) => agentIsInstalled(r.cmd, at)));
    const here = rows.filter((_, i) => present[i]);
    // Only the ones Boite cannot wire at launch have a config to look into;
    // claude and codex are handed everything and keep nothing on disk.
    const regs = await Promise.all(
      here.map((r) =>
        r.auto
          ? Promise.resolve("this" as const)
          : agentRegistration(r.key as never, id, cwd, at),
      ),
    );
    return here.map((r, i) => ({ ...r, reg: regs[i] }));
  }

  $effect(() => {
    const rows = candidates;
    const id = projectId;
    const cwd = project?.cwd ?? null;
    const at = origin;
    // Nothing to resolve for a machine that cannot be asked, and nothing worth
    // putting on a five-second timer either: the poll exists to notice a config
    // file the user edited outside Boite, and there is no such file here.
    if (!id || host !== "here") {
      agentsHere = [];
      return;
    }
    agentsHere = lastAgentRows.get(id) ?? [];
    let cancelled = false;
    const run = () =>
      void resolveAgents(rows, id, cwd, at).then((next) => {
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
    const settled = () => agentsHere.length > 0 && agentsHere.every((a) => a.reg === "this");
    const timer = setInterval(() => {
      // A hidden window is a laptop lid or a phone in a pocket, and a tick
      // there reads config files off disk for a panel nobody is looking at.
      // The catch-up below covers what the pause missed, so nothing is lost by
      // skipping: the poll exists to notice a change made outside Boite, and
      // noticing it on the way back is soon enough.
      if (document.hidden || settled()) return;
      run();
    }, 5000);
    const wake = () => {
      if (!document.hidden && !settled()) run();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  });

  // Agents still waiting on the user. An unreachable endpoint or a missing shim
  // counts too: nothing works in either case, and the row saying so is the only
  // place that says it.
  //
  // A boite counts as nothing. Pending means there is something to do from
  // here, and there is not: the wiring happens on that machine. A badge that
  // can never reach zero is a badge people stop reading.
  const pending = $derived.by(() => {
    if (!settings.state.agentTodoAccess || host !== "here") return 0;
    if (shimPath === null || !endpointUp) return 1;
    return agentsHere.filter((a) => a.reg !== "this").length;
  });

  $effect(() => {
    onPending?.(pending);
  });

  async function copySetup(agent: AgentRow) {
    if (!shimPath || !credsPath) return;
    const snippet = agentSetupSnippet(agent.key as never, shimPath, credsPath);
    if (!snippet) return copyPath();
    try {
      await writeText(snippet);
    } catch (err) {
      logger.error("todo", "copy setup snippet failed", err);
      notifications.error(t("terminal.copyFailed"));
      return;
    }
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
    try {
      await writeText(shimPath);
    } catch (err) {
      logger.error("todo", "copy shim path failed", err);
      notifications.error(t("terminal.copyFailed"));
      return;
    }
    notifications.success(t("todo.agentPathCopied"));
  }

  async function addToAgent(label: string, cli: string) {
    adding = cli;
    try {
      await registerAgentMcp(cli, origin);
      notifications.success(t("todo.agentAdded", { agent: label }));
    } catch (err) {
      notifications.error(t("todo.agentAddFailed", { agent: label, error: String(err) }));
    } finally {
      adding = null;
    }
  }
</script>

{#if !settings.state.agentTodoAccess}
  <p class="text-xs text-muted-foreground">{t("todo.agentOff")}</p>
{:else if host !== "here"}
  <!-- Said rather than answered. The shim, the credentials file and the
       endpoint are three files on the machine that spawns, and nothing in the
       transport carries any of the three, so every row below would have been
       this device's answer wearing the boite's name. -->
  <p class="text-xs leading-snug text-muted-foreground">
    {t("todo.agentOnBoite", { name: workspace.info.name || "boite" })}
  </p>
{:else if shimPath === null}
  <p class="text-xs text-muted-foreground">{t("todo.agentUnavailable")}</p>
{:else if !endpointUp}
  <p class="text-xs text-muted-foreground">{t("todo.agentEndpointDown")}</p>
{:else}
  {#each agentsHere as agent (agent.key)}
    <div class="flex items-center gap-2 py-0.5">
      <span class="min-w-0 flex-1 truncate text-sm text-foreground/80">
        {agent.label}
      </span>
      {#if agent.auto || agent.reg === "this"}
        <span class="shrink-0 text-xs text-muted-foreground" use:tip={t("todo.agentReadyHint")}>
          {t("todo.agentActive")}
        </span>
      {:else if agent.cli}
        <button
          type="button"
          class="shrink-0 rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
          onclick={() => addToAgent(agent.label, agent.cli!)}
          disabled={adding !== null}
        >
          {t("todo.agentAdd")}
        </button>
      {:else}
        <!-- No verified way to register this one from a command line. Inventing
             `<agent> mcp add …` from the label was wrong twice over: the binary
             is not always the label (cursor runs as `cursor-agent`, antigravity
             as `agy`) and the subcommand is not always non-interactive
             (copilot's opens a form).
             So offer the path and let the user register it the way their agent
             documents. -->
        <button
          type="button"
          class="shrink-0 rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
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
    <!-- Nothing to wire automatically: a project of plain shells, or one whose
         first agent has not been launched. The shim still exists, so say where
         it is rather than leave the panel silent. -->
    <p class="text-xs leading-snug text-muted-foreground">{t("todo.agentNone")}</p>
    <button
      type="button"
      class="mt-1 rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      onclick={copyPath}
    >
      {t("todo.agentCopyPath")}
    </button>
  {/if}
{/if}
