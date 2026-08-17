import { describe, expect, it } from "vitest";
import { accountsOf, isJsonStatus, statusText } from "./status";

describe("plugin status", () => {
  it("reads rows only from schema 1", () => {
    expect(
      accountsOf({
        schema: 1,
        accounts: [{ id: "a", label: "a@x", current: true }],
      }),
    ).toEqual([{ id: "a", label: "a@x", current: true }]);
    expect(accountsOf({ schema: 0, text: "hello", accounts: [{ id: "a" }] })).toEqual(
      [],
    );
    expect(accountsOf(null)).toEqual([]);
  });

  it("keeps the raw text for a tool that has no json", () => {
    expect(statusText({ schema: 0, text: "  two accounts  " })).toBe("two accounts");
    expect(statusText({ schema: 1, current: "a" })).toBeNull();
  });

  it("treats only schema 1 as the contract", () => {
    expect(isJsonStatus({ schema: 1 })).toBe(true);
    expect(isJsonStatus({ schema: 0, text: "x" })).toBe(false);
    expect(isJsonStatus(null)).toBe(false);
  });
});
