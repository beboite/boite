/**
 * What an agent asked Boite to do to Boite.
 *
 * The MCP endpoint cannot carry any of this out itself. Moving a thread means
 * killing a PTY and opening a worktree; creating a project means writing rows
 * the store owns; spawning one means mounting a terminal. All of it lives here,
 * in the app, and the endpoint's whole job is to decide whether the request
 * makes sense and then say so.
 *
 * In `lib/app` rather than under a feature, which is where it used to sit: it
 * reaches into projects, threads, settings and notifications in the same
 * function, and being filed under `thread` made the one import it needs from
 * `project` into a cycle between the two.
 *
 * Which is why these arrive as an event rather than as the answer to an HTTP
 * call: two of the three kill the process that asked. The reply is written
 * while the agent is still alive to read a refusal, and the work happens after
 * it has gone.
 */

import { app } from "./store.svelte";
import { workspace } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { t } from "$lib/i18n/index.svelte";
import { settings, parseCommand } from "$lib/features/settings/store.svelte";
import { CLI_PRESETS } from "$lib/features/settings/cliPresets";
import { resolveIconKey } from "$lib/shared/icons/detect";
import { createProject } from "$lib/features/project/api";
import { moveThreadToProject } from "$lib/features/thread/move";
import { takesOpeningPrompt } from "$lib/features/thread/session";
import { launchAgent } from "$lib/features/thread/api";
import { anchorProjectId, openPane } from "$lib/features/panes/open";
import { paneStore } from "$lib/features/panes/store.svelte";
import { classifyBrowserUrl } from "$lib/features/browser/url";
import { confirmDialog } from "$lib/shared/components/confirm.svelte";
import type { DropSide, PaneContent } from "$lib/features/panes/types";
import type { IconKey } from "$lib/types";

const AGENT_REQUEST = "boite://agent-request";

interface MoveRequest {
  kind: "thread.move";
  threadId: string;
  projectId: string;
  note?: string | null;
}

interface CreateRequest {
  kind: "project.create";
  threadId?: string | null;
  name: string;
  path?: string | null;
  parent?: string | null;
  adopt: boolean;
  git: boolean;
  move: boolean;
  note?: string | null;
}

interface SpawnRequest {
  kind: "thread.spawn";
  projectId: string;
  /** The thread that asked, when Boite launched it. */
  callerThreadId?: string | null;
  agent?: string | null;
  prompt?: string | null;
}

interface PaneOpenRequest {
  kind: "pane.open";
  projectId: string;
  /** The thread that asked, so the pane lands beside it rather than beside
      whatever the user happens to be looking at. */
  callerThreadId?: string | null;
  pane: PaneContent["kind"];
  url?: string | null;
  /** The endpoint's reading of the address: off this machine, so ask first. */
  external?: boolean | null;
  side?: DropSide | null;
}

type AgentRequest =
  | MoveRequest
  | CreateRequest
  | SpawnRequest
  | PaneOpenRequest;

/**
 * Which command to start, from whatever the agent called it.
 *
 * Three things answer to the same word and all three are accepted: one of the
 * user's own shortcuts (matched on its label, because that is the name they see
 * and would tell an agent), a built-in CLI preset, and an icon key. Nothing
 * matching means falling back to the caller's own agent, which is nearly always
 * the one meant — an agent splitting its work reaches for another of itself.
 */
function resolveLaunch(
  agent: string | null | undefined,
  fallbackIcon: IconKey,
): { cmd: string; args: string[]; label: string; iconKey: IconKey; iconColor: string | null } | null {
  const needle = agent?.trim().toLowerCase() ?? "";

  if (needle) {
    const shortcut = settings.state.shortcuts.find(
      (s) => s.label.toLowerCase() === needle,
    );
    if (shortcut) {
      const parsed = parseCommand(shortcut.command || shortcut.label);
      if (parsed.cmd) {
        return {
          cmd: parsed.cmd,
          args: parsed.args,
          label: shortcut.label,
          iconKey: resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command),
          iconColor: shortcut.iconColor ?? null,
        };
      }
    }
  }

  const key = needle || fallbackIcon || "claude";
  const preset =
    CLI_PRESETS.find((p) => p.id === key) ??
    CLI_PRESETS.find((p) => p.label.toLowerCase() === key) ??
    CLI_PRESETS.find((p) => p.iconKey === key);
  if (!preset) return null;
  const parsed = parseCommand(preset.command);
  if (!parsed.cmd) return null;
  return {
    cmd: parsed.cmd,
    args: parsed.args,
    label: preset.label,
    iconKey: preset.iconKey,
    iconColor: null,
  };
}

