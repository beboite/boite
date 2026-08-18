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
import {
  comboArgs,
  comboLabel,
  FASTPICK_CMD,
  iconKeyForKind,
} from "$lib/features/fastpick/combo";
import { editorStore } from "$lib/features/editor/store.svelte";
import { anchorProjectId, openPane } from "$lib/features/panes/open";
import { leafNodesOf, paneStore } from "$lib/features/panes/store.svelte";
import { paneIsShown } from "$lib/features/panes/visible";
import { paneLabel } from "$lib/features/panes/label";
import { classifyBrowserUrl, isLoopbackHost } from "$lib/features/browser/url";
import { browserPanes } from "$lib/features/browser/state.svelte";
import { paneDriver } from "$lib/features/browser/driver";
import { backend } from "$lib/backend/active.svelte";
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
  requestId?: string;
  /** The thread that asked, when Boite launched it. */
  callerThreadId?: string | null;
  /** Parent thread ID for delegation hierarchy. */
  parentThreadId?: string | null;
  /** Whether this is a normal thread or a delegation. */
  delegationMode?: 'normal' | 'delegation';
  agent?: string | null;
  prompt?: string | null;
}

interface PaneOpenRequest {
  kind: "pane.open";
  projectId: string;
  requestId?: string;
  /** The thread that asked, so the pane lands beside it rather than beside
      whatever the user happens to be looking at. */
  callerThreadId?: string | null;
  pane: PaneContent["kind"];
  url?: string | null;
  path?: string | null;
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

/**
 * An agent asking what is in the page, or acting on one element of it.
 *
 * Unlike the drive verbs these carry a `requestId` and OWE an answer: the
 * host keeps the asking HTTP handler on the line until the webview resolves
 * it through `backend().answerAgentRequest`. Every refusal therefore answers
 * too — a dropped question here is an agent staring at a timeout.
 */
interface BrowserAskRequest {
  kind:
    | "browser.snapshot"
    | "browser.screenshot"
    | "browser.click"
    | "browser.type"
    | "browser.press"
    | "browser.scroll";
  requestId: string;
  projectId: string;
  callerThreadId?: string | null;
  paneId?: string | null;
  mode?: string | null;
  maxChars?: number | null;
  uid?: string | null;
  double?: boolean | null;
  text?: string | null;
  clear?: boolean | null;
  submit?: boolean | null;
  key?: string | null;
  dy?: number | null;
}

type AgentRequest =
  | MoveRequest
  | CreateRequest
  | SpawnRequest
  | PaneOpenRequest
  | BrowserDriveRequest
  | BrowserAskRequest;

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

