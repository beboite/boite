import { invoke } from "@tauri-apps/api/core";
import { detectIconKey } from "$lib/shared/icons/detect";
import type { IconKey, Thread } from "$lib/types";

export type SessionDetector = (
  cwd: string,
  afterUnixMs: number,
) => Promise<string | null>;

const detectors: Partial<Record<NonNullable<IconKey>, SessionDetector>> = {
  claude: async (cwd, afterUnixMs) => {
    try {
      return await invoke<string | null>("find_claude_session", {
        cwd,
        afterUnixMs,
      });
    } catch (err) {
      console.error("find_claude_session failed:", err);
      return null;
    }
  },
};

function resolveKey(thread: Thread): IconKey {
  return thread.iconKey ?? detectIconKey(thread.cmd, thread.label);
}

export function getDetector(thread: Thread): SessionDetector | null {
  const key = resolveKey(thread);
  if (!key) return null;
  return detectors[key] ?? null;
}

export type ResumeBuilder = (sessionId: string, args: string[]) => string[];

const builders: Partial<Record<NonNullable<IconKey>, ResumeBuilder>> = {
  claude: (sessionId, args) => {
    const filtered: string[] = [];
    let skipNext = false;
    for (const a of args) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (a === "--resume" || a === "-r") {
        skipNext = true;
        continue;
      }
      if (a.startsWith("--resume=")) continue;
      filtered.push(a);
    }
    return [...filtered, "--resume", sessionId];
  },
};

export function buildResumeArgs(thread: Thread): string[] {
  if (!thread.sessionId) return thread.args;
  const key = resolveKey(thread);
  if (!key) return thread.args;
  const builder = builders[key];
  if (!builder) return thread.args;
  return builder(thread.sessionId, thread.args);
}
