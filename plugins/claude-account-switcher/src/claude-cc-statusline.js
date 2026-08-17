#!/usr/bin/env node
// claude-cc-statusline — the account-switcher segment of the Claude Code status
// line, and nothing else:
//
//   ⇄ alaric · 2/3 free ⏳4h20 pierre
//
// Who is logged in, how many saved accounts the switcher could still move to,
// and how long until the next blocked one comes back, named. The arrow is green while
// the switch is armed (watcher running, or the SessionStart hook installed) and
// red when it is not.
//
// This toolkit does not own anybody's status line, so this file never replaces
// one. It has three ways in, all additive:
//
//   node claude-cc-statusline.js            renders the segment alone (for a
//                                           user who has no status line yet)
//   node claude-cc-statusline.js --wrap     runs the status line that was there
//                                           before and appends the segment to
//                                           its output, untouched otherwise
//   require('claude-cc-statusline.js')      exposes accountSegments(payload) to
//                                           a hand-written status line that
//                                           wants to place the segment itself
//
// `--wrap` reads the wrapped command from ~/.claude-cc-accounts/.statusline.json
// ({"command": "...", "separator": "  │  "}), written by
// `claude-cc.ps1 statusline install` when it finds an existing status line. The
// wrapped command gets the same stdin payload and its stdout is passed through
// byte for byte, so its author's formatting, colours and version quirks survive.
//
// Disable: CLAUDE_CC_STATUSLINE=0 (the segment disappears, a wrapped status line
// still renders), or `claude-cc.ps1 statusline uninstall`, which puts the
// original command back exactly as it was.
//
// Hosts other than a full-width terminal — Boite and the other multi-agent
// terminals that run several Claude Code sessions in split panes — get the same
// segment, narrowed rather than truncated: see segmentBudget() for the width it
// fits into (COLUMNS, or opts.width from a caller composing its own line) and
// glyphs() for the ASCII fallback (CLAUDE_CC_STATUSLINE_ASCII=1). Colour still
// follows NO_COLOR and TERM=dumb.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const OFF = new Set(['0', 'false', 'off', 'no']);

// ---------------------------------------------------------------- colour

// Same convention as the rest of the toolkit: colour unless the terminal says
// no. A caller that renders into its own buffer can turn it off per call.
function makePainter(enabled) {
  const on = enabled && !process.env.NO_COLOR && String(process.env.TERM) !== 'dumb';
  const c = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { dim: c('2'), bold: c('1'), red: c('31'), green: c('32'), yellow: c('33'), cyan: c('36') };
}

// ---------------------------------------------------------------- glyphs

// The hourglass is a double-width emoji, and a terminal that advances it by one
// column shifts everything printed after it for the rest of the line; a few
// hosts show tofu instead. So the glyphs have an ASCII twin, forced with
// CLAUDE_CC_STATUSLINE_ASCII=1 and taken by default whenever the locale is not
// UTF-8 or the terminal declares itself dumb. Nothing is lost: every glyph here
// is decoration around text that already says the same thing.
const GLYPHS = {
  unicode: { arrow: '⇄', wait: '⏳', cut: '…', sep: ' · ', group: '  │  ' },
  ascii: { arrow: '<>', wait: '~', cut: '..', sep: ' | ', group: '  |  ' },
};

function asciiOnly() {
  const flag = process.env.CLAUDE_CC_STATUSLINE_ASCII;
  if (flag != null && flag !== '') return !OFF.has(String(flag).toLowerCase());
  const pref = renderPrefs().ascii;
  if (pref != null) return !!pref;
  if (String(process.env.TERM) === 'dumb') return true;
  const loc = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG;
  return !!loc && !/utf-?8/i.test(loc); // an unset locale is not a claim of ASCII
}

function glyphs(opts) {
  const o = opts || {};
  const ascii = o.ascii != null ? !!o.ascii : asciiOnly();
  return ascii ? GLYPHS.ascii : GLYPHS.unicode;
}

// ---------------------------------------------------------------- width

