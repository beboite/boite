import { backendForPath, workspace } from "$lib/backend";
import type { LiveClaudeSession, SessionHit, SessionKind } from "$lib/backend/types";
import { app } from "$lib/app/store.svelte";
import { detectIconKey } from "$lib/shared/icons/detect";
import { logger } from "$lib/shared/services/logger.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { t } from "$lib/i18n/index.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { mcpArgsFor } from "./agentMcp";
import { stageTypedPrompt } from "./typedPrompt";
import {
  agentsViewArgv,
  joinArgv,
  resumeArgv,
  withMcpArgs,
  withPromptArg,
  withoutAgentFlag,
  type AgentArgv,
} from "./resume-args";
import type { IconKey, Thread } from "$lib/types";

// The pure half of resuming lives in `resume-args.ts`. Re-exported so callers
// keep asking the session module, which is where the question belongs.
export { takesOpeningPrompt, withUnattendedArgs } from "./resume-args";
export type { ResumeBuilder } from "./resume-args";

// mtimeMs is the session file's last-write time when the backend can provide
// it; the monitor uses it to attribute the file to the thread whose PTY was
// active when it was written.
export type { SessionHit } from "$lib/backend/types";

export type SessionDetector = (
  cwd: string,
  afterUnixMs: number,
  excludeIds: string[],
  ptyId?: string | null,
) => Promise<SessionHit | null>;

function makeDetector(kind: SessionKind, scope: string): SessionDetector {
  return async (cwd, afterUnixMs, excludeIds, ptyId) => {
    try {
      // Session files live where the PTY runs; route by the thread's cwd.
      return await backendForPath(cwd).session.find(kind, cwd, afterUnixMs, excludeIds, ptyId);
    } catch (err) {
      logger.error("session", `${scope}: detect failed`, String(err));
      return null;
    }
  };
}

const detectors: Partial<Record<NonNullable<IconKey>, SessionDetector>> = {
  claude: makeDetector("claude", "claude"),
  codex: makeDetector("codex", "codex"),
  opencode: makeDetector("opencode", "opencode"),
  cursor: makeDetector("cursor", "cursor"),
  antigravity: makeDetector("antigravity", "antigravity"),
  copilot: makeDetector("copilot", "copilot"),
  grok: makeDetector("grok", "grok"),
  hermes: makeDetector("hermes", "hermes"),
  pi: makeDetector("pi", "pi"),
};

/**
 * Which agent a thread's sessions belong to. The stored iconKey when there is
 * one, the command otherwise — a thread can predate the key being recorded.
 */
export function resolveKey(thread: Thread): IconKey {
  return thread.iconKey ?? detectIconKey(thread.cmd, thread.label);
}

/**
 * Which session store this thread's conversation lives in, or null when it is
 * not an agent at all (a blank terminal, an unrecognised command). Exported for
 * the move machinery, which has to know whose transcript to carry.
 */
export function sessionKindOf(thread: Thread): SessionKind | null {
  const key = resolveKey(thread);
  return key && key in detectors ? (key as SessionKind) : null;
}

export function getDetector(thread: Thread): SessionDetector | null {
  const key = resolveKey(thread);
  if (!key) return null;
  return detectors[key] ?? null;
}

/**
 * Claude refuses `--resume` for a session it still has open: "That session is
 * still running as a background agent. Open `claude agents` to attach to it, or
 * stop it there first to resume here." Replaying the id anyway drops the user
 * at a bare prompt with the conversation out of reach.
 *
 * The refusal is about the hold, not the session, so the caller takes the hint
 * literally: release an idle agent and resume for real, and fall back to the
 * agent view only for one that is mid-answer. `--fork-session` is never the
 * answer — forking abandons the running conversation and starts a copy, which
 * is the opposite of getting it back.
 */
/**
 * The live-session list, held briefly.
 *
 * A reload asks for it twice within a few milliseconds — once to release an
 * agent holding the session, once more from `buildResumeArgsAsync` to decide
 * what to do about that same session — and each ask is a walk of
 * `~/.claude/sessions`, a JSON parse per file and a liveness check per pid.
 *
 * Keyed by the machine that answered, because in dynamic mode a local thread
 * and a boite thread are asking about two different `~/.claude`. Dropped
 * outright whenever a session is released, so the second read can never be told
 * an agent still holds what was just stopped.
 */
const liveClaudeCache = new Map<
  string,
  { at: number; sessions: Promise<LiveClaudeSession[]> }
>();
const LIVE_CLAUDE_TTL = 1000;

