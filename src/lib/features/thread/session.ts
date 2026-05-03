import { invoke } from "@tauri-apps/api/core";
import { app } from "$lib/app/store.svelte";
import { detectIconKey } from "$lib/shared/icons/detect";
import { logger } from "$lib/shared/services/logger.svelte";
import type { IconKey, Thread } from "$lib/types";

export type SessionDetector = (
  cwd: string,
  afterUnixMs: number,
) => Promise<string | null>;

function makeDetector(command: string, scope: string): SessionDetector {
  return async (cwd, afterUnixMs) => {
    try {
      const id = await invoke<string | null>(command, { cwd, afterUnixMs });
      return id ?? null;
    } catch (err) {
      logger.error("session", `${scope}: detect failed`, String(err));
      return null;
    }
  };
}

const detectors: Partial<Record<NonNullable<IconKey>, SessionDetector>> = {
  claude: makeDetector("find_claude_session", "claude"),
  codex: makeDetector("find_codex_session", "codex"),
  opencode: makeDetector("find_opencode_session", "opencode"),
  cursor: makeDetector("find_cursor_session", "cursor"),
  gemini: makeDetector("find_gemini_session", "gemini"),
  copilot: makeDetector("find_copilot_session", "copilot"),
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

const builders: Partial<Record<NonNullable<IconKey>, ResumeBuilder>> = {
  // claude --resume <id> picks a specific session.
  claude: (args, sessionId) => {
    const filtered = stripFlag(args, ["--resume", "-r"], true);
    return [...filtered, "--resume", sessionId];
  },
  // codex resume <id> subcommand-form.
  codex: (args, sessionId) => {
    const filtered = args[0] === "resume" ? args.slice(1) : args;
    const stripped = filtered.filter((a) => a !== sessionId);
    return ["resume", sessionId, ...stripped];
  },
  // opencode --session <id> picks a specific session.
  opencode: (args, sessionId) => {
    const filtered = stripFlag(
      args,
      ["--continue", "-c", "--session", "-s"],
      true,
    );
    return [...filtered, "--session", sessionId];
  },
  // cursor-agent --resume <chat-id> picks a specific session.
  cursor: (args, sessionId) => {
    const filtered = stripFlag(args, ["--resume", "--continue"], true);
    return [...filtered, "--resume", sessionId];
  },
  // gemini --resume <UUID> picks a specific session.
  gemini: (args, sessionId) => {
    const filtered = stripFlag(args, ["--resume", "-r"], true);
    return [...filtered, "--resume", sessionId];
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
  const isFreshFirstSpawn = app.consumeFresh(thread.id);
  if (isFreshFirstSpawn) {
    logger.info(
      "resume",
      `${thread.id} (${key}): first spawn, no resume`,
      { cmd: thread.cmd },
    );
    return thread.args;
  }

  if (!thread.sessionId) {
    logger.info(
      "resume",
      `${thread.id} (${key}): no captured session, spawn original command`,
      { cmd: thread.cmd },
    );
    return thread.args;
  }

  const out = builder(thread.args, thread.sessionId);
  logger.info(
    "resume",
    `${thread.id} (${key}): respawn → ${thread.cmd} ${out.join(" ")}`,
    { sessionId: thread.sessionId, exitCode: thread.exitCode },
  );
  return out;
}