  // `fastpick:<provider>:<model>` names an endpoint rather than a CLI, which is
  // the one thing the shortcut list cannot hold: the pair is the user's to pick
  // per launch, and writing a shortcut for every combination is not a list.
  // The harness is claude-code until the name carries one, because that is the
  // harness every provider in the catalogue answers on.
  if (needle.startsWith(`${FASTPICK_CMD}:`)) {
    const [, provider, ...rest] = needle.split(":");
    // Rejoined rather than taken at [2]: a model id is allowed to hold colons,
    // and cutting at the first one would launch a model that does not exist.
    const model = rest.join(":");
    if (provider && model) {
      const combo = { harness: "claude-code", provider, model };
      return {
        cmd: FASTPICK_CMD,
        args: comboArgs(combo),
        label: comboLabel(combo),
        iconKey: iconKeyForKind(combo.harness),
        iconColor: null,
      };
    }
  }

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

async function answerRequest(req: { requestId?: string }, payload: Record<string, unknown>) {
  const id = req.requestId;
  if (!id) return;
  const fn =
    backend().answerAgentRequest ?? workspace.remoteBackend?.answerAgentRequest;
  if (!fn) return;
  await fn(id, payload).catch((err) => {
    logger.warn("agent-request", "could not answer", String(err));
  });
}

async function handleSpawn(req: SpawnRequest) {
  const project = app.projects.find((p) => p.id === req.projectId);
  if (!project) {
    notifications.error(t("thread.spawnProjectGone"));
    await answerRequest(req, { error: "that project is gone" });
    return;
  }
  // The caller, not the thread on screen: an agent that says nothing about
  // which CLI to start means another of itself, and the user may be looking
  // somewhere else entirely by the time the request lands.
  const caller = app.threadById(req.callerThreadId);
  const launch = resolveLaunch(req.agent, caller?.iconKey ?? "claude");
  if (!launch) {
    notifications.error(t("thread.spawnNoAgent", { agent: req.agent ?? "" }));
    await answerRequest(req, { error: "no agent matches that name" });
    return;
  }
  const prompt = req.prompt?.trim();
  // Not focused: the user is reading the thread that asked for this one, very
  // often in another project, and a spawn they never clicked used to take the
  // screen away mid-sentence. The toast is what says it happened.
  const thread = await launchAgent(project, launch, {
    focus: false,
    parentThreadId: req.parentThreadId,
    delegationMode: req.delegationMode,
  });
  if (!thread) {
    await answerRequest(req, { error: "the terminal did not open" });
    return;
  }
  await answerRequest(req, { ok: true, threadId: thread.id });
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
 * **It lands beside the caller and moves nothing else.** This used to make the
 * caller active first — its thread, its project, the terminal view — so that
 * the anchor below would resolve to it. That is a pane the user never clicked
 * taking the screen away from what they were reading, and an agent working in
 * the background did it every time it had something to show. The same
 * reasoning as `handleSpawn`, and the same answer: put it where it belongs,
 * leave the view alone, and say out loud that it happened.
 */
async function handlePaneOpen(req: PaneOpenRequest, from: RequestSource) {
  const caller = req.callerThreadId;
  const anchor = caller && app.hasThread(caller) && paneStore.groupOf(caller) ? caller : null;
  // With no caller to anchor to, the pane lands wherever the user is looking,
  // and that is very often another project. An agent in A asking for a pane
  // and getting one in B is the app answering the wrong question in somebody
  // else's workspace, so it is dropped rather than placed.
  if (!anchor && anchorProjectId() !== req.projectId) {
    logger.warn(
      "agent-request",
      "pane asked for a project that is not the one on screen, dropping it",
      { asked: req.projectId },
    );
    await answerRequest(req, { error: "the window is showing another project" });
    return;
  }
  const content = await paneContentOf(req, from);
  if (!content) {
    await answerRequest(req, { error: "the pane was not opened" });
    return;
  }
  // Half the width for a browser, a third for a panel: a page needs room to be
  // a page, and a file tree does not.
  const ratio = req.pane === "browser" ? 0.5 : 0.35;
  const paneId = openPane(content, req.side ?? "right", ratio, anchor);
  if (req.pane === "editor" && req.path) {
    void editorStore.open(req.path);
  }
  if (!paneId) {
    await answerRequest(req, { error: "the pane was not opened" });
    return;
  }
  await answerRequest(req, { ok: true });
  // Said out loud when it landed off the screen, for the same reason a spawn
  // is: the agent has been told its pane is open, and without this the user
  // would find it the next time they happened to click that thread. Read off
  // the caller's own terminal rather than the new pane, which the page has not
  // drawn yet.
  if (anchor && !paneIsShown(anchor)) {
    notifications.info(
      t("panes.openedOffScreen", {
        agent: app.threadById(anchor)?.label ?? t("browser.drivenByAgent"),
        pane: paneLabel(content),
      }),
    );
  }
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
 * Every browser pane in the window, whichever group holds it.
 *
 * This used to read the group the page is drawing, which was the same rule as
 * "the user has to be looking at it". An agent's pane sits beside that agent's
 * own terminal and the user is very often reading another thread, or another
 * project, by the time the next call lands — and since every group stays
 * mounted, that pane is loaded, driven and answering the whole time. Refusing
 * it left an agent that had just opened a page unable to read the page it had
 * just opened.
 *
 * What decides whether a call is allowed is the mark on the pane, below, and
 * never where the user happens to be. Panes that are not the caller's are in
 * this list on purpose: an agent naming one gets told whose it is rather than
 * told it does not exist.
 */
function browserLeaves(): { paneId: string; url: string; drivenBy: string | null }[] {
  return paneStore.groups.flatMap((group) =>
    leafNodesOf(group.root).flatMap((leaf) =>
      leaf.content.kind === "browser"
        ? [{ paneId: leaf.paneId, url: leaf.content.url, drivenBy: leaf.content.drivenBy ?? null }]
        : [],
    ),
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

/**
 * Answer a page question: find the pane, ask the driver in its frame, hand
 * whatever came back to the host that is holding the agent's call open.
 *
 * The endpoint already ran these checks against the window's description;
 * they run again here because the description it read may be five seconds
 * old, and the pane store is the present tense. A refusal is an answer like
 * any other: the agent reads the sentence instead of waiting out a timeout.
 */
async function handleBrowserAsk(req: BrowserAskRequest) {
  const answer = (payload: Record<string, unknown>) => {
    const be = backend();
    if (!be.answerAgentRequest) {
      logger.warn("agent-request", "a page question landed on a device with no answer channel", {
        kind: req.kind,
      });
      return;
    }
    be.answerAgentRequest(req.requestId, payload).catch((e) =>
      logger.warn("agent-request", "could not hand the answer back", { error: String(e) }),
    );
  };

  const panes = browserLeaves();
  const caller = req.callerThreadId ?? "";
  const pane = req.paneId
    ? panes.find((p) => p.paneId === req.paneId)
    : panes.length === 1
      ? panes[0]
      : undefined;
  if (!pane) {
    answer({ error: "that browser pane is closed" });
    return;
  }
  if (!caller || pane.drivenBy !== caller) {
    answer({ error: "the user has taken that pane back, so it is theirs to read now" });
    return;
  }

  const verb = req.kind.slice("browser.".length);

  // The screenshot is the one question the frame cannot answer about itself:
  // pixels of a cross-origin document are exactly what the web refuses to
  // hand to a page. The OS paints them instead, through the backend, and the
  // driver only contributes the crop rectangle when one element was asked.
  if (verb === "screenshot") {
    const be = backend();
    if (!be.capturePane) {
      answer({
        error:
          "this device cannot photograph the pane; browser_snapshot reads it as elements and text",
      });
      return;
    }
    // The one call that needs the pane to be the one on screen. Everything
    // else here goes through the frame, which answers from a hidden group as
    // readily as from the drawn one; this photographs a rectangle of the
    // window, and that rectangle currently holds whatever group the user IS
    // looking at. A wrong picture is worse than a refusal — an agent acts on
    // it.
    if (!paneIsShown(pane.paneId)) {
      answer({
        error:
          "that pane is beside its own terminal and the window is showing another one, so a \
photograph would be of somebody else's pane. browser_snapshot reads it wherever it is",
      });
      return;
    }
    const box = paneDriver.frameBox(pane.paneId);
    if (!box) {
      answer({ error: "that pane is not drawn right now" });
      return;
    }
    let crop = { x: box.x, y: box.y, w: box.width, h: box.height };
    if (req.uid) {
      const located = await paneDriver.ask(pane.paneId, "locate", { uid: req.uid });
      if (located.error) {
        answer(located);
        return;
      }
      const r = located.rect as { x: number; y: number; w: number; h: number };
      // A little context around the element: a bare button with no
      // surroundings answers fewer questions than it raises.
      const pad = 8;
      const rx = Math.max(0, r.x - pad);
      const ry = Math.max(0, r.y - pad);
      crop = {
        x: box.x + rx,
        y: box.y + ry,
        w: Math.min(box.width - rx, r.w + pad * 2),
        h: Math.min(box.height - ry, r.h + pad * 2),
      };
    }
    const dpr = window.devicePixelRatio || 1;
    try {
      const shot = await be.capturePane({
        x: crop.x * dpr,
        y: crop.y * dpr,
        w: crop.w * dpr,
        h: crop.h * dpr,
      });
      answer({ image: shot.image, width: shot.width, height: shot.height });
    } catch (e) {
      answer({ error: String(e) });
    }
    return;
  }

  const args: Record<string, unknown> = {};
  for (const key of ["mode", "maxChars", "uid", "double", "text", "clear", "submit", "key", "dy"] as const) {
    if (req[key] !== undefined && req[key] !== null) args[key] = req[key];
  }
  answer(await paneDriver.ask(pane.paneId, verb, args));
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
    case "browser.snapshot":
    case "browser.screenshot":
    case "browser.click":
    case "browser.type":
    case "browser.press":
    case "browser.scroll":
      return handleBrowserAsk(req);
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
