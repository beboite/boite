import { describe, expect, it } from "vitest";
import type { UsageReport } from "../types";
import { environmentLabel, mergeUsageReports } from "./merge";

function report(p: Partial<UsageReport>): UsageReport {
  return { models: [], days: [], sessions: 0, missing: [], ...p };
}

function model(name: string, total: number, provider = "claude") {
  return {
    provider,
    model: name,
    input: total / 4,
    output: total / 4,
    cacheWrite: total / 4,
    cacheRead: total / 4,
    total,
  };
}

describe("environmentLabel", () => {
  it("prefers the name the boite answered with", () => {
    expect(environmentLabel("nanonist", "wss://box.example/ws")).toBe("nanonist");
  });

  it("falls back to the host", () => {
    expect(environmentLabel(null, "wss://box.example:7337/ws")).toBe("box.example:7337");
  });

  it("keeps an unparseable url rather than drawing nothing", () => {
    expect(environmentLabel("", "not a url")).toBe("not a url");
  });
});

describe("mergeUsageReports", () => {
  it("sums a model across environments and keeps the heaviest first", () => {
    const merged = mergeUsageReports([
      report({ models: [model("sonnet", 100), model("opus", 400)], sessions: 3 }),
      report({ models: [model("sonnet", 500)], sessions: 2 }),
    ]);
    expect(merged.models.map((m) => [m.model, m.total])).toEqual([
      ["sonnet", 600],
      ["opus", 400],
    ]);
    expect(merged.models[0].input).toBe(150);
    expect(merged.sessions).toBe(5);
  });

  it("keeps two providers reporting the same model apart", () => {
    const merged = mergeUsageReports([
      report({ models: [model("gpt-5", 100, "codex")] }),
      report({ models: [model("gpt-5", 40, "claude")] }),
    ]);
    expect(merged.models.map((m) => [m.provider, m.total])).toEqual([
      ["codex", 100],
      ["claude", 40],
    ]);
  });

  it("adds days that both machines worked and keeps them ascending", () => {
    const merged = mergeUsageReports([
      report({ days: [{ day: "2026-08-02", total: 10 }, { day: "2026-08-01", total: 5 }] }),
      report({ days: [{ day: "2026-08-02", total: 7 }] }),
    ]);
    expect(merged.days).toEqual([
      { day: "2026-08-01", total: 5 },
      { day: "2026-08-02", total: 17 },
    ]);
  });

  it("unions the agents nothing could account for", () => {
    const merged = mergeUsageReports([
      report({ missing: ["codex"] }),
      report({ missing: ["codex", "opencode"] }),
    ]);
    expect([...merged.missing].sort()).toEqual(["codex", "opencode"]);
  });

  it("one environment that did not answer makes the total unreachable", () => {
    const merged = mergeUsageReports([
      report({ models: [model("sonnet", 100)] }),
      report({ unreachable: true }),
    ]);
    expect(merged.unreachable).toBe(true);
  });

  it("says nothing about reachability when every environment answered", () => {
    expect(mergeUsageReports([report({}), report({})]).unreachable).toBeUndefined();
  });

  it("does not mutate the reports it was handed", () => {
    const a = report({ models: [model("sonnet", 100)] });
    mergeUsageReports([a, report({ models: [model("sonnet", 50)] })]);
    expect(a.models[0].total).toBe(100);
  });

  it("merges nothing into an empty report", () => {
    expect(mergeUsageReports([])).toEqual({
      models: [],
      days: [],
      sessions: 0,
      missing: [],
    });
  });
});
