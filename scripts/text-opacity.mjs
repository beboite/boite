#!/usr/bin/env node
// Reject text-(muted-foreground|foreground)/<n> opacity variants.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const src = join(root, "src");

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sources(path));
    } else if (/\.(svelte|ts)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

const re = /\btext-(?:muted-foreground|foreground)\/[0-9]+/;
const violations = [];

for (const file of sources(src)) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      violations.push(`${relative(root, file)}:${i + 1}: ${lines[i].trim()}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`text-opacity: ${violations.length} forbidden opacity class(es):\n${violations.join("\n")}`);
  process.exit(1);
}

console.log("text-opacity: clean, no text opacity classes found.");