// A status line is one line shared with whatever else the host prints, and in a
// split pane it can be 40 columns wide. Nothing in the Claude Code payload
// reports that width, and stdout is a pipe, so it comes from the host: an
// explicit opts.width for a caller composing its own line, else COLUMNS (which
// terminal multiplexers export), else a "width" written once into
// .statusline.json — the way out for a host that spawns Claude Code on a bare
// PTY with no shell to export anything — else the tty if there is one. An
// unknown width means no constraint — guessing narrow would mutilate a
// full-width line.
function segmentBudget(opts) {
  const o = opts || {};
  const explicit = Number(o.width);
  const env = parseInt(process.env.CLAUDE_CC_STATUSLINE_WIDTH || process.env.COLUMNS || '', 10);
  const pref = Number(renderPrefs().width);
  const cols = Number.isFinite(explicit) && explicit > 0 ? explicit
    : Number.isFinite(env) && env > 0 ? env
    : Number.isFinite(pref) && pref > 0 ? pref
    : (process.stdout && process.stdout.columns) || 0;
  if (!cols) return Infinity;
  // Two fifths of the line: the switcher is one group among several (model,
  // quota gauges, cost), and taking more than its share is what pushes the rest
  // off — but it is also the widest of them, so a strict third starves it on a
  // pane that had room.
  return Math.max(16, Math.floor(cols * 0.4));
}

// What gives way when the pane is narrow, in order of how much it says: the
// name of the account coming back first, then the handle in use, and never the
// free count or the wait itself — those are the answer, the names are context.
function nameRooms(budget) {
  if (budget >= 34) return { who: 14, target: 10 };
  if (budget >= 26) return { who: 10, target: 6 };
  if (budget >= 20) return { who: 8, target: 0 };
  return { who: 0, target: 0 };
}

// ---------------------------------------------------------------- thresholds

// Two caps, as in claude-cc-common.ps1: the 5-hour window is what stops a
// session, so it blocks at 99%; the weekly one goes one step further (99.8%),
// because a weekly quota parked over usage that never stopped a session costs
// days, where the 5-hour one costs hours.
const AUTO_SWITCH_THRESHOLD = 99;
const AUTO_SWITCH_WEEKLY_THRESHOLD = 99.8;

function envThreshold(name, fallback) {
  const raw = parseFloat(process.env[name]);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : fallback;
}

function switchThreshold() {
  return envThreshold('CLAUDE_AUTOSWITCH_THRESHOLD', AUTO_SWITCH_THRESHOLD);
}

function weeklySwitchThreshold() {
  return envThreshold('CLAUDE_AUTOSWITCH_WEEKLY_THRESHOLD', AUTO_SWITCH_WEEKLY_THRESHOLD);
}

// Mirrors Test-CcOverCap in claude-cc-common.ps1. The API reports whole
// percents, so a reading of 99 really covers 99.0 to 99.9 and the 99.8% weekly
// cap sits inside it; comparing 99 >= 99.8 would claim room left and only ever
// call the account full at 100, when the quota is already gone. A reading with
// no decimals is therefore measured against the floor of the cap; the 5-hour
// cap, a whole number, is unaffected.
function atCap(pct, limit) {
  const cap = Number.isInteger(pct) ? Math.floor(limit) : limit;
  return pct >= cap;
}

// ---------------------------------------------------------------- state

// Snapshots store an ISO string, the live payload unix seconds.
function resetDate(v) {
  if (v == null) return null;
  const at = typeof v === 'number' ? new Date(v * 1000) : new Date(String(v));
  return Number.isNaN(at.getTime()) ? null : at;
}

// The switch is armed either by the background watcher or by the SessionStart
// hook running claude-code-auto.ps1 once per session. The watcher is checked
// first because it is the live path.
function autoSwitchOn() {
  return watcherRunning() || autoHookInstalled();
}

// The watcher writes its pid to the account store and clears the file on exit.
// A pid that no longer exists means it died without cleaning up, so the pid is
// probed rather than trusted; signal 0 tests existence without touching it.
function watcherRunning() {
  let pid;
  try {
    pid = parseInt(fs.readFileSync(path.join(storeDir(), '.watch.pid'), 'utf8').trim(), 10);
  } catch (e) {
    return false; // no pid file: the watcher is not running, or never was
  }
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM is the process answering that it exists and is not ours to signal —
    // the normal case when the watcher was started outside the sandbox or
    // container this pane runs in. Only ESRCH means it is gone.
    return !!e && e.code === 'EPERM';
  }
}

