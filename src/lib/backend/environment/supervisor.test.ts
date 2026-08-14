import { describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  EnvironmentSupervisor,
  LONG_SUSPENSION_MS,
  STABLE_RESET_MS,
  type Effect,
} from "./supervisor";

// random() at 1 makes the jitter window collapse onto its ceiling, so a delay
// is exactly the backoff being asserted.
function make(now = { t: 0 }, random = 1) {
  const sup = new EnvironmentSupervisor("env-1", {
    now: () => now.t,
    random: () => random,
  });
  return { sup, now };
}

function delayOf(effects: Effect[]): number | null {
  const s = effects.find((e) => e.kind === "schedule");
  return s && s.kind === "schedule" ? s.delayMs : null;
}

function kinds(effects: Effect[]): string[] {
  return effects.map((e) => e.kind);
}

function connect(sup: EnvironmentSupervisor) {
  sup.start();
  sup.socketOpened();
  sup.configSucceeded();
}

describe("connection phases", () => {
  it("starts a dial and counts a generation", () => {
    const { sup } = make();
    expect(kinds(sup.start())).toEqual(["dial"]);
    expect(sup.phase).toBe("connecting");
    expect(sup.generation).toBe(1);
  });

  it("an open socket is not a connection until the config round trip lands", () => {
    const { sup } = make();
    sup.start();
    sup.socketOpened();
    expect(sup.phase).toBe("handshaking");
    expect(sup.isConnected).toBe(false);
    sup.configSucceeded();
    expect(sup.phase).toBe("connected");
    expect(sup.isConnected).toBe(true);
  });

  it("stop releases the session and keeps no timer", () => {
    const { sup } = make();
    connect(sup);
    expect(kinds(sup.stop())).toEqual(["cancel", "release"]);
    expect(sup.phase).toBe("idle");
    expect(sup.wanted).toBe(false);
  });

  it("a lost connection after stop is nobody's business", () => {
    const { sup } = make();
    connect(sup);
    sup.stop();
    expect(sup.connectionLost()).toEqual([]);
  });
});

describe("backoff", () => {
  it("doubles and stops at the cap", () => {
    const { sup } = make();
    sup.start();
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      seen.push(delayOf(sup.connectionLost())!);
      sup.timerFired();
    }
    expect(seen).toEqual([500, 1000, 2000, 4000, 8000, 16000, 16000, 16000]);
    expect(Math.max(...seen)).toBe(BACKOFF_MAX_MS);
  });

  it("jitters below the ceiling, never above it", () => {
    const { sup } = make({ t: 0 }, 0);
    sup.start();
    expect(delayOf(sup.connectionLost())).toBe(BACKOFF_MIN_MS / 2);
  });

  it("counts attempts and schedules a retry", () => {
    const { sup } = make();
    sup.start();
    expect(kinds(sup.connectionLost())).toEqual(["release", "schedule"]);
    expect(sup.attempts).toBe(1);
    expect(sup.phase).toBe("waiting");
  });

  it("resets after a connection that held for the stable window", () => {
    const { sup, now } = make();
    sup.start();
    for (let i = 0; i < 4; i++) {
      sup.connectionLost();
      sup.timerFired();
    }
    sup.socketOpened();
    sup.configSucceeded();
    expect(sup.attempts).toBe(0);
    now.t += STABLE_RESET_MS;
    expect(delayOf(sup.connectionLost())).toBe(BACKOFF_MIN_MS);
  });

  it("does not reset after a connection that flapped", () => {
    const { sup, now } = make();
    sup.start();
    for (let i = 0; i < 4; i++) {
      sup.connectionLost();
      sup.timerFired();
    }
    sup.socketOpened();
    sup.configSucceeded();
    now.t += STABLE_RESET_MS - 1;
    expect(delayOf(sup.connectionLost())).toBe(8000);
  });
});

