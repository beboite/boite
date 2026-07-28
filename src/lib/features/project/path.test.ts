import { describe, expect, it } from "vitest";
import { folderNameFor, joinPath, samePath } from "./path";

describe("folderNameFor", () => {
  it("turns a spoken project name into a path segment", () => {
    expect(folderNameFor("My New Thing")).toBe("my-new-thing");
    expect(folderNameFor("boite")).toBe("boite");
  });

  // The name usually comes out of a conversation, so it arrives with whatever
  // punctuation was in the sentence. Every one of these is refused by at least
  // one of the operating systems we ship on.
  it("drops what a filesystem would refuse", () => {
    expect(folderNameFor("Réservation d'hôtel")).toBe("reservation-d-hotel");
    expect(folderNameFor("a/b\\c:d*e?f")).toBe("a-b-c-d-e-f");
    expect(folderNameFor("  spaced  out  ")).toBe("spaced-out");
    expect(folderNameFor("...dots...")).toBe("dots");
  });

  // An empty segment would put the project at its own parent folder, which is
  // where every other project lives.
  it("never yields nothing", () => {
    expect(folderNameFor("!!!")).toBe("project");
    expect(folderNameFor("   ")).toBe("project");
  });

  it("stays short enough to be a folder name", () => {
    expect(folderNameFor("x".repeat(200)).length).toBe(64);
  });
});

describe("joinPath", () => {
  // The result is shown to the user and compared against paths they typed, so
  // a Windows path that comes back forward-slashed reads as a different folder.
  it("keeps the separator the parent already uses", () => {
    expect(joinPath("D:\\Dev\\Collab", "thing")).toBe("D:\\Dev\\Collab\\thing");
    expect(joinPath("/home/me/dev", "thing")).toBe("/home/me/dev/thing");
    expect(joinPath("/home/me/dev/", "thing")).toBe("/home/me/dev/thing");
  });

  // A mixed path came through some layer that already normalized it; forward
  // slashes work on Windows too, so that is the safe reading.
  it("treats a mixed path as forward-slashed", () => {
    expect(joinPath("D:/Dev\\Collab", "thing")).toBe("D:/Dev\\Collab/thing");
  });
});

describe("samePath", () => {
  it("sees through separators, trailing slashes and case", () => {
    expect(samePath("D:\\Dev\\boite", "d:/dev/boite")).toBe(true);
    expect(samePath("/home/me/x/", "/home/me/x")).toBe(true);
    expect(samePath("/home/me/x", "/home/me/y")).toBe(false);
  });
});
