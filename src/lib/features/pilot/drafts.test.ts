import { describe, expect, it } from "vitest";
import { createDraftStore, draftKey, remoteDraftScope, restoreFailedDraft } from "./drafts";

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); } };
}

describe("pilot drafts", () => {
  it("never persists connection credentials in scope keys", () => {
    expect(remoteDraftScope(null, "wss://user:password@host/path?token=value#fragment"))
      .toBe("remote:wss://host/path");
    expect(remoteDraftScope("device", null)).toBe("remote:device");
  });
  it("survives remount and restart with whitespace intact", () => {
    const disk = storage();
    const key = draftKey("local", "a");
    createDraftStore(() => disk).write(key, "  été\nunfinished ");
    expect(createDraftStore(() => disk).read(key)).toBe("  été\nunfinished ");
  });
  it("isolates threads and workspaces, including delimiter-shaped IDs", () => {
    const drafts = createDraftStore(storage);
    drafts.write(draftKey("a:b", "c"), "one");
    expect(drafts.read(draftKey("a", "b:c"))).toBe("");
    expect(drafts.read(draftKey("remote", "c"))).toBe("");
    expect(drafts.read(draftKey("a:b", "other"))).toBe("");
  });
  it("removes sent or cleared drafts from persistent storage", () => {
    const disk = storage();
    const drafts = createDraftStore(() => disk);
    drafts.write("key", "draft"); drafts.write("key", "");
    expect(disk.getItem("key")).toBeNull();
    expect(drafts.read("key")).toBe("");
  });
  it("keeps composing when storage throws", () => {
    const drafts = createDraftStore(() => { throw Error("denied"); });
    expect(drafts.read("new")).toBe("");
    drafts.write("key", "draft");
    expect(drafts.read("key")).toBe("draft");
  });
  it("rejects corrupt storage and non-string values", () => {
    const disk = storage();
    for (const raw of ["{", "null", "42", "{}", "[]"]) {
      disk.setItem("key", raw);
      expect(createDraftStore(() => disk).read("key")).toBe("");
    }
  });
  it("keeps oversized drafts in memory without restoring an older disk value", () => {
    const disk = storage();
    const drafts = createDraftStore(() => disk);
    drafts.write("key", "old");
    const long = "x".repeat(256 * 1024 + 1);
    drafts.write("key", long);
    expect(drafts.read("key")).toBe(long);
    expect(disk.getItem("key")).toBeNull();
  });
  it("preserves new typing when an earlier send fails", () => {
    expect(restoreFailedDraft("first", "second")).toBe("first\n\nsecond");
    expect(restoreFailedDraft("first", "")).toBe("first");
  });
});
