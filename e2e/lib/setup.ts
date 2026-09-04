/**
 * Run once inside the test worker, before the first scenario.
 *
 * The window is not started here: it is started by the first `app()` call, so
 * a run of one scenario pays for one start and a run that only lists files
 * pays for none. What is here is the stop, registered on the worker's exit so
 * a failed run leaves nothing compiling.
 */

import { stopApp } from "./harness";

process.once("beforeExit", () => {
  void stopApp();
});