async function handleMove(req: MoveRequest) {
  const result = await moveThreadToProject(req.threadId, req.projectId, {
    note: req.note ?? undefined,
  });
  if (!result.ok) {
    notifications.error(
      t("thread.moveFailed", { error: result.reason ?? "" }),
    );
    logger.warn("agent-request", "move refused", result.reason ?? "");
  }
}

async function handleCreate(req: CreateRequest) {
  const result = await createProject({
    name: req.name,
    path: req.path ?? undefined,
    parent: req.parent ?? undefined,
    adopt: req.adopt,
    git: req.git,
  });
  if (!result.ok || !result.project) {
    notifications.error(
      t("project.createFailed", { name: req.name, error: result.reason ?? "" }),
    );
    logger.warn("agent-request", "create refused", result.reason ?? "");
    return;
  }
  if (result.reused === "unarchived") {
    notifications.success(
      t("project.unarchivedBack", { name: result.project.name }),
    );
  } else if (!result.reused) {
    notifications.success(t("project.created", { name: result.project.name }));
  }
  if (!req.move || !req.threadId) return;

  const moved = await moveThreadToProject(req.threadId, result.project.id, {
    note: req.note ?? undefined,
    // The project notification just fired; a second one saying the same thread
    // arrived in the project it was made for is noise.
    silent: true,
  });
  if (!moved.ok) {
    notifications.error(
      t("project.createdThreadStayed", {
        name: result.project.name,
        error: moved.reason ?? "",
      }),
    );
  }
}

async function handleSpawn(req: SpawnRequest) {
  const project = app.projects.find((p) => p.id === req.projectId);
  if (!project) {
    notifications.error(t("thread.spawnProjectGone"));
    return;
  }
  // The caller, not the thread on screen: an agent that says nothing about
  // which CLI to start means another of itself, and the user may be looking
  // somewhere else entirely by the time the request lands.
  const caller = app.threadById(req.callerThreadId);
  const launch = resolveLaunch(req.agent, caller?.iconKey ?? "claude");
  if (!launch) {
    notifications.error(t("thread.spawnNoAgent", { agent: req.agent ?? "" }));
    return;
  }
  const prompt = req.prompt?.trim();
  // Not focused: the user is reading the thread that asked for this one, very
  // often in another project, and a spawn they never clicked used to take the
  // screen away mid-sentence. The toast is what says it happened.
  const thread = await launchAgent(project, launch, { focus: false });
  if (!thread) return;
  if (prompt) app.setPendingPrompt(thread.id, prompt);
  notifications.success(
    t("thread.spawnedIn", { label: launch.label, project: project.name }),
  );
  // Said out loud rather than logged. Only some CLIs take an opening
  // instruction on the command line; for the rest the new thread starts at a
  // bare prompt with no idea what it was opened for, and the agent that asked
  // for it has already been told the hand-off worked.
  if (prompt && !takesOpeningPrompt(launch.iconKey)) {
    notifications.error(
      t("thread.spawnNoPrompt", { label: launch.label, prompt }),
    );
  }
}

/**
 * Show the user something beside the terminal that asked.
 *
 * The one agent request that changes nothing: it arranges panes. Which is
 * exactly why it is worth having — an agent that has just started a dev server
 * or written a diff knows what is worth looking at, and printing a path and
 * hoping was the only way to say so.
 *
 * The caller's own pane is made the anchor first, so the pane appears next to
 * the conversation it belongs to rather than next to whichever terminal the
 * user last clicked.
 */
