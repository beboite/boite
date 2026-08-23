#!/usr/bin/env node
// Keys `messages.ts` defines that nothing asks for.
//
// The other direction is already impossible: `MessageKey` is derived from
// EN_MESSAGES, so `t("typo")` fails svelte-check, and `FR_MESSAGES` is typed
// `Record<MessageKey, string>`, so a missing translation fails the same gate.
// Nothing watches the direction this checks, and it is the one that accumulates
// quietly: a key survives the component that used it, gets translated on the
// next pass over the French file, and ships on the boot path forever.
//
// Two ways a key is asked for, and both count:
//   t("editor.save")            an ordinary call
//   t(`browser.refuse.${why}`)  a family, named by its prefix
// The second is why a plain string search is not enough. A template literal
// marks every key under its prefix as used, because from here there is no
// telling which arm of it runs.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const src = join(root, "src");
const messages = join(src, "lib", "i18n", "messages.ts");
const skip = new Set(["messages.ts", "messages.fr.ts"]);

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sources(path));
      continue;
    }
    if (/\.(svelte|ts|js)$/.test(name) && !skip.has(name)) out.push(path);
  }
  return out;
}

const defined = [...readFileSync(messages, "utf8").matchAll(/^\s{2}"([^"]+)":/gm)].map(
  (m) => m[1],
);
if (defined.length === 0) {
  console.error("i18n: no keys found in messages.ts — the scan would pass for the wrong reason");
  process.exit(1);
}

const asked = new Set();
const families = [];
for (const file of sources(src)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)["']/g)) asked.add(m[1]);
  for (const m of text.matchAll(/`([a-zA-Z0-9_.]+?)\.\$\{/g)) families.push(`${m[1]}.`);
}

const unused = defined.filter(
  (key) => !asked.has(key) && !families.some((prefix) => key.startsWith(prefix)),
);

if (unused.length > 0) {
  console.error(
    `i18n: ${unused.length} key${unused.length === 1 ? "" : "s"} nothing asks for.\n` +
      `Delete them from messages.ts and messages.fr.ts, or use them:\n` +
      unused.map((k) => `  ${k}`).join("\n"),
  );
  process.exit(1);
}

console.log(`i18n: ${defined.length} keys, all asked for.`);
