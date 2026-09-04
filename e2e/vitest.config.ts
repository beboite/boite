import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";

/**
 * The order the files themselves document, rather than the one their timings
 * suggest.
 *
 * `chat` leaves two chat threads behind on the shared window: `resume` reads
 * the first of them back after a restart and `dock` reads the second. Vitest
 * orders files by how long each took on the last run, so the order changes
 * under you as a file gets slower or is unskipped, and a run that opened with
 * `dock` was reading a window `chat` had not set up yet. Anything not named
 * here keeps its place behind the ones that are.
 */
const ORDER = ["chat.e2e.ts", "resume.e2e.ts", "dock.e2e.ts"];

function rank(path: string): number {
  const at = ORDER.findIndex((name) => path.endsWith(name));
  return at === -1 ? ORDER.length : at;
}

class DocumentedOrder extends BaseSequencer {
  async sort(files: Parameters<BaseSequencer["sort"]>[0]) {
    const sorted = await super.sort(files);
    return sorted.sort((a, b) => rank(a.moduleId) - rank(b.moduleId));
  }
}

/**
 * The end-to-end run, which is not the unit run.
 *
 * Its own config because everything about it is the opposite of
 * `vitest.config.ts`: one worker instead of many, minutes instead of
 * milliseconds, and a real app on the machine instead of a module under jsdom.
 * Sharing one file would mean `bun run test` starting a dev window.
 *
 * One worker, no parallelism, no isolation between files: the scenarios share a
 * single dev window and the single `boite-mcp --dev` that owns it, and both of
 * those live on the worker's `globalThis`. Two workers would be two windows on
 * port 1430, and the second would find the port taken.
 *
 * `root` is spelled from this file's own URL rather than as `".."`: vitest
 * resolves a relative root against the working directory, which put it one
 * level above the repository and found no scenario at all.
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: ["e2e/**/*.e2e.ts"],
    environment: "node",
    globalSetup: ["./e2e/lib/globalSetup.ts"],
    setupFiles: ["./e2e/lib/setup.ts"],
    pool: "forks",
    minWorkers: 1,
    maxWorkers: 1,
    fileParallelism: false,
    isolate: false,
    // The first start compiles the app in debug. Ten minutes is what
    // `dev_window` itself waits, and this has to outlast it.
    hookTimeout: 15 * 60 * 1000,
    testTimeout: 3 * 60 * 1000,
    teardownTimeout: 60 * 1000,
    reporters: ["default"],
    sequence: { concurrent: false, sequencer: DocumentedOrder },
  },
});