describe("offline", () => {
  it("releases the session without burning a retry or setting a timer", () => {
    const { sup } = make();
    sup.start();
    sup.connectionLost();
    sup.timerFired();
    const attemptsBefore = sup.attempts;
    const effects = sup.networkOffline();
    expect(kinds(effects)).toEqual(["cancel", "release"]);
    expect(delayOf(effects)).toBeNull();
    expect(sup.phase).toBe("offline");
    expect(sup.attempts).toBe(attemptsBefore);
  });

  it("burns nothing however long it stays down", () => {
    const { sup } = make();
    connect(sup);
    sup.networkOffline();
    for (let i = 0; i < 50; i++) {
      expect(sup.networkOffline()).toEqual([]);
      expect(sup.timerFired()).toEqual([]);
    }
    expect(sup.attempts).toBe(0);
  });

  it("coming back online wakes it with the backoff reset", () => {
    const { sup } = make();
    sup.start();
    for (let i = 0; i < 5; i++) {
      sup.connectionLost();
      sup.timerFired();
    }
    sup.networkOffline();
    expect(kinds(sup.networkOnline())).toEqual(["dial"]);
    expect(sup.attempts).toBe(0);
    expect(delayOf(sup.connectionLost())).toBe(BACKOFF_MIN_MS);
  });

  it("a drop while the device is already offline schedules nothing", () => {
    const { sup } = make();
    connect(sup);
    sup.networkOffline();
    sup.networkOnline();
    sup.socketOpened();
    sup.configSucceeded();
    // The socket close that follows losing the network can arrive after the
    // offline event; it must not turn into a scheduled retry either.
    sup.networkOffline();
    expect(delayOf(sup.connectionLost())).toBeNull();
  });
});

describe("foregrounding", () => {
  it("probes a connected environment instead of replacing it", () => {
    const { sup } = make();
    connect(sup);
    const gen = sup.generation;
    expect(kinds(sup.foregrounded(5_000))).toEqual(["probe"]);
    expect(sup.phase).toBe("connected");
    expect(sup.generation).toBe(gen);
  });

  it("replaces the session only after a genuinely long suspension", () => {
    const { sup } = make();
    connect(sup);
    const gen = sup.generation;
    expect(kinds(sup.foregrounded(LONG_SUSPENSION_MS))).toEqual(["release", "dial"]);
    expect(sup.generation).toBe(gen + 1);
  });

  it("a failed probe is a lost connection", () => {
    const { sup } = make();
    connect(sup);
    sup.foregrounded(1_000);
    expect(kinds(sup.probeFailed())).toEqual(["release", "schedule"]);
  });

  it("does nothing to an environment that is not connected", () => {
    const { sup } = make();
    sup.start();
    sup.connectionLost();
    expect(sup.foregrounded(LONG_SUSPENSION_MS * 10)).toEqual([]);
    expect(sup.phase).toBe("waiting");
  });
});

describe("blocked", () => {
  it("a refused credential stops the loop rather than scheduling", () => {
    const { sup } = make();
    sup.start();
    sup.socketOpened();
    const effects = sup.authRejected();
    expect(kinds(effects)).toEqual(["cancel", "release"]);
    expect(sup.phase).toBe("blocked");
    expect(sup.blockedReason).toBe("auth");
  });

  it("stays blocked through timers, drops and the network coming back", () => {
    const { sup } = make();
    sup.start();
    sup.authRejected();
    expect(sup.timerFired()).toEqual([]);
    expect(sup.connectionLost()).toEqual([]);
    sup.networkOffline();
    expect(sup.networkOnline()).toEqual([]);
    expect(sup.phase).toBe("blocked");
    expect(sup.attempts).toBe(0);
  });

  it("a new credential is what unblocks it", () => {
    const { sup } = make();
    sup.start();
    sup.authRejected();
    expect(kinds(sup.credentialsChanged())).toEqual(["cancel", "dial"]);
    expect(sup.phase).toBe("connecting");
    expect(sup.blockedReason).toBeNull();
  });

  it("a config failure blocks too, and the network coming back wakes it", () => {
    const { sup } = make();
    sup.start();
    sup.socketOpened();
    expect(kinds(sup.configFailed())).toEqual(["cancel", "release"]);
    expect(sup.blockedReason).toBe("config");
    expect(sup.timerFired()).toEqual([]);
    sup.networkOffline();
    expect(kinds(sup.networkOnline())).toEqual(["dial"]);
    expect(sup.blockedReason).toBeNull();
  });

  it("start on a blocked environment does not spin", () => {
    const { sup } = make();
    sup.start();
    sup.authRejected();
    expect(sup.start()).toEqual([]);
    expect(sup.phase).toBe("blocked");
  });
});

