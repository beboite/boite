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
import { anchorPaneId, anchorProjectId, openPane } from "$lib/features/panes/open";
import { leafNodesOf, paneStore } from "$lib/features/panes/store.svelte";
import { classifyBrowserUrl, isLoopbackHost } from "$lib/features/browser/url";
import { browserPanes } from "$lib/features/browser/state.svelte";
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

/**
 * An agent driving a browser pane it already opened.
 *
 * Three verbs and one shape, because they differ only in what they do once the
 * pane is found and every check before that is the same one. The endpoint has
 * usually run those checks already, off the window's own description; this runs
 * them again because the endpoint cannot see a window it does not have — a
 * headless boite dispatches these blind, and the device is the only side that
 * knows which panes exist. Same reasoning as `paneContentOf`: the frame is
 * created here, so the last word belongs here.
 */
interface BrowserDriveRequest {
  kind: "browser.navigate" | "browser.reload" | "browser.close";
  projectId: string;
  /** The thread that asked. It has to match the pane's mark or nothing moves. */
  callerThreadId?: string | null;
  /** Which pane, when the agent is driving more than one. */
  paneId?: string | null;
  url?: string | null;
  /** The endpoint's reading of the address: off this machine, so ask first. */
  external?: boolean | null;
}

type AgentRequest =
  | MoveRequest
  | CreateRequest
  | SpawnRequest
  | PaneOpenRequest
  | BrowserDriveRequest;

/**
 * Which machine's process wrote the request.
 *
 * "boite" is the control plane: another machine's agent, whose idea of a path,
 * a port or loopback is not this window's. Carried rather than inferred from
 * `workspace.mode`, because in dynamic mode both arrive at the same handler.
 */
type RequestSource = "device" | "boite";

/**
 * Whether an address in the request was written on the machine reading it.
 *
 * A boite reachable at a loopback host is running here after all, so its
 * agents' `http://localhost:5173` means the same port this window would reach
 * and stays usable. Anything else is a second machine.
 */
function writtenOnThisMachine(from: RequestSource): boolean {
  if (from === "device") return true;
  const url = workspace.remoteUrl;
  if (!url) return false;
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

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
async function handlePaneOpen(req: PaneOpenRequest, from: RequestSource) {
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
  const content = await paneContentOf(req, from);
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
async function paneContentOf(
  req: PaneOpenRequest,
  from: RequestSource,
): Promise<PaneContent | null> {
  if (req.pane !== "browser") return { kind: req.pane } as PaneContent;
  if (!req.url) {
    logger.warn("agent-request", "browser pane with no url, dropping it");
    return null;
  }
  const thisMachine = writtenOnThisMachine(from);
  const target = classifyBrowserUrl(req.url, { requesterIsThisMachine: thisMachine });
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
  // The pane is marked as the caller's from the moment it exists, which is what
  // every later call checks against and what the pane's own header shows.
  return { kind: "browser", url: target.url, drivenBy: req.callerThreadId ?? null };
}

/**
 * The browser panes of the group the page is drawing.
 *
 * The same set the window describes to the endpoint, read the same way: panes
 * in another group are not on screen, and a pane the user cannot see is not one
 * an agent should be moving.
 */
function browserLeaves(): { paneId: string; url: string; drivenBy: string | null }[] {
  const anchor = anchorPaneId();
  const group = anchor ? paneStore.groupOf(anchor) : null;
  if (!group) return [];
  return leafNodesOf(group.root).flatMap((leaf) =>
    leaf.content.kind === "browser"
      ? [{ paneId: leaf.paneId, url: leaf.content.url, drivenBy: leaf.content.drivenBy ?? null }]
      : [],
  );
}

/**
 * Point, reload or close a pane the agent is already driving.
 *
 * Every refusal here is silent to the user and loud in the log. The agent was
 * told why at the endpoint, and a toast for each one would put an agent's
 * mistakes on the screen of the person it is working for.
 */
async function handleBrowserDrive(req: BrowserDriveRequest, from: RequestSource) {
  if (anchorProjectId() !== req.projectId) {
    logger.warn("agent-request", "browser call for a project that is not on screen, dropping it", {
      asked: req.projectId,
    });
    return;
  }
  const panes = browserLeaves();
  const caller = req.callerThreadId ?? "";
  const pane = req.paneId
    ? panes.find((p) => p.paneId === req.paneId)
    : panes.length === 1
      ? panes[0]
      : undefined;
  if (!pane) {
    logger.warn("agent-request", "no browser pane to drive, dropping it", {
      asked: req.paneId ?? "",
      open: panes.length,
    });
    return;
  }
  // The hand-back, enforced. A pane with no mark is the user's, and an agent
  // whose thread is not the mark is driving somebody else's.
  if (!caller || pane.drivenBy !== caller) {
    logger.warn("agent-request", "that browser pane is not the caller's, dropping it", {
      pane: pane.paneId,
    });
    return;
  }

  if (req.kind === "browser.reload") {
    browserPanes.reload(pane.paneId);
    return;
  }
  if (req.kind === "browser.close") {
    paneStore.closePane(pane.paneId);
    return;
  }
  if (!req.url) {
    logger.warn("agent-request", "browser navigate with no url, dropping it");
    return;
  }
  const target = classifyBrowserUrl(req.url, {
    requesterIsThisMachine: writtenOnThisMachine(from),
  });
  if (!target.ok) {
    logger.warn("agent-request", "browser navigate refused", { url: req.url, reason: target.reason });
    notifications.error(t(`browser.refuse.${target.reason}`));
    return;
  }
  // Same rule as opening one: the agent chose the page, and it is not the
  // agent's window. A missing `external` is not a no.
  if (!target.local || req.external !== false) {
    const ok = await confirmDialog.ask({
      title: t("browser.confirmExternalTitle"),
      message: t("browser.confirmExternal", { url: target.url }),
      confirmLabel: t("browser.confirmExternalOpen"),
    });
    if (!ok) return;
  }
  paneStore.setBrowser(pane.paneId, { url: target.url });
}

async function handle(req: AgentRequest, from: RequestSource) {
  logger.info("agent-request", req.kind, req as unknown as Record<string, unknown>);
  switch (req.kind) {
    case "thread.move":
      return handleMove(req);
    case "project.create":
      return handleCreate(req);
    case "thread.spawn":
      return handleSpawn(req);
    case "pane.open":
      return handlePaneOpen(req, from);
    case "browser.navigate":
    case "browser.reload":
    case "browser.close":
      return handleBrowserDrive(req, from);
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
  await handle(req, "boite");
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
        void handle(e.payload, "device").catch((err) => {
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
