import { describe, expect, it } from "vitest";
import { openChatThread } from "./session";

/** A promise the test settles by hand, so the order is the only variable. */
function deferred(): { promise: Promise<void>; done: () => void } {
  let done = () => {};
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, done };
}

describe("a chat launch", () => {
  it("opens the session only once the row is written, and the pane after that", async () => {
    const write = deferred();
    const open = deferred();
    const seen: string[] = [];

    const launch = openChatThread({
      created: () => {
        seen.push("created");
        return write.promise;
      },
      opened: () => {
        seen.push("opened");
        return open.promise;
      },
      shown: () => {
        seen.push("shown");
      },
    });

    // The write is in flight: nothing has asked the host for a session, which
    // is the refusal ("no thread <id>") this order exists to avoid.
    await Promise.resolve();
    expect(seen).toEqual(["created"]);

    write.done();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["created", "opened"]);

    open.done();
    await launch;
    expect(seen).toEqual(["created", "opened", "shown"]);
  });

  it("shows the pane even when nothing had to be waited for", async () => {
    const seen: string[] = [];
    await openChatThread({
      created: async () => seen.push("created"),
      opened: async () => seen.push("opened"),
      shown: () => void seen.push("shown"),
    });
    expect(seen).toEqual(["created", "opened", "shown"]);
  });
});
