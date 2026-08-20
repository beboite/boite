import { describe, expect, it } from "vitest";
import {
  formatReset,
  rowFromCodexSwitcher,
  rowFromKebacc,
  windowPercent,
  windowsFromUsage,
} from "./accounts";

describe("windowsFromUsage", () => {
  it("turns each usage key into a window", () => {
    const windows = windowsFromUsage({
      weekly: { remaining_percent: 12 },
      five_hour: { used_percent: 0, remaining_percent: 100, resets_at: null },
    });
    expect(windows).toEqual([
      { label: "weekly", usedPercent: null, remainingPercent: 12, reset: null },
      { label: "five hour", usedPercent: 0, remainingPercent: 100, reset: null },
    ]);
  });

  it("ignores a missing or scalar usage", () => {
    expect(windowsFromUsage(null)).toEqual([]);
    expect(windowsFromUsage("nope")).toEqual([]);
  });
});

describe("rowFromKebacc", () => {
  it("keeps the CLI's window labels", () => {
    const row = rowFromKebacc("claude", {
      email: "a@b.c",
      active: true,
      windows: [
        { label: "5h", used_percent: 0, remaining_percent: null, reset: null },
        { label: "7d", used_percent: 94, remaining_percent: 6, reset: "9h13m" },
      ],
    });
    expect(row.source).toBe("kebacc");
    expect(row.windows[1]).toEqual({
      label: "7d",
      usedPercent: 94,
      remainingPercent: 6,
      reset: "9h13m",
    });
  });
});

describe("rowFromCodexSwitcher", () => {
  it("walks whatever usage object the CLI sent", () => {
    const row = rowFromCodexSwitcher({
      id: "acc-1",
      email: "c@d.e",
      is_active: false,
      usage: { weekly: { remaining_percent: 40 } },
    });
    expect(row.source).toBe("codex-switcher");
    expect(row.windows[0]?.label).toBe("weekly");
    expect(windowPercent(row.windows[0]!)).toBe("40%");
  });
});

describe("formatReset", () => {
  it("leaves a human span alone", () => {
    expect(formatReset("9h13m", Date.now())).toBe("9h13m");
  });

  it("turns an ISO timestamp into a remaining span", () => {
    const now = Date.parse("2026-08-20T12:00:00Z");
    expect(formatReset("2026-08-21T02:00:00Z", now)).toBe("14h 0m");
  });

  it("drops a reset that has already passed", () => {
    expect(formatReset("2020-01-01T00:00:00Z", Date.now())).toBeNull();
  });
});

describe("windowPercent", () => {
  it("prefers used over remaining", () => {
    expect(
      windowPercent({ label: "7d", usedPercent: 94, remainingPercent: 6, reset: null }),
    ).toBe("94%");
  });
});
