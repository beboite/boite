#!/usr/bin/env node
// What the window downloads before it can paint, measured rather than guessed.
//
// This exists because of a standing rule: an optimisation with no measurement
// attached is removed. Two of Boite's optimisations are about bundle size — the
// lazily imported PDF worker and the split route chunks — and until now nobody
// could say what either was worth, or notice the day one stopped working.
//
// The number that matters is not the total. It is the *eager* graph: the entry
// and everything reachable from it through static imports, which the browser
// has to have before the first paint. Something moved out of that graph and
// behind a dynamic import is the whole point of splitting; something that
// quietly moved back in is the regression, and the total barely twitches when
// it happens.
//
// Read from vite's own manifest rather than by parsing the output, because vite
// is what decided which import was static. Filenames are content-hashed, so
// there is nothing stable to budget per file: the ceilings are on the graph.

import { readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(root, ".svelte-kit/output/client/.vite/manifest.json");
const BUILD = join(root, "build");
const BUDGET = join(root, "scripts/bundle-budget.json");

if (!existsSync(MANIFEST)) {
  console.error("no vite manifest: run `bun run build` first");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const budget = JSON.parse(readFileSync(BUDGET, "utf8"));

/** Every record reachable from the entries through static imports only. */
function eagerClosure() {
  // Records are keyed by source path for entries and by output name for shared
  // chunks, and `imports` uses the latter. One index over both, so a walk does
  // not have to know which kind of key it is holding.
  const byKey = new Map(Object.entries(manifest));
  const byFile = new Map(Object.values(manifest).map((r) => [r.file, r]));
  const resolve = (name) => byKey.get(name) ?? byFile.get(name);

  const seen = new Set();
  const queue = Object.values(manifest).filter((r) => r.isEntry);
  while (queue.length > 0) {
    const record = queue.pop();
    if (!record || seen.has(record.file)) continue;
    seen.add(record.file);
    // `dynamicImports` deliberately not followed: that edge is the split.
    for (const name of record.imports ?? []) {
      const next = resolve(name);
      if (next) queue.push(next);
    }
    for (const css of record.css ?? []) seen.add(css);
  }
  return seen;
}

function bytes(file) {
  const path = join(BUILD, file);
  return existsSync(path) ? statSync(path).size : 0;
}

const eager = eagerClosure();
const everything = new Set();
for (const record of Object.values(manifest)) {
  everything.add(record.file);
  for (const css of record.css ?? []) everything.add(css);
}

const sum = (files) => [...files].reduce((n, f) => n + bytes(f), 0);
const eagerBytes = sum(eager);
const totalBytes = sum(everything);
const biggestEager = [...eager]
  .map((f) => ({ f, size: bytes(f) }))
  .sort((a, b) => b.size - a.size);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const checks = [
  ["eager graph", eagerBytes, budget.eagerBytes],
  ["everything shipped", totalBytes, budget.totalBytes],
  ["largest eager chunk", biggestEager[0]?.size ?? 0, budget.largestEagerChunkBytes],
];

let failed = false;
for (const [label, actual, ceiling] of checks) {
  const over = actual > ceiling;
  failed ||= over;
  const slack = ceiling - actual;
  console.log(
    `${over ? "OVER" : "ok  "}  ${label.padEnd(20)} ${kb(actual).padStart(10)}  ` +
      `ceiling ${kb(ceiling)}  ${over ? `over by ${kb(-slack)}` : `${kb(slack)} spare`}`,
  );
}

console.log(`\n${eager.size} files load before first paint, ${everything.size} shipped in all.`);
console.log("Largest five in the eager graph:");
for (const { f, size } of biggestEager.slice(0, 5)) {
  console.log(`  ${kb(size).padStart(10)}  ${f}`);
}

if (failed) {
  console.error(
    "\nBUNDLE BUDGET FAIL\n" +
      "Either the growth is worth it and the ceiling in scripts/bundle-budget.json\n" +
      "moves in the same commit, with the reason in the message, or something that\n" +
      "was behind a dynamic import stopped being behind one.",
  );
  process.exit(1);
}
console.log("\nBUNDLE BUDGET PASS");
