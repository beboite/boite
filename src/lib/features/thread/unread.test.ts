import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetUnread,
  isThreadUnread,
  markThreadRead,
  noteUnread,
  resetUnread,
  setUnreadWatcher,
  unreadCount,
  unreadSince,
} from "./unread.svelte";

/** Nothing is on screen unless a test says so, which is the window's default. */
function watching(...ids: string[]) {
  setUnreadWatcher((id) => ids.includes(id));
}

describe("unread marks", () => {
  beforeEach(() => {
    resetUnread();
    watching();
  });

  it("marks a thread nobody is looking at", () => {
    noteUnread("a");
    expect(isThreadUnread("a")).toBe(true);
  });

  /**
   * The whole reason the window registers a probe. A turn ending in the pane
   * the user is staring at is not news, it is what they watched happen, and a
   * dot on it would only be something to dismiss.
   */
  it("says nothing about a thread on screen", () => {
    watching("a");
    noteUnread("a");
    expect(isThreadUnread("a")).toBe(false);
  });

  it("still marks the ones off screen while another is watched", () => {
    watching("a");
    noteUnread("a");
    noteUnread("b");
    expect(isThreadUnread("a")).toBe(false);
    expect(isThreadUnread("b")).toBe(true);
  });

  it("clears on reading, and reading twice is not an error", () => {
    noteUnread("a");
    markThreadRead("a");
    markThreadRead("a");
    expect(isThreadUnread("a")).toBe(false);
  });

  it("keeps when the unseen thing happened", () => {
    noteUnread("a", 1234);
    expect(unreadSince("a")).toBe(1234);
    expect(unreadSince("b")).toBeNull();
  });

  it("keeps the last moment, not the first", () => {
    noteUnread("a", 1000);
    noteUnread("a", 2000);
    // The second turn overwrites: what the mark answers is "when did the thing
    // you have not seen happen", and that is the most recent one.
    expect(unreadSince("a")).toBe(2000);
  });

  it("counts a project's own", () => {
    noteUnread("a");
    noteUnread("c");
    expect(unreadCount(["a", "b", "c"])).toBe(2);
    expect(unreadCount([])).toBe(0);
  });

  it("forgets a closed thread", () => {
    noteUnread("a");
    forgetUnread("a");
    expect(isThreadUnread("a")).toBe(false);
  });

  /**
   * A workspace switch replaces every thread, and an id can be reused by a row
   * from the boite that just connected.
   */
  it("drops everything on a workspace switch", () => {
    noteUnread("a");
    noteUnread("b");
    resetUnread();
    expect(unreadCount(["a", "b"])).toBe(0);
  });

  it("counts nothing as watched once the window has gone", () => {
    const stop = setUnreadWatcher(() => true);
    stop();
    noteUnread("a");
    expect(isThreadUnread("a")).toBe(true);
  });

  /**
   * A remount installs the new probe before the old instance tears down, so a
   * cleanup that resets unconditionally wipes a probe it never installed and
   * every thread on screen quietly goes back to counting as unwatched.
   */
  it("ignores the cleanup of a probe that has been replaced", () => {
    const stopOld = setUnreadWatcher(() => false);
    setUnreadWatcher((id) => id === "a");
    stopOld();
    noteUnread("a");
    expect(isThreadUnread("a")).toBe(false);
  });
});
