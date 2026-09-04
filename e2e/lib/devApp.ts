/**
 * The end-to-end client: one `boite-mcp --dev` process, spoken to over stdio.
 *
 * Every scenario drives the isolated dev window through the same five tools an
 * agent gets, and never through the bridge underneath them. That is the point
 * of the file: what a scenario can reach is exactly what `dev_window`,
 * `dev_inspect`, `dev_drive`, `dev_logs` and `dev_db` answer, so a tool that
 * stops working fails a test here rather than an agent's session in three
 * weeks. A helper that reached the WebSocket directly would pass while the
 * door an agent knocks on was broken.
 *
 * One window per run, started in the global setup and stopped in the teardown.
 * The scenarios share it on purpose: a cold `tauri dev` is minutes, and the
 * suite would spend them once per file.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout this file lives in, which is the repo the window runs from. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The fake claude, launched as `node <path>`: a .mjs is not executable here. */
export const FAKE_CLAUDE = path.join(
  REPO_ROOT,
  "crates",
  "boite-pilot",
  "tests",
  "fake-claude.mjs",
);

/** Where a scenario name without a directory is looked up, in this order. */
const SCENARIO_DIRS = [
  path.join(REPO_ROOT, "e2e", "fixtures"),
  path.join(REPO_ROOT, "crates", "boite-pilot", "tests", "scenarios"),
];

export interface StartOptions {
  /** Wipe the dev instance's database first. `dev.boite.dev` only, ever. */
  fresh?: boolean;
  /** Merged onto the app's environment, over what `start` sets itself. */
  env?: Record<string, string>;
  /** A scenario file, or a name resolved under the two directories above. */
  scenario?: string;
  /** `restart` instead of `start`, which is how the resume scenario reboots. */
  restart?: boolean;
}

interface Pending {
  resolve: (value: ToolAnswer) => void;
  reject: (reason: Error) => void;
}

export interface ToolAnswer {
  text: string;
  isError: boolean;
}

/** How long a tool call may take before the client gives up on it. */
const CALL_TIMEOUT_MS = 12 * 60 * 1000;

/** The scenario every test runs against unless it asks for another one. */
export const DEFAULT_SCENARIO = "e2e.json";

export function scenarioPath(name: string): string {
  if (path.isAbsolute(name)) return name;
  for (const dir of SCENARIO_DIRS) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no scenario named ${name} under ${SCENARIO_DIRS.join(" or ")}`);
}

/**
 * The `boite-mcp` binary `cargo build -p boite-mcp` produced.
 *
 * Debug first, because that is what a checkout has after the build the README
 * names; release is accepted so a machine that only ever builds release is not
 * told to build again.
 */
export function devBinary(): string {
  const exe = process.platform === "win32" ? "boite-mcp.exe" : "boite-mcp";
  for (const profile of ["debug", "release"]) {
    const candidate = path.join(REPO_ROOT, "target", profile, exe);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `no ${exe} under ${path.join(REPO_ROOT, "target")}: run \`cargo build -p boite-mcp\` first`,
  );
}

export class DevApp {
  #child: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<number, Pending>();
  #buffer = "";
  #nextId = 1;
  #startedAtMs = 0;

  /** Unix milliseconds of the last successful `start`, for a `since` filter. */
  get startedAtMs(): number {
    return this.#startedAtMs;
  }

  /** Bring the shim up without touching the window. Idempotent. */
  connect(): void {
    if (!this.#child) this.#spawnShim();
  }

  /**
   * Spawn the shim and open the dev window.
   *
   * The three variables the pilot scenarios need go in every start:
   * `BOITE_PILOT_CLAUDE_BIN` so no turn spends a token or needs a credential,
   * `BOITE_PILOT_SCENARIO` so the fake knows what to replay, and
   * `CARGO_BUILD_JOBS` because the machine belongs to somebody who is working
   * on it while the debug build runs.
   */
  async start(options: StartOptions = {}): Promise<string> {
    this.connect();
    const env: Record<string, string> = {
      BOITE_DEV_UNATTENDED: "1",
      BOITE_PILOT_CLAUDE_BIN: `node "${FAKE_CLAUDE}"`,
      BOITE_PILOT_SCENARIO: scenarioPath(options.scenario ?? DEFAULT_SCENARIO),
      CARGO_BUILD_JOBS: "4",
      ...options.env,
    };
    const answer = await this.call("dev_window", {
      action: options.restart ? "restart" : "start",
      fresh: options.fresh ?? false,
      env,
    });
    if (answer.isError) throw new Error(`dev_window start refused: ${answer.text}`);
    this.#startedAtMs = Date.now();
    return answer.text;
  }

  /** Stop the window this client started, then the shim holding it. */
  async stop(): Promise<void> {
    if (!this.#child) return;
    try {
      await this.call("dev_window", { action: "stop" });
    } catch {
      // The shim is going away next, and its job object is the real stop.
    }
    const child = this.#child;
    this.#child = null;
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("the dev client was stopped"));
    }
    this.#pending.clear();
    child.stdin.end();
    child.kill();
  }

  /** `dev_window action=status`, as the TOON the tool answers. */
  async status(): Promise<string> {
    return (await this.call("dev_window", { action: "status" })).text;
  }

  /** One `window.__boite` read, parsed. The inspector answers JSON. */
  async inspect<T = unknown>(
    what: string,
    args: { id?: string; tail?: number } = {},
  ): Promise<T> {
    const answer = await this.expect("dev_inspect", { what, ...args });
    return JSON.parse(answer) as T;
  }

