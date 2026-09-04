import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "target", "chat-smoke");
mkdirSync(output, { recursive: true });
const mock = path.join(root, "scripts/chat-smoke/backend.ts");
const server = await createServer({
  configFile: false, root: path.join(root, "scripts/chat-smoke"),
  plugins: [tailwindcss(), svelte({ configFile: false })],
  resolve: { alias: [
    { find: /^\$lib\/backend$/, replacement: mock },
    { find: "$lib/features/notifications/store.svelte", replacement: mock },
    { find: "$lib/shared/log", replacement: mock },
    { find: "$lib", replacement: path.join(root, "src/lib") },
  ] },
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
});
let browser;
let socket;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0",
    `--user-data-dir=${mkdtempSync(path.join(output, "profile-"))}`, "about:blank",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Headless Edge startup timed out")), 30000);
    let stderr = "";
    browser.once("error", reject);
    browser.stderr.on("data", (chunk) => {
      stderr += chunk;
      const found = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (found) { clearTimeout(timer); resolve(found[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  function call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => call(method, params, sessionId);
  async function evaluate(expression) {
    const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails));
    return answer.result.value;
  }
  await send("Page.enable");
  for (const [name, width, height, state] of [
    ["desktop", 1280, 850, "ready"], ["mobile", 390, 844, "ready"],
    ["connecting", 900, 650, "connecting"], ["failed", 900, 650, "failed"],
  ]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/?state=${state}` });
    await evaluate(`new Promise(resolve => {
      const ready = () => document.querySelector('[data-testid="smoke-ready"]');
      if (ready()) return resolve(true);
      const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); resolve(true); } });
      observer.observe(document, { childList: true, subtree: true });
    })`);
    await evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `${name}: horizontal overflow`);
    if (state === "ready") {
      await evaluate(`(() => {
        const input = document.querySelector('[data-testid="chat-input"]');
        input.value = 'Vérifie les tests'; input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
      await evaluate("document.querySelector('[data-testid=chat-send]').click()");
      await evaluate("document.querySelector('[data-testid=pilot-request-option]').click()");
      await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
      const calls = await evaluate("window.chatSmokeCalls");
      assert(calls.some((item) => item[0] === "send" && item[2] === "Vérifie les tests"));
      assert(calls.some((item) => item[0] === "respond" && item[2] === "approval" && item[3] === "allow"));
    } else {
      assert.equal(await evaluate("document.querySelector('[data-testid=chat-open-session]').disabled"), state === "connecting");
    }
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(output, `${name}.png`), Buffer.from(screenshot.data, "base64"));
    console.log(`PASS ${name}: layout and controls; ${path.join(output, `${name}.png`)}`);
  }
  await call("Browser.close");
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) browser.kill();
  await server.close();
}