function liveClaudeSessions(cwd: string): Promise<LiveClaudeSession[]> {
  const backend = backendForPath(cwd);
  const key =
    backend.kind === "tauri" ? "local" : workspace.activeBoiteId ?? "remote";
  const hit = liveClaudeCache.get(key);
  if (hit && Date.now() - hit.at < LIVE_CLAUDE_TTL) return hit.sessions;
  // The promise is cached rather than its result, so two overlapping asks share
  // one scan instead of racing two.
  const sessions: Promise<LiveClaudeSession[]> = backend.session
    .liveClaude()
    .catch((err) => {
      // Never block a launch on this: an unanswered check just means the resume
      // is attempted as before. Not remembered either — a failure must not stand
      // in for an answer for a whole second.
      logger.warn("resume", "liveClaude check failed", String(err));
      // By identity, never by key. A release clears the map and the next ask
      // starts a fresh scan under this same key, so deleting by key here would
      // throw away that new answer for the failure of one nobody is waiting on
      // any more.
      if (liveClaudeCache.get(key)?.sessions === sessions) {
        liveClaudeCache.delete(key);
      }
      return [] as LiveClaudeSession[];
    });
  liveClaudeCache.set(key, { at: Date.now(), sessions });
  return sessions;
}

/**
 * Releases a session a background agent is holding, so `--resume` works on it
 * again. Answers whether it let go.
 *
 * The one door to `stopClaude`, because it is also the one thing that makes the
 * cached list above wrong.
 */
export async function releaseClaudeSession(
  cwd: string,
  sessionId: string,
): Promise<boolean> {
  try {
    return await backendForPath(cwd).session.stopClaude(sessionId);
  } catch {
    return false;
  } finally {
    liveClaudeCache.clear();
  }
}

/**
 * Takes the conversation to a new folder, and says whether it can still be
 * resumed there.
 *
 * Two callers, one rule: a thread that changes project, and a thread restored
 * into a worktree that is not the one it was closed in. Claude, grok and pi
 * look a session up under the directory the CLI ran in, so the transcript has
 * to be where the agent will be.
 *
 * Best effort on purpose, but a `false` here has to be acted on rather than
 * logged. Relaunching with `--resume` pointed at a transcript that is not in
 * the new folder does not degrade to a fresh session: claude refuses the id
 * outright and the thread lands on an error instead of a prompt.
 */
export async function carryTranscript(
  thread: Thread,
  fromCwd: string,
  toCwd: string,
): Promise<boolean> {
  const kind = sessionKindOf(thread);
  if (!kind || !thread.sessionId) return true;
  try {
    const resumable = await backendForPath(toCwd).session.migrate(
      kind,
      thread.sessionId,
      fromCwd,
      toCwd,
    );
    logger.info(
      "session",
      `${thread.id} (${kind}): conversation ${resumable ? "reachable over there" : "did not follow"}`,
      { sessionId: thread.sessionId, fromCwd, toCwd },
    );
    return resumable;
  } catch (err) {
    logger.warn(
      "session",
      `${thread.id} (${kind}): the transcript stayed behind, the agent comes back without it`,
      String(err),
    );
    notifications.error(t("thread.moveTranscriptFailed", { error: String(err) }));
    return false;
  }
}

async function liveClaudeSession(sessionId: string, cwd: string) {
  const live = await liveClaudeSessions(cwd);
  return live.find((s) => s.id === sessionId) ?? null;
}

/**
 * A line queued for this launch, appended last so it is what the agent opens
 * on. Consumed here rather than at the call site: `buildResumeArgv` owns the
 * first-spawn latch and both have to be read exactly once per spawn.
 */
function withPendingPrompt(thread: Thread, key: IconKey, argv: AgentArgv): AgentArgv {
  const prompt = app.consumePendingPrompt(thread.id);
  if (!prompt) return argv;
  const next = withPromptArg(argv, key, prompt);
  if (next.typed) {
    // Typed into the PTY once the terminal is up instead. Worse than a
    // positional — it races the CLI's own startup — but a thread that was
    // opened for something specific and never told what is worse still.
    stageTypedPrompt(thread.id, prompt);
  }
  return next.argv;
}