// Read both the user file and the local override, since either one can carry
// the hook, and treat an unreadable file as "no hook here" rather than failing
// the whole line.
function autoHookInstalled() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  for (const name of ['settings.json', 'settings.local.json']) {
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (e) {
      continue; // missing or malformed — the other file may still have it
    }
    const groups = (cfg && cfg.hooks && cfg.hooks.SessionStart) || [];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of (group && group.hooks) || []) {
        const cmd = hook && hook.command;
        if (typeof cmd === 'string' && cmd.indexOf('claude-code-auto.ps1') !== -1) return true;
      }
    }
  }
  return false;
}

function storeDir() {
  return process.env.CLAUDE_CC_ACCOUNTS || path.join(os.homedir(), '.claude-cc-accounts');
}

// Rendering preferences kept next to the account store, in the same
// .statusline.json that holds the wrapped command: {"width": 48, "ascii": true}.
// Env vars stay the first word — this file is for the host that never gets to
// set one, because it spawns Claude Code on a bare PTY with no login shell.
// Read once: the status line is re-rendered constantly and this file changes
// about never.
let PREFS = null;
function renderPrefs() {
  if (PREFS) return PREFS;
  PREFS = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(storeDir(), '.statusline.json'), 'utf8'));
    if (raw && typeof raw === 'object') PREFS = raw;
  } catch (e) {
    // absent or malformed: every setting in it is optional by construction
  }
  return PREFS;
}

// Which account is logged in. Claude Code records it in ~/.claude.json, which
// is the account identity and nothing else — the credential file, with the
// tokens in it, is never read here.
function currentAccountEmail() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const email = cfg && cfg.oauthAccount && cfg.oauthAccount.emailAddress;
    return typeof email === 'string' ? email.toLowerCase() : null;
  } catch (e) {
    return null; // no config, or unreadable — nothing gets excluded
  }
}

