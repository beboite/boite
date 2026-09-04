import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "target/chat-preview/debug");
const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.chat-preview.conf.json"), "utf8"));
assert.equal(config.identifier, "dev.boite.chat-preview");
assert.equal(config.build.devUrl, null);
const binary = readFileSync(path.join(output, "boite.exe"));
assert.equal(binary.toString("ascii", 0, 2), "MZ");
const pe = binary.readUInt32LE(0x3c);
assert.equal(binary.toString("ascii", pe, pe + 4), "PE\0\0");
assert.equal(binary.readUInt16LE(pe + 24 + 68), 2, "Must use the Windows GUI subsystem, without a console");
assert(binary.includes(Buffer.from(config.identifier)), "Isolated app identifier must be compiled in");
const fingerprints = path.join(output, ".fingerprint");
assert(readdirSync(fingerprints).some((name) => {
  const file = path.join(fingerprints, name, "lib-tauri.json");
  return existsSync(file) && JSON.parse(readFileSync(file, "utf8")).features.includes("custom-protocol");
}), "Tauri must embed frontend assets with custom-protocol");
for (const name of readdirSync(path.join(root, "build/_app/immutable/entry"))) {
  assert(binary.includes(Buffer.from(name)), `Missing current frontend entry: ${name}`);
}
assert(existsSync(path.join(output, "boite-mcp.exe")), "The sidecar must sit beside the executable");
console.log("PASS standalone: current frontend embedded, isolated identifier, GUI subsystem, sidecar present");
