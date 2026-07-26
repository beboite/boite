import { backendForPath } from "$lib/backend";
import type { SessionHit, SessionKind } from "$lib/backend/types";
import { app } from "$lib/app/store.svelte";
import { detectIconKey } from "$lib/shared/icons/detect";
import { logger } from "$lib/shared/services/logger.svelte";
import type { IconKey, Thread } from "$lib/types";

// mtimeMs is the session file's last-write time when the backend can provide
// it; the monitor uses it to attribute the file to the thread whose PTY was
// active when it was written.
export type { SessionHit } from "$lib/backend/types";

export type SessionDetector = (
  cwd: string,
  afterUnixMs: number,
  excludeIds: string[],
) => Promise<SessionHit | null>;

function makeDetector(kind: SessionKind, scope: string): SessionDetector {
  return async (cwd, afterUnixMs, excludeIds) => {
    try {
      // Session files live where the PTY runs; route by the thread's cwd.
      return await backendForPath(cwd).session.find(kind, cwd, afterUnixMs, excludeIds);
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

function resolveKey(thread: Thread): IconKey {
  return thread.iconKey ?? detectIconKey(thread.cmd, thread.label);
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
  // copilot --resume <UUID> picks specific session.
  copilot: (args, sessionId) => {
    const filtered = stripFlag(args, ["--resume"], true);
    return [...filtered, "--resume", sessionId];
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
 * So when the captured session is live, the thread opens the agent view instead
 * — one pick away from the conversation, which is the only route to it. The
 * fallback is deliberately not `--fork-session`: forking abandons the running
 * conversation and starts a copy, which is the opposite of getting it back.
 */
async function liveClaudeSession(sessionId: string, cwd: string) {
  try {
    const live = await backendForPath(cwd).session.liveClaude();
    return live.find((s) => s.id === sessionId) ?? null;
  } catch (err) {
    // Never block a launch on this: an unanswered check just means the resume
    // is attempted as before.
    logger.warn("resume", "liveClaude check failed", String(err));
    return null;
  }
}

export async function buildResumeArgsAsync(thread: Thread, cwd: string): Promise<string[]> {
  // Let the existing logic decide first — it owns the first-spawn latch, which
  // is consumed on read and must not be probed twice — then intervene only on
  // what it actually produced.
  const args = buildResumeArgs(thread);
  if (resolveKey(thread) !== "claude") return args;

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
  // ceremony, not safety. A busy agent is mid-answer and is left alone.
  if (live.status !== "busy") {
    const stopped = await backendForPath(cwd)
      .session.stopClaude(id)
      .catch(() => false);
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

export function buildResumeArgs(thread: Thread): string[] {
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