// How many saved accounts the switcher could actually move to right now: the
// pool minus everyone already at a threshold. The switcher caches each
// account's last usage reading in its own snapshot file, so this is answered
// from disk with no HTTP call and no pwsh process.
//
// When nothing is free, the same pass answers the follow-up question — how long
// until something is. An account comes back when every window that put it over
// the threshold has rolled over, so its own eta is the latest of those resets,
// and the pool's eta is the earliest of those.
//
// A window whose reset time has passed is counted as empty rather than at its
// cached value: the reading is stale by definition, and the account is usable
// again. An account with no reading at all is counted as available — unknown is
// somewhere the switcher can still go, unlike a known-full one.
function availableAccounts(payload) {
  const store = storeDir();
  let files;
  try {
    // Dot-prefixed files are the pool's own bookkeeping, not accounts.
    files = fs.readdirSync(store).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch (e) {
    return null; // pool not set up — say nothing rather than "0"
  }

  const cap = switchThreshold();
  const weeklyCap = weeklySwitchThreshold();
  const current = currentAccountEmail();
  const live = (payload && payload.rate_limits) || null;
  const now = Date.now();
  let free = 0;
  let total = 0; // every account saved in the pool, the one in use included
  let others = 0; // saved accounts that are not the one in use
  let eta = null; // ms until the first blocked account is usable again
  let etaEmail = null; // and which account that is
  let etaUnknown = false; // a blocked account whose wait has no length

  for (const file of files) {
    let acct;
    try {
      acct = JSON.parse(fs.readFileSync(path.join(store, file), 'utf8'));
    } catch (e) {
      continue;
    }
    const email = typeof acct.email === 'string' ? acct.email.toLowerCase() : null;
    const isCurrent = !!(email && current && email === current);
    total++;
    if (!isCurrent) others++;

    // The account in use has live numbers in the status payload; its snapshot on
    // disk is only refreshed when the switcher polls, so it can be hours old.
    const cache = isCurrent && live ? live : acct.usageCache;
    // Both windows, each against its own cap, exactly as the switcher decides.
    let full = false;
    let backAt = 0; // usable once the *last* window that blocks it has reset
    for (const [name, limit] of [['five_hour', cap], ['seven_day', weeklyCap]]) {
      const w = cache && cache[name];
      if (!w) continue;
      // Snapshots carry "utilization", the live payload "used_percentage".
      const pct = typeof w.utilization === 'number' ? w.utilization : w.used_percentage;
      if (typeof pct !== 'number') continue;
      const at = resetDate(w.resets_at);
      const resets = at ? at.getTime() : NaN;
      if (Number.isFinite(resets) && resets <= now) continue; // window already renewed
      if (!atCap(pct, limit)) continue;
      full = true;
      // A full window with no reset time is a wait of unknown length; it cannot
      // be timed, so the account drops out of the countdown entirely.
      if (!Number.isFinite(resets)) { backAt = Infinity; break; }
      if (resets > backAt) backAt = resets;
    }

    if (!full) { free++; continue; }
    // The countdown answers "where can I go next", so the account in use is not
    // in it: its own reset makes it usable again, not a place to switch to.
    if (isCurrent) continue;
    if (!Number.isFinite(backAt)) { etaUnknown = true; continue; }
    if (eta === null || backAt < eta) { eta = backAt; etaEmail = email; }
  }
  // The countdown is reported whenever a blocked account has a known reset, not
  // only when the pool is empty: with one seat free the next one coming back is
  // still what decides whether to keep working or wait for a fresh window.
  return {
    free,
    total,
    others,
    waitMs: eta === null ? null : eta - now,
    waitEmail: etaEmail,
    waitUnknown: eta === null && etaUnknown,
  };
}

// Coarse on purpose: this is a "come back later" number, not a stopwatch, and a
// digit that changes every second would pull the eye for nothing.
function humanWait(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return mins + 'm';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h' + String(mins % 60).padStart(2, '0');
  return Math.floor(hours / 24) + 'j' + String(hours % 24).padStart(2, '0');
}

// Which account is answering right now. The local part of the address is the
// only thing that differs between the accounts in the pool, and the domain
// would eat half the segment, so everything from "@" on is dropped. A long
// handle is cut rather than allowed to push the rest of the line off screen.
function shortLocal(email, max, ell) {
  if (!email) return null;
  // A caller passing 0 means "no room": that is a width decision, not a missing
  // argument, so it must not fall through to the default the way `max || 14`
  // would. The name is dropped whole rather than shaved to an initial.
  const cut = max == null ? 14 : max;
  if (cut <= 0) return null;
  return clip(email.split('@')[0], cut, ell || '…');
}

// Terminals count columns, not code units. Two things follow: slice() can cut a
// surrogate pair in half and print a replacement char instead of the emoji, and
// a CJK handle draws twice as wide as its length says, so a cut measured in
// code units overflows the pane it was supposed to fit. Both are handled by
// walking code points and charging the wide ranges double.
function charWidth(cp) {
  if (cp >= 0x300 && cp <= 0x36f) return 0; // combining marks sit on the previous cell
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f9ff) ? 2 : 1;
}

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

function clip(s, max, mark) {
  const str = String(s);
  if (displayWidth(str) <= max) return str;
  const room = max - displayWidth(mark);
  if (room <= 0) return mark.slice(0, max);
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > room) break;
    out += ch;
    w += cw;
  }
  return out + mark;
}

function accountLabel(max, ell) {
  return shortLocal(currentAccountEmail(), max, ell);
}

