#!/usr/bin/env node

// The Claude Code status line: which account is in use, how much of its quota
// is gone, and how many saved accounts still have room.
//
// Claude Code hands this process a JSON payload on stdin and prints whatever
// single line comes back. It runs on every repaint, so it never asks the
// network: the live window comes from the payload, and everything about the
// other accounts comes from the cache the switcher already wrote.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FIVE_HOUR_CAP = 99;
const SEVEN_DAY_CAP = 99.8;

const OFF = new Set(['0', 'false', 'off', 'no']);
const ASCII = (() => {
  const flag = process.env.CLAUDE_CC_STATUSLINE_ASCII;
  if (flag) return !OFF.has(flag.toLowerCase());
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG;
  return !!locale && !/utf-?8/i.test(locale);
})();
const SEP = ASCII ? ' | ' : ' · ';

function storeDir() {
  return process.env.CLAUDE_CC_ACCOUNTS || path.join(os.homedir(), '.claude-cc-accounts');
}

function codexStoreDir() {
  return process.env.CODEX_CC_ACCOUNTS || path.join(os.homedir(), '.codex-cc-accounts');
}

/**
 * Which pools a SessionStart hook keeps switched, as a word, or null when none
 * does. `auto` only ever runs when something calls it, so the hook that calls it
 * is the whole answer to "is this armed, and for what".
 */
function autoScope() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const found = new Set();
  for (const name of ['settings.json', 'settings.local.json']) {
    const settings = readJson(path.join(dir, name));
    const groups = settings && settings.hooks && settings.hooks.SessionStart;
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of (group && group.hooks) || []) {
        const command = hook && hook.command;
        if (typeof command !== 'string') continue;
        // A shell may leave its own quote between the script and the word.
        if (!/claude-cc(\.ps1)?["']?\s+auto\b/.test(command)) continue;
        const provider = /-Provider\s+([A-Za-z]+)/.exec(command);
        found.add(provider ? provider[1].toLowerCase() : 'claude');
      }
    }
  }
  if (!found.size) return null;
  // One hook over everything beats naming the pools one by one; two separate
  // hooks read as what they are.
  return found.has('all') ? 'all' : Array.from(found).sort().join('+');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The account the CLI is logged in as, lowercased, or null. */
function liveEmail() {
  const config = readJson(path.join(os.homedir(), '.claude.json'));
  const email = config && config.oauthAccount && config.oauthAccount.emailAddress;
  return typeof email === 'string' ? email.toLowerCase() : null;
}

/** One window as a percentage, from either the payload's shape or the cache's. */
function percent(window) {
  if (!window) return null;
  const value = typeof window.utilization === 'number' ? window.utilization : window.used_percent;
  return typeof value === 'number' ? value : null;
}

function resetsAt(window) {
  if (!window || !window.resets_at) return null;
  const at = new Date(window.resets_at);
  return Number.isNaN(at.getTime()) ? null : at;
}

function capped(usage) {
  const five = percent(usage && usage.five_hour);
  const seven = percent(usage && usage.seven_day);
  if (five !== null && five >= FIVE_HOUR_CAP) return true;
  if (seven !== null && seven >= SEVEN_DAY_CAP) return true;
  return false;
}

function format(value) {
  if (value === null) return '?';
  return value > 99 && value < 100 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

function waitFor(at) {
  const ms = at.getTime() - Date.now();
  if (ms <= 0) return 'now';
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`;
}

/** One pool, as {email, usage} pairs. A missing pool is not an empty one. */
function pool(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return null;
  }
  const out = [];
  for (const name of names) {
    const snapshot = readJson(path.join(dir, name));
    if (!snapshot) continue;
    out.push({
      email: typeof snapshot.email === 'string' ? snapshot.email.toLowerCase() : null,
      usage: snapshot.usageCache || null,
    });
  }
  return out;
}

function build(payload) {
  const parts = [];
  const current = liveEmail();
  if (current) parts.push(current.split('@')[0]);

  // The live window beats the cache for the account in use: the payload was
  // written by the session this line is being drawn for.
  const live = (payload && payload.rate_limits) || null;
  const accounts = pool(storeDir());
  const mine = accounts && current ? accounts.find((a) => a.email === current) : null;
  const usage = live || (mine && mine.usage) || null;

  if (usage) {
    parts.push(`5h ${format(percent(usage.five_hour))} / 7d ${format(percent(usage.seven_day))}`);
    if (capped(usage)) {
      const at = resetsAt(usage.five_hour) || resetsAt(usage.seven_day);
      parts.push(at ? `back in ${waitFor(at)}` : 'capped');
    }
  }

  if (accounts && accounts.length > 1) {
    const free = accounts.filter((a) => a.email !== current && !capped(a.usage)).length;
    parts.push(`${free} free`);
  }

  // Codex has no status line of its own, and its pool is switched from the same
  // place, so what is left there is worth one word here.
  const codex = pool(codexStoreDir());
  if (codex && codex.length) {
    parts.push(`codex ${codex.filter((a) => !capped(a.usage)).length} free`);
  }

  // Last, because it is about the next session rather than this one. Silent
  // when nothing arms the switch: a line that says "off" on every machine that
  // never wanted it is noise.
  const scope = autoScope();
  if (scope) parts.push(`auto ${scope}`);

  return parts.join(SEP);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  let payload = null;
  try {
    payload = JSON.parse(stdin);
  } catch {
    // Run by hand, or handed something unexpected: the pool still has answers.
  }
  const line = build(payload);
  if (line) process.stdout.write(line);
});
