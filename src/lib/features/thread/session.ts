import { invoke } from "@tauri-apps/api/core";
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

export function getDetector(iconKey: IconKey): SessionDetector | null {
  if (!iconKey) return null;
  return detectors[iconKey] ?? null;
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
  if (!thread.sessionId || !thread.iconKey) return thread.args;
  const builder = builders[thread.iconKey];
  if (!builder) return thread.args;
  return builder(thread.sessionId, thread.args);
}