// The segment, as a list of parts a caller can join with its own separator.
// Read left to right it is one sentence — who is logged in, how many accounts
// are still reachable, and, when none are, when that changes.
//
// The arrow carries the armed state by colour alone (green watching, red not),
// because "off" is worth a word only when there is in fact a pool to switch in.
function accountSegments(payload, opts) {
  const o = opts || {};
  const { dim, bold, red, green, yellow, cyan } = makePainter(o.color !== false);
  const g = glyphs(o);
  const rooms = nameRooms(segmentBudget(o));
  const pool = availableAccounts(payload);
  const armed = autoSwitchOn();
  const who = accountLabel(rooms.who, g.cut);
  const out = [];

  const mark = armed ? green(g.arrow) : red(g.arrow);
  if (who) out.push(mark + ' ' + bold(cyan(who)));

  if (!pool) {
    out.push(dim(who ? 'no pool' : g.arrow + ' no pool'));
    return out;
  }
  // Nothing saved but the account in use: there is no switch to arm and no
  // countdown to run, so say that instead of a permanent "0 free".
  if (pool.others === 0) {
    out.push(dim('solo'));
    return out;
  }
  if (!who) out.push(mark);

  // Counted over the whole pool, the account in use included: it is the one the
  // session is on, and "2/3" has to add up to what /claude-account-list prints.
  const paint = pool.free === 0 ? red : pool.free === 1 ? yellow : green;
  let state = paint(pool.free + '/' + pool.total + ' free');
  // Next seat coming back, named: the wait belongs to one account, and reading
  // it next to the free count is the whole "where can I go" answer in one place.
  // Yellow while there is nowhere to go, dim once there is - same fact, but it
  // stops competing with the count for the eye when it is only a heads-up.
  if (pool.waitMs != null) {
    // Shorter than the current account's own label: this one is a hint, and it
    // sits at the end of an already long line.
    const target = shortLocal(pool.waitEmail, rooms.target, g.cut);
    const wait = g.wait + humanWait(pool.waitMs) + (target ? ' ' + target : '');
    state += ' ' + (pool.free === 0 ? yellow(wait) : dim(wait));
  } else if (pool.waitUnknown) {
    // A full window that never reported a reset time: the wait exists but has
    // no length, and inventing one would be worse than saying so.
    state += ' ' + dim(g.wait + '?');
  }
  out.push(state);

  if (!armed) out.push(red('auto off'));
  return out;
}

function accountSegment(payload, opts) {
  const { dim } = makePainter(!opts || opts.color !== false);
  return accountSegments(payload, opts).filter(Boolean).join(dim(glyphs(opts).sep));
}

module.exports = {
  accountSegment,
  accountSegments,
  availableAccounts,
  autoSwitchOn,
  clip,
  currentAccountEmail,
  displayWidth,
  glyphs,
  humanWait,
  segmentBudget,
  switchThreshold,
  weeklySwitchThreshold,
};

// ---------------------------------------------------------------- cli

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return ''; // no stdin — render what little we can
  }
}

// The command that was the status line before this one was installed. Kept in
// the account store rather than inline in settings.json so that uninstalling
// restores the original string exactly, quoting included.
function wrappedConfig() {
  const cfg = renderPrefs();
  return typeof cfg.command === 'string' && cfg.command.trim() ? cfg : null;
}

// Run the wrapped status line with the same payload and hand back its stdout
// unchanged. A crash, a timeout or a missing interpreter yields an empty string:
// this toolkit degrades to showing only its own segment rather than blanking a
// line it does not own.
function runWrapped(cfg, input) {
  try {
    const r = spawnSync(cfg.command, {
      shell: true,
      input,
      encoding: 'utf8',
      timeout: Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 3000,
      windowsHide: true,
    });
    return r && typeof r.stdout === 'string' ? r.stdout.replace(/\r?\n$/, '') : '';
  } catch (e) {
    return '';
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const wrap = args.indexOf('--wrap') !== -1;
  // Flags for a host that knows the pane it is drawing into and would rather
  // say so than export env vars for one command: --width 48, --ascii.
  const flag = (name) => {
    const hit = args.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
    if (!hit) return null;
    const eq = hit.indexOf('=');
    return eq === -1 ? (args[args.indexOf(hit) + 1] || '') : hit.slice(eq + 1);
  };
  const widthFlag = parseInt(flag('width') || '', 10);
  const cliOpts = {};
  if (Number.isFinite(widthFlag) && widthFlag > 0) cliOpts.width = widthFlag;
  const asciiFlag = flag('ascii');
  if (asciiFlag !== null) cliOpts.ascii = asciiFlag === '' || !OFF.has(asciiFlag.toLowerCase());
  const raw = readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw) || {};
  } catch (e) {
    payload = {}; // no stdin, or malformed
  }

  const muted = OFF.has(String(process.env.CLAUDE_CC_STATUSLINE || '').toLowerCase());
  const segment = muted ? '' : accountSegment(payload, cliOpts);

  let line = segment;
  if (wrap) {
    const cfg = wrappedConfig();
    const before = cfg ? runWrapped(cfg, raw) : '';
    const sep = (cfg && typeof cfg.separator === 'string') ? cfg.separator : glyphs(cliOpts).group;
    line = before && segment ? before + makePainter(true).dim(sep) + segment : before || segment;
  }
  if (line) process.stdout.write(line);
}