describe("sync status", () => {
  it("is empty until something lands", () => {
    const { sup } = make();
    expect(sup.sync).toBe("empty");
    connect(sup);
    expect(sup.sync).toBe("empty");
  });

  it("a cached projection fills a cold start", () => {
    const { sup } = make();
    const token = sup.beginLoad("cache");
    expect(sup.acceptLoad(token)).toBe(true);
    expect(sup.sync).toBe("cached");
  });

  it("a live read announces itself and settles live", () => {
    const { sup } = make();
    connect(sup);
    const token = sup.beginLoad("live");
    expect(sup.sync).toBe("synchronizing");
    expect(sup.acceptLoad(token)).toBe(true);
    expect(sup.sync).toBe("live");
  });

  it("a cached read that lands after a fast reconnect is refused", () => {
    const { sup } = make();
    connect(sup);
    const cached = sup.beginLoad("cache");
    sup.connectionLost();
    sup.timerFired();
    sup.socketOpened();
    sup.configSucceeded();
    const live = sup.beginLoad("live");
    expect(sup.acceptLoad(live)).toBe(true);
    expect(sup.acceptLoad(cached)).toBe(false);
    expect(sup.sync).toBe("live");
  });

  it("a live read from a replaced socket is refused", () => {
    const { sup } = make();
    connect(sup);
    const stale = sup.beginLoad("live");
    sup.connectionLost();
    sup.timerFired();
    sup.socketOpened();
    sup.configSucceeded();
    expect(sup.acceptLoad(stale)).toBe(false);
    expect(sup.sync).not.toBe("live");
  });

  it("out-of-order live reads keep the newest", () => {
    const { sup } = make();
    connect(sup);
    const first = sup.beginLoad("live");
    const second = sup.beginLoad("live");
    expect(sup.acceptLoad(second)).toBe(true);
    expect(sup.acceptLoad(first)).toBe(false);
  });

  it("a second cached read does not overwrite the first", () => {
    const { sup } = make();
    const a = sup.beginLoad("cache");
    const b = sup.beginLoad("cache");
    expect(sup.acceptLoad(a)).toBe(true);
    expect(sup.acceptLoad(b)).toBe(false);
  });

  it("losing the connection demotes live data to cached, never to empty", () => {
    const { sup } = make();
    connect(sup);
    sup.acceptLoad(sup.beginLoad("live"));
    sup.connectionLost();
    expect(sup.sync).toBe("cached");
    sup.timerFired();
    sup.socketOpened();
    sup.configSucceeded();
    sup.beginLoad("live");
    expect(sup.sync).toBe("synchronizing");
  });

  it("a cold environment that drops goes back to empty", () => {
    const { sup } = make();
    connect(sup);
    sup.connectionLost();
    expect(sup.sync).toBe("empty");
  });

  it("a failed live read falls back rather than sticking on synchronizing", () => {
    const { sup } = make();
    connect(sup);
    sup.acceptLoad(sup.beginLoad("live"));
    const token = sup.beginLoad("live");
    sup.failLoad(token);
    expect(sup.sync).toBe("cached");
  });

  it("an unknown token is never accepted twice", () => {
    const { sup } = make();
    connect(sup);
    const token = sup.beginLoad("live");
    expect(sup.acceptLoad(token)).toBe(true);
    expect(sup.acceptLoad(token)).toBe(false);
  });
});
