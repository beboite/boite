/**
 * What an agent asked Boite to do to Boite.
 *
 * The MCP endpoint cannot carry any of this out itself. Moving a thread means
 * killing a PTY and opening a worktree; creating a project means writing rows
 * the store owns; spawning one means mounting a terminal. All of it lives here,
 * in the app, and the endpoint's whole job is to decide whether the request
 * makes sense and then say so.
 *
 * Which is why these arrive as an event rather than as the answer to an HTTP
 * call: two of the three kill the process that asked. The reply is written
 * while the agent is still alive to read a refusal, and the work happens after
 * it has gone.
 */

import { app } from "$lib/app/store.svelte";
import { workspace } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { settings, parseCommand } from "$lib/features/settings/store.svelte";
import { CLI_PRESETS } from "$lib/features/settings/cliPresets";
import { resolveIconKey } from "$lib/shared/icons/detect";
import { createProject } from "$lib/features/project/api";
import { moveThreadToProject } from "./move";
import { takesOpeningPrompt } from "./session";
import { launchAgent } from "./api";
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

type AgentRequest = MoveRequest | CreateRequest | SpawnRequest;

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
    notifications.error(`Could not move the thread: ${result.reason}`);
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
    notifications.error(`Could not create ${req.name}: ${result.reason}`);
    logger.warn("agent-request", "create refused", result.reason ?? "");
    return;
  }
  if (result.reused === "unarchived") {
    notifications.success(`${result.project.name} was archived; brought it back.`);
  } else if (!result.reused) {
    notifications.success(`Created ${result.project.name}`);
  }
  if (!req.move || !req.threadId) return;

  const moved = await moveThreadToProject(req.threadId, result.project.id, {
    note: req.note ?? undefined,
    // The project notification just fired; a second one saying the same thread
    // arrived in the project it was made for is noise.
    silent: true,
  });
  if (!moved.ok) {
    notifications.error(`Created ${result.project.name}, but the thread stayed put: ${moved.reason}`);
  }
}

async function handleSpawn(req: SpawnRequest) {
  const project = app.projects.find((p) => p.id === req.projectId);
  if (!project) {
    notifications.error("An agent asked for a terminal in a project that is gone");
    return;
  }
  // The caller, not the thread on screen: an agent that says nothing about
  // which CLI to start means another of itself, and the user may be looking
  // somewhere else entirely by the time the request lands.
  const caller = app.threadById(req.callerThreadId);
  const launch = resolveLaunch(req.agent, caller?.iconKey ?? "claude");
  if (!launch) {
    notifications.error(`No agent called "${req.agent}" to start`);
    return;
  }
  const prompt = req.prompt?.trim();
  const thread = await launchAgent(project, launch);
  if (!thread) return;
  if (prompt) app.setPendingPrompt(thread.id, prompt);
  notifications.success(`${launch.label} opened in ${project.name}`);
  // Said out loud rather than logged. Only some CLIs take an opening
  // instruction on the command line; for the rest the new thread starts at a
  // bare prompt with no idea what it was opened for, and the agent that asked
  // for it has already been told the hand-off worked.
  if (prompt && !takesOpeningPrompt(launch.iconKey)) {
    notifications.error(
      `${launch.label} takes no opening prompt, so it started without one. Its instructions were: ${prompt}`,
    );
  }
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