export async function buildResumeArgsAsync(thread: Thread, cwd: string): Promise<string[]> {
  // Let the pure decision run first — it goes with the first-spawn latch, which
  // is consumed on read and must not be probed twice — then intervene only on
  // what it actually produced.
  let argv = buildResumeArgv(thread);
  const key = resolveKey(thread);
  // Every agent that can take it gets todo access, resume or not: the endpoint
  // serves the project, and a fresh thread wants it as much as a resumed one.
  // The cwd names the machine that will run this command line, which in dynamic
  // mode is not the one the launcher was clicked on.
  const mcp = await mcpArgsFor(
    key,
    settings.state.agentTodoAccess,
    workspace.pathOriginResolver?.(cwd) ?? "local",
    { cwd, worktree: !!thread.worktreePath },
  );
  argv = withMcpArgs(argv, mcp);
  argv = withPendingPrompt(thread, key, argv);

  // A session copilot opened and never used is refused by id, and threads that
  // captured one before that was known still carry it. Replaying it costs the
  // launch and gains nothing; dropping the flag starts a session that can be
  // captured properly on the next scan.
  if (key === "copilot") {
    const flag = argv.agent.find((a) => a.startsWith("--resume="));
    if (!flag) return joinArgv(argv);
    const id = flag.slice("--resume=".length);
    const ok = await backendForPath(cwd)
      .session.copilotResumable(id)
      .catch(() => true);
    if (ok) return joinArgv(argv);
    logger.info(
      "resume",
      `${thread.id} (copilot): ${id} holds nothing to resume, starting fresh`,
      { cmd: thread.cmd },
    );
    return joinArgv(withoutAgentFlag(argv, flag));
  }

  if (key !== "claude") return joinArgv(argv);

  const at = argv.agent.indexOf("--resume");
  const id = at >= 0 ? argv.agent[at + 1] : null;
  if (!id) return joinArgv(argv);

  const live = await liveClaudeSession(id, cwd);
  if (live === null) return joinArgv(argv);

  // Only a background session is reachable this way: `claude agents --cwd`
  // lists background sessions, so sending an interactive one there would open
  // a view that cannot contain it. Nothing joins another terminal's
  // interactive session, so that case keeps the plain resume and lets claude
  // say so itself, which is more use than a view with the answer missing.
  if (live.kind !== "bg") {
    logger.info(
      "resume",
      `${thread.id} (claude): session ${id} is live in another terminal, nothing to attach to`,
      { cmd: thread.cmd, kind: live.kind },
    );
    return joinArgv(argv);
  }

  // An idle agent is holding the session without doing anything with it, and
  // that hold is the only reason resume is refused. Release it and resume for
  // real — opening a picker to reach a conversation nothing is working on is
  // ceremony, not safety. A busy agent is mid-answer and is left alone, and so
  // is one that stated nothing: killing a session on a status the registry never
  // wrote is the same guess with worse consequences.
  if (live.status && live.status !== "busy") {
    const stopped = await releaseClaudeSession(cwd, id);
    if (stopped) {
      logger.info(
        "resume",
        `${thread.id} (claude): released idle agent ${id}, resuming in place`,
        { cmd: thread.cmd },
      );
      return joinArgv(argv);
    }
  }

  logger.info(
    "resume",
    `${thread.id} (claude): agent ${id} is working, opening the agent view instead`,
    { cmd: thread.cmd, status: live.status },
  );
  // Scoped to the project: the view has no way to preselect a session — no
  // positional argument, no attach flag — so the next best thing is to leave
  // only this project's agents in it, which is usually the one row wanted.
  // Driving the picker with synthetic keystrokes was the alternative and is
  // not worth it: row order is not contractual, and a mistimed Enter would
  // dispatch something the user never asked for.
  return joinArgv(agentsViewArgv(argv, cwd));
}

/**
 * The two argument regions this thread comes back on, and one line in the log
 * saying why. The decision itself is in `resume-args.ts`; what stays here is
 * the latch, the store and the words.
 */
function buildResumeArgv(thread: Thread): AgentArgv {
  const key = resolveKey(thread);
  const sessionId = thread.sessionId ?? null;
  const { argv, outcome } = resumeArgv({
    cmd: thread.cmd,
    args: thread.args,
    key,
    sessionId,
    fresh: app.consumeFresh(thread.id),
  });
  switch (outcome) {
    case "no-builder":
      logger.debug("resume", `${thread.id}: nothing resumes ${key ?? "this"}`, {
        cmd: thread.cmd,
        label: thread.label,
      });
      break;
    case "fresh":
      logger.info("resume", `${thread.id} (${key}): first spawn, no resume`, {
        cmd: thread.cmd,
      });
      break;
    case "continue-latest":
      logger.info(
        "resume",
        `${thread.id} (${key}): no captured session, continue latest`,
        { cmd: thread.cmd, args: argv.agent },
      );
      break;
    case "no-session":
      logger.info(
        "resume",
        `${thread.id} (${key}): no captured session, spawn original command`,
        { cmd: thread.cmd },
      );
      break;
    case "resumed":
      logger.info(
        "resume",
        `${thread.id} (${key}): respawn → ${thread.cmd} ${joinArgv(argv).join(" ")}`,
        { sessionId, exitCode: thread.exitCode },
      );
      break;
  }
  return argv;
}
