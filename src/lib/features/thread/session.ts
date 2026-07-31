import { backendForPath, workspace } from "$lib/backend";
import type { LiveClaudeSession, SessionHit, SessionKind } from "$lib/backend/types";
import { app } from "$lib/app/store.svelte";
import { detectIconKey } from "$lib/shared/icons/detect";
import { logger } from "$lib/shared/services/logger.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { mcpArgsFor } from "./agentMcp";
import { stageTypedPrompt } from "./typedPrompt";
import type { IconKey, Thread } from "$lib/types";

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

export type ResumeBuilder = (
  args: string[],
  sessionId: string,
) => string[];

const CODEX_NO_ALT_SCREEN = "--no-alt-screen";

function stripFlag(args: string[], flags: string[], takesValue: boolean): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (const a of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (flags.includes(a)) {
      if (takesValue) skipNext = true;
      continue;
    }
    if (flags.some((f) => a.startsWith(`${f}=`))) continue;
    out.push(a);
  }
  return out;
}

function withCodexNoAltScreen(args: string[]): string[] {
  if (args.includes(CODEX_NO_ALT_SCREEN)) return args;
  return [CODEX_NO_ALT_SCREEN, ...args];
}

function withGrokContinue(args: string[]): string[] {
  if (
    args.includes("--continue") ||
    args.includes("-c") ||
    args.includes("--resume") ||
    args.includes("-r")
  ) {
    return args;
  }
  return [...args, "--continue"];
}

function withOpencodeContinue(args: string[]): string[] {
  if (
    args.includes("--continue") ||
    args.includes("-c") ||
    args.includes("--session") ||
    args.includes("-s")
  ) {
    return args;
  }
  return [...args, "--continue"];
}

function withAntigravityContinue(args: string[]): string[] {
  if (
    args.includes("--continue") ||
    args.includes("-c") ||
    args.includes("--conversation")
  ) {
    return args;
  }
  return [...args, "--continue"];
}

const builders: Partial<Record<NonNullable<IconKey>, ResumeBuilder>> = {
  // claude --resume <id> picks a specific session.
  claude: (args, sessionId) => {
    const filtered = stripFlag(args, ["--resume", "-r"], true);
    return [...filtered, "--resume", sessionId];
  },
  // codex resume <id> subcommand-form.
  codex: (args, sessionId) => {
    const stripped = args.filter(
      (a) =>
        a !== "resume" && a !== sessionId && a !== CODEX_NO_ALT_SCREEN,
    );
    return [CODEX_NO_ALT_SCREEN, ...stripped, "resume", sessionId];
  },
  // Current opencode uses --session <id>; strip legacy resume args too.
  opencode: (args, sessionId) => {
    const withoutContinue = stripFlag(args, ["--continue", "-c"], false);
    const filtered = stripFlag(
      withoutContinue,
      ["--session", "-s", "--resume", "-r"],
      true,
    );
    return [...filtered, "--session", sessionId];
  },
  // cursor-agent --resume <chat-id> picks a specific session.
  cursor: (args, sessionId) => {
    const filtered = stripFlag(args, ["--resume", "--continue"], true);
    return [...filtered, "--resume", sessionId];
  },
  // agy --conversation <UUID> picks a specific conversation.
  antigravity: (args, sessionId) => {
    const withoutContinue = stripFlag(args, ["--continue", "-c"], false);
    const filtered = stripFlag(withoutContinue, ["--conversation"], true);
    return [...filtered, "--conversation", sessionId];
  },
  // `-r, --resume[=value]`: the value is optional, so it only attaches with an
  // `=`. Space-separated, the flag opens the picker and the id falls through as
  // a positional — which copilot then looks up as a session *name* and rejects:
  // "No session, task, or name matched '<uuid>'". The id was never the problem.
  copilot: (args, sessionId) => {
    const filtered = stripFlag(args, ["--resume", "-r"], true);
    return [...filtered, `--resume=${sessionId}`];
  },
  // grok --resume <id> picks a specific session; -c continues the latest
  // session of the current directory.
  grok: (args, sessionId) => {
    const withoutContinue = stripFlag(args, ["--continue", "-c"], false);
    const filtered = stripFlag(withoutContinue, ["--resume", "-r"], true);
    return [...filtered, "--resume", sessionId];
  },
  // hermes --resume <id|title> picks a specific session.
  hermes: (args, sessionId) => {
    const withoutContinue = stripFlag(args, ["--continue", "-c"], false);
    const filtered = stripFlag(withoutContinue, ["--resume", "-r"], true);
    return [...filtered, "--resume", sessionId];
  },
};

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

async function liveClaudeSession(sessionId: string, cwd: string) {
  const live = await liveClaudeSessions(cwd);
  return live.find((s) => s.id === sessionId) ?? null;
}

/**
 * How this CLI takes an opening prompt, or null when it takes none.
 *
 * `claude [options] [prompt]` always does, resume included — but only behind a
 * `--`. Its `--mcp-config <configs...>` is variadic, so a bare positional after
 * it is read as a second config file and the launch dies on
 * "MCP config file not found: <the first word of the sentence>".
 *
 * `codex [options] [prompt]` takes one plainly (nothing in its argument list is
 * variadic), but only for a fresh session: its resume is the subcommand `codex
 * resume <id>`, which occupies the same position.
 *
 * Nothing else is listed. A guess here does not misfire quietly — it costs the
 * thread its whole launch — and the cost of being wrong the other way is one
 * agent that comes back up without being told why its folder changed.
 */
