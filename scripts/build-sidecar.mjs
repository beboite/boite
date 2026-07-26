// Builds boite-mcp and drops it where Tauri looks for a sidecar.
//
// Tauri resolves `externalBin: ["binaries/boite-mcp"]` to
// `src-tauri/binaries/boite-mcp-<target-triple>`, and the triple is the one
// being *built for*, not the one building. The release matrix cross-compiles
// (x86_64-apple-darwin on an arm runner), so the host triple is the wrong
// answer there — the job passes BOITE_TARGET, and only a plain local build
// falls back to asking rustc.
//
// Getting the name wrong does not degrade, it fails the bundle outright, so
// this checks the file exists before letting the build continue.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("host:"));
  if (!line) throw new Error("could not read the host triple from `rustc -vV`");
  return line.replace("host:", "").trim();
}

const target = process.env.BOITE_TARGET?.trim() || hostTriple();
const exe = target.includes("windows") ? ".exe" : "";

const args = ["build", "--release", "-p", "boite-mcp"];
// Only pass --target when cross-compiling: adding it for the host changes the
// output path (target/<triple>/release) for no reason, and needs the target
// installed even when it is the one we are already on.
const cross = target !== hostTriple();
if (cross) args.push("--target", target);

console.log(`[sidecar] building boite-mcp for ${target}`);
execFileSync("cargo", args, { cwd: root, stdio: "inherit" });

const built = join(root, "target", ...(cross ? [target] : []), "release", `boite-mcp${exe}`);
if (!existsSync(built)) {
  throw new Error(`cargo reported success but ${built} is missing`);
}

const outDir = join(root, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const dest = join(outDir, `boite-mcp-${target}${exe}`);
copyFileSync(built, dest);
console.log(`[sidecar] ${dest}`);