  /**
   * JavaScript in the webview, with its answer parsed.
   *
   * A function body, so it has to `return`. This is the last door to reach for
   * and every use of it here reads the DOM: driving goes through `click`,
   * `type` and `press`, which is what an agent has.
   */
  async js<T = unknown>(code: string): Promise<T> {
    const answer = await this.expect("dev_drive", { action: "eval", script: code });
    return JSON.parse(answer) as T;
  }

  async click(selector: string): Promise<string> {
    return this.expect("dev_drive", { action: "click", selector });
  }

  /** A click on the button or link showing this text, for a row with no hook. */
  async clickText(text: string): Promise<string> {
    return this.expect("dev_drive", { action: "click", text });
  }

  async type(selector: string, text: string): Promise<string> {
    return this.expect("dev_drive", { action: "type", selector, text });
  }

  async press(key: string): Promise<string> {
    return this.expect("dev_drive", { action: "press", key });
  }

  /** The viewport as a PNG at `path`, which is what the tool answers back. */
  async screenshot(target: string): Promise<string> {
    return this.expect("dev_drive", { action: "screenshot", path: target });
  }

  /** The dev instance's own log records, rendered one per line. */
  async logs(query: Record<string, string | number> = {}): Promise<string> {
    return this.expect("dev_logs", { action: "query", ...query });
  }

  /** One read-only statement against `dev.boite.dev`'s SQLite. */
  async db(sql: string): Promise<string> {
    return this.expect("dev_db", { sql });
  }

  /**
   * Poll a page predicate until it answers true.
   *
   * Through `js`, so what it waits on is what the window really shows rather
   * than a store this process cannot see. The failure carries the code, since
   * a timeout whose message is only "timed out" says nothing about which of
   * the six waits in a scenario gave up.
   */
  async waitFor(code: string, timeoutMs = 20_000, everyMs = 250): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
      try {
        const value = await this.js<unknown>(code);
        if (value) return;
        last = JSON.stringify(value);
      } catch (err) {
        last = String(err);
      }
      if (Date.now() > deadline) {
        throw new Error(`waitFor gave up after ${timeoutMs}ms on: ${code}\nlast: ${last}`);
      }
      await sleep(everyMs);
    }
  }

  /** Poll until a tool's own text matches, for the reads that are not the DOM. */
  async waitForText(
    read: () => Promise<string>,
    matches: (text: string) => boolean,
    timeoutMs = 20_000,
    everyMs = 400,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
      last = await read();
      if (matches(last)) return last;
      if (Date.now() > deadline) {
        throw new Error(`waitForText gave up after ${timeoutMs}ms\nlast: ${last}`);
      }
      await sleep(everyMs);
    }
  }

  /** A tool call whose refusal is a failed test rather than a value to read. */
  async expect(name: string, args: Record<string, unknown>): Promise<string> {
    const answer = await this.call(name, args);
    if (answer.isError) throw new Error(`${name} refused: ${answer.text}`);
    return answer.text;
  }

  /** One `tools/call`, with the refusal handed back rather than thrown. */
  async call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    return this.#request("tools/call", { name, arguments: args });
  }

  /** The tool list, which is what proves the shim answered the handshake. */
  async tools(): Promise<string[]> {
    const raw = await this.#raw("tools/list", {});
    const list = (raw as { tools?: { name?: string }[] }).tools ?? [];
    return list.map((tool) => tool.name ?? "");
  }

  #spawnShim(): void {
    const bin = devBinary();
    const child = spawn(bin, ["--dev", "--repo", REPO_ROOT], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    // Kept drained. A stderr nobody reads fills its pipe and blocks the shim.
    child.stderr.resume();
    child.on("exit", (code) => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error(`boite-mcp --dev exited with ${code}`));
      }
      this.#pending.clear();
    });
    this.#child = child;
    // The legacy handshake: this client opens with `initialize`, which is what
    // `rpc.rs` answers with the negotiated revision.
    void this.#raw("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "boite-e2e", version: "0" },
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end === -1) return;
      const line = this.#buffer.slice(0, end).trim();
      this.#buffer = this.#buffer.slice(end + 1);
      if (!line) continue;
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "json-rpc error"));
        continue;
      }
      pending.resolve(readContent(message.result));
    }
  }

  async #request(method: string, params: Record<string, unknown>): Promise<ToolAnswer> {
    this.connect();
    const child = this.#child;
    if (!child) throw new Error("the dev client is not started");
    const id = this.#nextId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<ToolAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} did not answer within ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
      child.stdin.write(line);
    });
  }

  /** A request whose raw `result` object is what the caller wants. */
  async #raw(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.connect();
    const child = this.#child;
    if (!child) throw new Error("the dev client is not started");
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} did not answer`));
      }, 60_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value.raw);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
}

/** The text of a `tools/call` result, with the raw body kept for `tools/list`. */
function readContent(result: unknown): ToolAnswer & { raw: unknown } {
  const body = (result ?? {}) as {
    content?: { type?: string; text?: string }[];
    isError?: boolean;
  };
  const text = (body.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  return { text, isError: body.isError === true, raw: result };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The one client the whole run shares, held on `globalThis` across files. */
const KEY = "__boiteDevApp";

export function devApp(): DevApp {
  const holder = globalThis as unknown as Record<string, DevApp | undefined>;
  holder[KEY] ??= new DevApp();
  return holder[KEY] as DevApp;
}
