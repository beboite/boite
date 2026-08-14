// The driver Boite injects into every frame of its own webview.
//
// This is how an agent reads and drives the page in a browser pane. The frame
// stays sandboxed and cross-origin: the app's scripts still reach nothing in
// here, and this file arrives through the webview's initialization-script
// machinery (WKUserScript, AddScriptToExecuteOnDocumentCreated, WebKit user
// scripts), which runs below the page's origin model rather than across it.
// The only line out is postMessage to the window that framed us.
//
// Who it listens to is the whole security story, so it is spelled out:
//
// - It runs only at depth one: `parent === top` and `self !== top`. In Boite,
//   depth one is a pane; the top frame is the app itself. A frame nested
//   inside a page refuses to wire up, because there its parent is the PAGE,
//   and answering the page's messages would hand a site the readable DOM of
//   whatever cross-origin frame it embeds. That is the exact isolation the
//   web model promises, and this file must not be the thing that breaks it.
// - It answers `event.source === window.parent` and nobody else. The page's
//   own scripts can post to their own window all day; their messages arrive
//   with `source === window`, not the parent, and are dropped unread.
// - It reads passwords as bullets. A snapshot is written into an agent's
//   context window and kept; what was typed into a password field is not
//   Boite's to copy there.
//
// Kept dependency-free and old-fashioned on purpose: it runs in every page,
// including ones that break the moment a global leaks. One IIFE, no globals
// except the test hook below.

