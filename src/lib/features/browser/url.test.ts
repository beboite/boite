import { describe, expect, it } from "vitest";
import { classifyBrowserUrl, isLocalPage } from "./url";

/**
 * The same cases as `browser_url_tests` in `agent_api.rs`, on purpose.
 *
 * These two validators guard the same door from opposite sides — the endpoint
 * for an agent on this machine, this one for the identical request arriving
 * from a remote boite — so a rule that holds in one and not the other is a hole
 * shaped exactly like the difference between them.
 */

function refusal(raw: string): string {
  const target = classifyBrowserUrl(raw);
  if (target.ok) throw new Error(`${raw} was allowed`);
  return target.reason;
}

function allowed(raw: string): { url: string; local: boolean } {
  const target = classifyBrowserUrl(raw);
  if (!target.ok) throw new Error(`${raw} was refused: ${target.reason}`);
  return { url: target.url, local: target.local };
}

describe("classifyBrowserUrl", () => {
  it("treats a dev server on this machine as local", () => {
    for (const raw of [
      "http://localhost:5173/",
      "http://127.0.0.1:3000/x?y=1",
      "http://[::1]:8080/",
      "http://0.0.0.0:4000/",
      "https://localhost:5173/",
    ]) {
      expect(allowed(raw).local, raw).toBe(true);
    }
  });

  it("allows anywhere else over https, and marks it as not local", () => {
    const target = allowed("https://github.com/beboite/boite/pull/1");
    expect(target.local).toBe(false);
    expect(target.url).toBe("https://github.com/beboite/boite/pull/1");
  });

  it("refuses credentials in the authority", () => {
    // The host a human reads is `evil.com`; the host the request goes to is
    // whatever follows the @. No prefix check can see the difference.
    expect(refusal("http://evil.com@localhost/")).toBe("credentials");
    expect(refusal("https://user:pass@example.com/")).toBe("credentials");
  });

  it("refuses the app's own origin", () => {
    for (const raw of [
      "http://tauri.localhost/index.html",
      "http://ipc.localhost/",
      "http://asset.localhost/x",
      "https://tauri.localhost/",
      "http://localhost:1420/",
      "http://127.0.0.1:1420/",
      "http://localhost:1430/",
    ]) {
      expect(refusal(raw), raw).toBe("appOrigin");
    }
  });

  it("stops cleartext at this machine", () => {
    expect(refusal("http://example.com/")).toBe("cleartext");
    expect(refusal("http://[::]/")).toBe("cleartext");
    expect(refusal("http://127.0.0.2:3000/")).toBe("cleartext");
  });

  it("takes http and https and nothing else", () => {
    expect(refusal("file:///etc/passwd")).toBe("scheme");
    expect(refusal("javascript:alert(1)")).toBe("scheme");
    expect(refusal("data:text/html,<script>x</script>")).toBe("scheme");
    expect(refusal("tauri://localhost/")).toBe("scheme");
    expect(refusal("localhost:3000")).toBe("scheme");
    expect(refusal("not a url at all")).toBe("notAUrl");
  });

  it("answers with the parsed form, not the string it was handed", () => {
    expect(allowed("  HTTP://LocalHost:3000  ").url).toBe("http://localhost:3000/");
  });
});

describe("isLocalPage", () => {
  it("is what decides whether the frame keeps its own origin", () => {
    expect(isLocalPage("http://localhost:5173/")).toBe(true);
    expect(isLocalPage("https://example.com/")).toBe(false);
    // A refused address never reaches the pane, and if one did it would not be
    // the one that gets allow-same-origin.
    expect(isLocalPage("http://tauri.localhost/")).toBe(false);
  });
});