async function handlePaneOpen(req: PaneOpenRequest) {
  const caller = req.callerThreadId;
  if (caller && app.hasThread(caller)) {
    const group = paneStore.groupOf(caller);
    if (group) {
      group.focusedPaneId = caller;
      app.activeThreadId = caller;
      app.selectedProjectId = req.projectId;
    }
  }
  // With no caller to anchor to, the pane lands wherever the user is looking,
  // and that is very often another project. An agent in A asking for a pane
  // and getting one in B is the app answering the wrong question in somebody
  // else's workspace, so it is dropped rather than placed.
  if (anchorProjectId() !== req.projectId) {
    logger.warn(
      "agent-request",
      "pane asked for a project that is not the one on screen, dropping it",
      { asked: req.projectId },
    );
    return;
  }
  const content = await paneContentOf(req);
  if (!content) return;
  // Half the width for a browser, a third for a panel: a page needs room to be
  // a page, and a file tree does not.
  const ratio = req.pane === "browser" ? 0.5 : 0.35;
  openPane(content, req.side ?? "right", ratio);
}

/**
 * What the pane will hold, once the address in it has been through the door.
 *
 * A browser pane is the only agent request that hands the app a document to
 * host in its own window, so the address is checked here and not only at the
 * endpoint that received it: the same event also arrives from a remote boite,
 * which never went through that endpoint. Anything off this machine is the
 * user's call — the agent chose the page, and it is not the agent's window.
 */
async function paneContentOf(req: PaneOpenRequest): Promise<PaneContent | null> {
  if (req.pane !== "browser") return { kind: req.pane } as PaneContent;
  if (!req.url) {
    logger.warn("agent-request", "browser pane with no url, dropping it");
    return null;
  }
  const target = classifyBrowserUrl(req.url);
  if (!target.ok) {
    logger.warn("agent-request", "browser pane refused", {
      url: req.url,
      reason: target.reason,
    });
    notifications.error(t(`browser.refuse.${target.reason}`));
    return null;
  }
  // Either side saying "off this machine" is enough: `external` is missing on
  // a request that took another route, and a missing answer is not a no.
  if (!target.local || req.external !== false) {
    const ok = await confirmDialog.ask({
      title: t("browser.confirmExternalTitle"),
      message: t("browser.confirmExternal", { url: target.url }),
      confirmLabel: t("browser.confirmExternalOpen"),
    });
    if (!ok) return null;
  }
  return { kind: "browser", url: target.url };
}

async function handle(req: AgentRequest) {
  logger.info("agent-request", req.kind, req as unknown as Record<string, unknown>);
  switch (req.kind) {
    case "thread.move":
      return handleMove(req);
    case "project.create":
      return handleCreate(req);
    case "thread.spawn":
      return handleSpawn(req);
    case "pane.open":
      return handlePaneOpen(req);
  }
}

/**
 * The same requests, arriving from a boite instead of from this machine.
 *
 * Every connected device gets the event, because the server has no way to know
 * which one is looking — so the first thing to do is find out whether this is
 * the device that acts on it. `agent.claimRequest` answers true exactly once
 * per id; two devices running the same move would kill one PTY twice and leave
 * a second worktree behind.
 */
export async function handleRemoteAgentRequest(data: unknown) {
  const req = data as (AgentRequest & { requestId?: string }) | null;
  if (!req?.kind) return;
  const remote = workspace.remoteBackend;
  if (!req.requestId || !remote) {
    logger.warn("agent-request", "no way to claim this one, dropping it", req.kind);
    return;
  }
  const claim = remote.claimAgentRequest?.(req.requestId);
  if (!claim) {
    logger.warn("agent-request", "this boite cannot hand out claims, dropping it", req.kind);
    return;
  }
  const mine = await claim
    // A server too old to answer has no claim mechanism, and acting anyway is
    // how the same move happens twice. Nothing is lost that was not already
    // unsafe to do.
    .catch(() => false);
  if (!mine) return;
  await handle(req);
}

/**
 * Listens for as long as the app is up. Returns an unsubscribe for the caller
 * that mounted it; on the web there is no Tauri event bus and nothing to
 * listen to, so it hands back a no-op rather than failing to load.
 */
export function watchAgentRequests(): () => void {
  let stop: (() => void) | null = null;
  let dropped = false;
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<AgentRequest>(AGENT_REQUEST, (e) => {
        void handle(e.payload).catch((err) => {
          logger.error("agent-request", "failed", String(err));
        });
      }),
    )
    .then((unlisten) => {
      if (dropped) unlisten();
      else stop = unlisten;
    })
    .catch(() => {
      // No Tauri event bus (web/PWA). A remote boite delivers these over the
      // control plane instead; until it does, an agent there is told nothing
      // happened rather than being left waiting.
    });
  return () => {
    dropped = true;
    stop?.();
  };
}
