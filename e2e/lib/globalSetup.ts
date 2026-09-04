/**
 * The checks that are worth making before a worker is even spawned.
 *
 * It runs in vitest's own process, which is not the one the scenarios run in,
 * so it deliberately owns nothing: the shim that holds the dev window has to
 * be a child of the process that issues `dev_window`, and that is the worker.
 * See `harness.ts`. What is left here is the failure that is cheap to give
 * early: a checkout with no `boite-mcp` built, which would otherwise be five
 * identical errors one per scenario.
 */

import { devBinary, REPO_ROOT } from "./devApp";

export function setup(): void {
  const bin = devBinary();
  process.stdout.write(`e2e: ${bin}\ne2e: repo ${REPO_ROOT}\n`);
}

export function teardown(): void {
  // Nothing to take down: the worker owns the window and stops it on the way
  // out, and the shim's job object is the second half of that stop.
}
