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
  it("shows the persisted conversation before waiting for the engine", async () => {
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
    expect(seen).toEqual(["created", "shown", "opened"]);

    open.done();
    await launch;
    expect(seen).toEqual(["created", "shown", "opened"]);
  });

  it("shows the pane even when nothing had to be waited for", async () => {
    const seen: string[] = [];
    await openChatThread({
      created: async () => seen.push("created"),
      opened: async () => seen.push("opened"),
      shown: () => void seen.push("shown"),
    });
    expect(seen).toEqual(["created", "shown", "opened"]);
  });

  it("does not open or show a row whose write failed", async () => {
    const seen: string[] = [];
    await expect(openChatThread({
      created: async () => { throw new Error("write failed"); },
      shown: () => void seen.push("shown"),
      opened: async () => seen.push("opened"),
    })).rejects.toThrow("write failed");
    expect(seen).toEqual([]);
  });

  it("keeps the conversation visible when the engine fails", async () => {
    const seen: string[] = [];
    await expect(openChatThread({
      created: async () => undefined,
      shown: () => void seen.push("shown"),
      opened: async () => { throw new Error("engine failed"); },
    })).rejects.toThrow("engine failed");
    expect(seen).toEqual(["shown"]);
  });
});
