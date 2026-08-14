import { describe, expect, it } from "vitest";
import { modeQueriesBackend, parsePaletteQuery } from "./modes";

describe("what the palette is being asked for", () => {
  it("stays in the mode it was opened in", () => {
    expect(parsePaletteQuery("git")).toEqual({ mode: "commands", term: "git" });
    expect(parsePaletteQuery("store", "files")).toEqual({
      mode: "files",
      term: "store",
    });
  });

  it("takes the prefix off the term", () => {
    expect(parsePaletteQuery(">settings")).toEqual({
      mode: "commands",
      term: "settings",
    });
    expect(parsePaletteQuery("/store.svelte")).toEqual({
      mode: "files",
      term: "store.svelte",
    });
  });

  /** The prefix on its own is a mode switch, not a search for one character. */
  it("switches on a bare prefix", () => {
    expect(parsePaletteQuery("/")).toEqual({ mode: "files", term: "" });
    expect(parsePaletteQuery(">")).toEqual({ mode: "commands", term: "" });
  });

  it("gets back to commands from files", () => {
    expect(parsePaletteQuery(">git", "files")).toEqual({
      mode: "commands",
      term: "git",
    });
  });

  /**
   * Pasting an address into a search box has said what it wants, and the
   * alternative is fuzzy-matching it against a list that will never hold it.
   */
  it("recognises a pasted URL from any mode", () => {
    for (const mode of ["commands", "files", "url"] as const) {
      expect(parsePaletteQuery("https://example.com", mode)).toEqual({
        mode: "url",
        term: "https://example.com",
      });
    }
    expect(parsePaletteQuery("  http://localhost:5173 ").mode).toBe("url");
  });

  it("does not read a word starting with http as an address", () => {
    expect(parsePaletteQuery("https-everywhere").mode).toBe("commands");
    expect(parsePaletteQuery("httpd").mode).toBe("commands");
  });

  /**
   * A box opened to take an address keeps taking one while it is half typed:
   * `local` is a prefix of `localhost`, and flipping to commands on the first
   * character would make the mode unreachable by typing.
   */
  it("keeps a half-typed address in url mode", () => {
    expect(parsePaletteQuery("local", "url")).toEqual({
      mode: "url",
      term: "local",
    });
  });

  it("says which mode has to ask the backend", () => {
    expect(modeQueriesBackend("files")).toBe(true);
    expect(modeQueriesBackend("commands")).toBe(false);
    expect(modeQueriesBackend("url")).toBe(false);
  });
});