function promptSeparator(key: IconKey, args: string[]): string[] | null {
  if (key === "claude") return ["--"];
  if (key === "codex") return args.includes("resume") ? null : [];
  return null;
}

/**
 * Whether a thread started on this CLI would be handed an opening instruction.
 *
 * Asked before the launch, by `thread_spawn`: a new terminal that silently
 * drops the prompt it was opened for is a half-success dressed as a success —
 * the calling agent is told the work was handed off, and the thread it opened
 * sits at a bare prompt knowing nothing.
 */
export function takesOpeningPrompt(key: IconKey): boolean {
  // A fresh thread never carries a resume, which is the only thing that makes
  // the positional ambiguous.
  return promptSeparator(key, []) !== null;
}

/**
 * A line queued for this launch, appended last so it is what the agent opens
 * on. Consumed here rather than at the call site: `buildResumeArgs` owns the
 * first-spawn latch and both have to be read exactly once per spawn.
 */
function withPendingPrompt(thread: Thread, key: IconKey, args: string[]): string[] {
  const prompt = app.consumePendingPrompt(thread.id);
  if (!prompt) return args;
  const separator = promptSeparator(key, args);
  if (separator === null) {
    // Typed into the PTY once the terminal is up instead. Worse than a
    // positional — it races the CLI's own startup — but a thread that was
    // opened for something specific and never told what is worse still.
    stageTypedPrompt(thread.id, prompt);
    return args;
  }
  // Any newline would end the prompt and start typing the rest as a second
  // one, so the whole briefing arrives as a single line.
  return [...args, ...separator, prompt.replace(/\s*[\r\n]+\s*/g, " ").trim()];
}

export async function buildResumeArgsAsync(thread: Thread, cwd: string): Promise<string[]> {
  // Let the existing logic decide first — it owns the first-spawn latch, which
  // is consumed on read and must not be probed twice — then intervene only on
  // what it actually produced.
  const base = buildResumeArgs(thread);
  const key = resolveKey(thread);
  // Every agent that can take it gets todo access, resume or not: the endpoint
  // serves the project, and a fresh thread wants it as much as a resumed one.
  const mcp = await mcpArgsFor(key, settings.state.agentTodoAccess);
  // Last, so the prompt stays a positional: an mcp flag appended after it would
  // be read as part of the sentence.
  const args = withPendingPrompt(thread, key, mcp.length > 0 ? [...base, ...mcp] : base);

  // A session copilot opened and never used is refused by id, and threads that
  // captured one before that was known still carry it. Replaying it costs the
  // launch and gains nothing; dropping the flag starts a session that can be
  // captured properly on the next scan.
  if (key === "copilot") {
    const flag = args.find((a) => a.startsWith("--resume="));
    if (!flag) return args;
    const id = flag.slice("--resume=".length);
    const ok = await backendForPath(cwd)
      .session.copilotResumable(id)
      .catch(() => true);
    if (ok) return args;
    logger.info(
      "resume",
      `${thread.id} (copilot): ${id} holds nothing to resume, starting fresh`,
      { cmd: thread.cmd },
    );
    return args.filter((a) => a !== flag);
  }

  if (key !== "claude") return args;

  const at = args.indexOf("--resume");
  const id = at >= 0 ? args[at + 1] : null;
  if (!id) return args;

  const live = await liveClaudeSession(id, cwd);
  if (live === null) return args;

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
    return args;
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
      return args;
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
  return ["agents", "--cwd", cwd];
}

function buildResumeArgs(thread: Thread): string[] {
  const key = resolveKey(thread);
  if (!key) {
    logger.debug("resume", `${thread.id}: no iconKey, skip`, {
      cmd: thread.cmd,
      label: thread.label,
    });
    return thread.args;
  }
  const builder = builders[key];
  if (!builder) {
    logger.debug("resume", `${thread.id}: no builder for ${key}`, {});
    return thread.args;
  }
  const args = key === "codex" ? withCodexNoAltScreen(thread.args) : thread.args;
  const isFreshFirstSpawn = app.consumeFresh(thread.id);
  if (isFreshFirstSpawn) {
    logger.info(
      "resume",
      `${thread.id} (${key}): first spawn, no resume`,
      { cmd: thread.cmd },
    );
    return args;
  }

  if (!thread.sessionId) {
    if (key === "opencode") {
      const out = withOpencodeContinue(args);
      logger.info(
        "resume",
        `${thread.id} (${key}): no captured session, continue latest`,
        { cmd: thread.cmd, args: out },
      );
      return out;
    }
    // grok -c is scoped to the current directory, so continuing the latest
    // session is safe even without a captured id. hermes -c is global (last
    // session of any project), so it gets no fallback: wrong-project resumes
    // are worse than a fresh session.
    if (key === "grok") {
      const out = withGrokContinue(args);
      logger.info(
        "resume",
        `${thread.id} (${key}): no captured session, continue latest`,
        { cmd: thread.cmd, args: out },
      );
      return out;
    }
    if (key === "antigravity") {
      const out = withAntigravityContinue(args);
      logger.info(
        "resume",
        `${thread.id} (${key}): no captured session, continue latest`,
        { cmd: thread.cmd, args: out },
      );
      return out;
    }
    logger.info(
      "resume",
      `${thread.id} (${key}): no captured session, spawn original command`,
      { cmd: thread.cmd },
    );
    return args;
  }

  const out = builder(args, thread.sessionId);
  logger.info(
    "resume",
    `${thread.id} (${key}): respawn → ${thread.cmd} ${out.join(" ")}`,
    { sessionId: thread.sessionId, exitCode: thread.exitCode },
  );
  return out;
}