(() => {
  "use strict";

  // How many elements a snapshot carries. A row costs the agent tokens three
  // times (transfer, render, read), so the cap is part of the contract; the
  // answer says how many were left behind.
  const MAX_ELEMENTS = 200;
  const MAX_TEXT = 8000;
  const NAME_MAX = 120;

  // uid -> element, element -> uid. uids are minted once per document and
  // never reused, which is what lets a click land after the page re-rendered
  // around the element, and what makes a diff meaningful.
  const byUid = new Map();
  const uidOf = new WeakMap();
  let nextUid = 1;
  // uid -> signature of the last snapshot, for mode=diff.
  let lastSeen = null;

  const INTERESTING =
    "a[href],button,input,select,textarea,[role],[onclick],[contenteditable]," +
    "h1,h2,h3,h4,h5,h6,summary,img[alt],[tabindex]";

  function visible(el) {
    if (el.checkVisibility && !el.checkVisibility()) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function roleOf(el) {
    const said = el.getAttribute("role");
    if (said) return said;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || (tag === "input" && /^(button|submit|reset)$/.test(el.type)))
      return "button";
    if (tag === "input") return el.type || "text";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    if (/^h[1-6]$/.test(tag)) return tag;
    if (tag === "img") return "img";
    if (tag === "summary") return "summary";
    if (el.isContentEditable) return "textbox";
    return tag;
  }

  function clip(s, max) {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(aria, NAME_MAX);
    if (el.labels && el.labels.length) return clip(el.labels[0].innerText, NAME_MAX);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return clip(placeholder, NAME_MAX);
    const alt = el.getAttribute("alt");
    if (alt) return clip(alt, NAME_MAX);
    const text = clip(el.innerText || el.textContent || "", NAME_MAX);
    if (text) return text;
    return clip(el.getAttribute("title") || el.value || "", NAME_MAX);
  }

  function valueOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      if (el.type === "password") return el.value ? "•••" : "";
      if (el.type === "checkbox" || el.type === "radio") return "";
      return clip(el.value, 80);
    }
    if (tag === "select") {
      const opt = el.selectedOptions && el.selectedOptions[0];
      return clip(opt ? opt.label : el.value, 80);
    }
    if (tag === "textarea") return clip(el.value, 80);
    return "";
  }

  function flagsOf(el) {
    const flags = [];
    if (el.disabled) flags.push("disabled");
    if (el.checked) flags.push("checked");
    if (el.required) flags.push("required");
    if (el.readOnly) flags.push("readonly");
    if (el === document.activeElement) flags.push("focused");
    if (el.tagName === "DETAILS" && el.open) flags.push("open");
    return flags;
  }

  function uidFor(el) {
    let uid = uidOf.get(el);
    if (!uid) {
      uid = "u" + nextUid++;
      uidOf.set(el, uid);
      byUid.set(uid, el);
    }
    return uid;
  }

  function rowFor(el) {
    const row = { u: uidFor(el), r: roleOf(el), n: nameOf(el) };
    const value = valueOf(el);
    if (value) row.v = value;
    if (el.tagName === "A" && el.href) row.h = el.href;
    const flags = flagsOf(el);
    if (flags.length) row.s = flags;
    return row;
  }

  function collect() {
    const rows = [];
    let dropped = 0;
    const all = document.querySelectorAll(INTERESTING);
    for (const el of all) {
      if (!visible(el)) continue;
      if (el.getAttribute("role") === "presentation") continue;
      if (rows.length >= MAX_ELEMENTS) {
        dropped++;
        continue;
      }
      rows.push(rowFor(el));
    }
    return { rows, dropped };
  }

  function signatureOf(row) {
    return [row.r, row.n, row.v || "", row.h || "", (row.s || []).join(",")].join("|");
  }

  function meta() {
    return { url: location.href, title: document.title };
  }

  function snapshot(args) {
    const mode = (args && args.mode) || "elements";

    if (mode === "text") {
      const budget = Math.max(200, Math.min((args && args.maxChars) || MAX_TEXT, 100000));
      const root =
        document.querySelector("main,[role=main],article") || document.body || document.documentElement;
      const text = (root.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
      return Object.assign(meta(), {
        mode: "text",
        text: text.slice(0, budget),
        truncated: text.length > budget,
      });
    }

    const { rows, dropped } = collect();
    const seen = new Map(rows.map((row) => [row.u, signatureOf(row)]));

    if (mode === "diff") {
      const before = lastSeen || new Map();
      const added = rows.filter((row) => !before.has(row.u));
      const changed = rows.filter(
        (row) => before.has(row.u) && before.get(row.u) !== signatureOf(row),
      );
      const removed = [...before.keys()].filter((uid) => !seen.has(uid));
      lastSeen = seen;
      return Object.assign(meta(), { mode: "diff", added, changed, removed });
    }

    lastSeen = seen;
    return Object.assign(meta(), { mode: "elements", elements: rows, dropped });
  }

  function resolve(uid) {
    const el = byUid.get(uid);
    if (!el || !el.isConnected) {
      throw new Error("that uid is gone from the page; take a fresh browser_snapshot");
    }
    return el;
  }

  function pointAt(el, type, extra) {
    const rect = el.getBoundingClientRect();
    const at = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    el.dispatchEvent(new MouseEvent(type, Object.assign(at, extra || {})));
  }

  function click(args) {
    const el = resolve(args.uid);
    el.scrollIntoView({ block: "center", inline: "center" });
    pointAt(el, "pointerover");
    pointAt(el, "pointerdown");
    pointAt(el, "mousedown");
    if (el.focus) el.focus();
    pointAt(el, "pointerup");
    pointAt(el, "mouseup");
    // The native path, so links navigate and buttons submit exactly as a
    // finger would have them.
    if (typeof el.click === "function") el.click();
    else pointAt(el, "click");
    if (args.double) {
      pointAt(el, "click", { detail: 2 });
      pointAt(el, "dblclick", { detail: 2 });
    }
    return meta();
  }

  function pressOn(target, key) {
    const at = { bubbles: true, cancelable: true, composed: true, key };
    target.dispatchEvent(new KeyboardEvent("keydown", at));
    target.dispatchEvent(new KeyboardEvent("keyup", at));
  }

  function typeInto(args) {
    const el = resolve(args.uid);
    el.scrollIntoView({ block: "center", inline: "center" });
    if (el.focus) el.focus();
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      const next = args.clear === false ? el.value + args.text : args.text;
      // Through the prototype's own setter: frameworks (React above all) wrap
      // the instance property, and writing through the wrapper makes the
      // change invisible to their change tracking.
      setter.call(el, next);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: args.text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      if (args.clear !== false) el.textContent = "";
      el.textContent += args.text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: args.text }));
    } else {
      throw new Error("that uid is not a field; browser_click may be what was meant");
    }
    if (args.submit) {
      pressOn(el, "Enter");
      const form = el.form;
      if (form && typeof form.requestSubmit === "function") form.requestSubmit();
    }
    return meta();
  }

  function press(args) {
    pressOn(document.activeElement || document.body, args.key);
    return meta();
  }

  function scroll(args) {
    if (args.uid) {
      resolve(args.uid).scrollIntoView({ block: "center", inline: "center" });
    } else {
      window.scrollBy({ top: args.dy || 0, behavior: "instant" });
    }
    return meta();
  }

  function locate(args) {
    const el = resolve(args.uid);
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    // Clamped to the viewport: the crop is of what is drawn, and a rectangle
    // hanging off screen would crop window chrome that has nothing to do with
    // the element.
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    return Object.assign(meta(), {
      rect: {
        x,
        y,
        w: Math.max(0, Math.min(r.right, window.innerWidth) - x),
        h: Math.max(0, Math.min(r.bottom, window.innerHeight) - y),
      },
    });
  }

  const verbs = { snapshot, click, type: typeInto, press, scroll, locate };

  // The test hook: vitest evaluates this file in a plain window and reaches
  // the internals directly. Nothing wires up in that mode, so the guard rules
  // below stay the only path a real frame ever takes.
  if (typeof window !== "undefined" && window.__BOITE_DRIVER_TEST__) {
    window.__boiteDriver = { verbs, collect, snapshot };
    return;
  }

  // Depth one only. See the header: this single line is what keeps the driver
  // from becoming a hole in the web's own frame isolation.
  if (window.self === window.top || window.parent !== window.top) return;

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || m.boite !== "drive" || typeof m.id !== "number") return;
    let answer;
    try {
      const verb = verbs[m.verb];
      if (!verb) throw new Error("the driver in this page does not know " + m.verb);
      answer = verb(m.args || {});
    } catch (e) {
      answer = { error: String((e && e.message) || e) };
    }
    answer.id = m.id;
    answer.boite = "driver";
    window.parent.postMessage(answer, "*");
  });

  // Say we are here, so the app can tell "no driver in that frame" from "the
  // page is slow": a frame navigated before Boite shipped this script, or a
  // build without it, stays silent and times out instead.
  try {
    window.parent.postMessage({ boite: "driver", ready: true }, "*");
  } catch {
    // A parent that cannot be reached is a frame being torn down.
  }
})();
