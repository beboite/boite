import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "win32") throw new Error("This preview builder targets Windows.");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

run("bun", ["run", "build"]);
run("cargo", ["build", "-p", "boite-mcp"]);
const sidecars = path.join(root, "src-tauri", "binaries");
mkdirSync(sidecars, { recursive: true });
copyFileSync(path.join(root, "target", "debug", "boite-mcp.exe"), path.join(sidecars, "boite-mcp-x86_64-pc-windows-msvc.exe"));

// Separate output and app identifier: neither the running executable nor its database is replaced.
const target = path.join(root, "target", "chat-preview");
run(process.execPath, [path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
  "build", "--debug", "--no-bundle", "--config", "src-tauri/tauri.chat-preview.conf.json"], {
  ...process.env,
  CARGO_TARGET_DIR: target,
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_DEV_DEBUG_ASSERTIONS: "false",
  CARGO_INCREMENTAL: "0",
});
const executable = path.join(target, "debug", "boite.exe");
if (!existsSync(executable)) throw new Error(`Missing executable: ${executable}`);
copyFileSync(path.join(sidecars, "boite-mcp-x86_64-pc-windows-msvc.exe"), path.join(target, "debug", "boite-mcp.exe"));
console.log(`Standalone chat preview: ${executable}`);
