import { backend } from "$lib/backend";
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
      return await backend().session.find(kind, cwd, afterUnixMs, excludeIds);
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
};

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
