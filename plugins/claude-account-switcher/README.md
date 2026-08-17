# Claude Account Switcher

Switch between multiple **Anthropic Claude** accounts (e.g. several Pro/Max
accounts you own). One install gives you **two switchers**:

- **Claude Code CLI** *(Windows · macOS · Linux)* — flip **Claude Code**
  (`claude`) between accounts. Project transcripts are shared across accounts,
  so you can hit a limit, switch, and carry on in the *same conversation*. Shows
  5h/7d usage **and reset times**, switches automatically when a limit is close,
  and on Windows can restart the running session in place.
- **Desktop app** *(Windows only)* — flip the **Claude desktop app** (claude.ai
  chats) between accounts, with a Desktop shortcut and a usage readout.

Neither app has a built-in account switcher — this adds both. **No npm required.**

| Feature | Windows | macOS | Linux |
|---|:---:|:---:|:---:|
| Claude Code CLI switching | ✅ | ✅ | ✅ |
| Automatic switch on rate limit | ✅ | ✅ | ✅ |
| Unattended switch the moment a limit expires | ✅ | — | — |
| Restart the running session in place | ✅ | — | — |
| Desktop app | ✅ | — | — |

---

## Quick start

**Windows** (PowerShell):

```powershell
# 1. Install (run once)
irm https://raw.githubusercontent.com/karthiknl0/claude-account-switcher/main/install.ps1 | iex
# 2. Open a NEW PowerShell window, then save each account (see "Add your accounts")
claude-code-add
# 3. Switch any time
claude-code-select -Next
```

**macOS / Linux** (Claude Code CLI only — requires [PowerShell](https://aka.ms/powershell)):

```bash
# 1. Install (run once)
pwsh -c "irm https://raw.githubusercontent.com/karthiknl0/claude-account-switcher/main/install.ps1 | iex"
# 2. Reload your shell (or open a new terminal), then save each account
source ~/.zshrc   # or ~/.bashrc on Linux
claude-code-add
# 3. Switch any time
claude-code-select -Next
```

> **Requires:** Windows for the desktop-app switcher and for the in-place
> restart. The Claude Code switcher itself also runs on macOS/Linux with
> [PowerShell](https://aka.ms/powershell) installed. On macOS the Claude Code
> login lives in the **Keychain**, so the first read/write may prompt you to
> *Allow* access.
>
> Run **`claude-code-doctor`** any time to check the setup — it prints the
> platform, credential backend, live login, the state of every saved account,
> and a list of anything that is missing.

### One command in front of the rest

Each tool below does one thing and prints a full report, which is right at a
prompt and wasteful for an agent that pays for every line it reads back.
`claude-cc` is the short way in, and answers in a few lines:

```powershell
claude-cc status       # accounts, quota, watcher, sessions - no API call
claude-cc status fresh # ...with a live usage reading instead of the recorded one
claude-cc list         # the full table
claude-cc switch next  # or: switch 2 | switch bob@x.com
claude-cc auto         # switch if the current account is out of quota
claude-cc refresh all  # restart every registered thread (this one last)
claude-cc renew        # keep the saved logins alive, no browser
claude-cc watch status # is the unattended switch armed
claude-cc statusline   # is the status-line segment installed (see below)
claude-cc fix          # repair whatever doctor would complain about
```

`status` exits 0 when everything is in place and 1 when it is not, listing what
to do; `fix` does all of it in one call — wrapper, snapshot encryption, watcher
task, `SessionStart` hook, and the leftovers. Exit codes from the tools
underneath are passed through, so `10` (switched) and `20` (all limited) still
mean what they mean.

Inside Claude Code the same thing is one slash command:
`/claude-account-list`, `/claude-account-switch`, `/claude-account-auto-switch`,
`/claude-account-add`, `/claude-account-remove`, `/refresh-t` (this thread) and
`/refresh-a` (all of them).

---

## Step 1 — Install

Open **PowerShell** and run:

```powershell
irm https://raw.githubusercontent.com/karthiknl0/claude-account-switcher/main/install.ps1 | iex
```

Every file is verified against the published `SHA256SUMS` before it is written,
and the install stops if anything does not match.

This installs:

- Scripts in `~/.claude-tools/`
- Claude Code commands: `claude-code-add`, `claude-code-list`,
  `claude-code-remove`, `claude-code-renew`, `claude-code-select`, `claude-code-auto`,
  `claude-code-pool`,
  `claude-code-watch`, `claude-code-refresh`, `claude-code-shim`,
  `claude-code-doctor`
  (`claude-code-switch` still works as a name for `claude-code-select`)
- Slash commands in `~/.claude/commands`: `/refresh-t`, `/refresh-a`
- Desktop-app commands: `claude-add-account`, `claude-switch-account`
- `claude-switch-update`
- Desktop shortcuts: **"Claude Code Accounts"**, **"Claude Switch Account"**,
  and launchers for `claude`, `claude --resume`, `claude --continue`

**Then open a new PowerShell window** so the commands load.

---

## Step 2 — Add your accounts

1. In Claude Code, `/login` as your first account.
2. Run `claude-code-add` and enter that account's email.
3. Answer **y** to "Add ANOTHER account?" — your login is cleared *locally*
   (you are **not** logged out on Anthropic's side), so the saved snapshot stays
   valid.
4. `/login` as the next account, run `claude-code-add` again. Repeat; answer
   **n** on the last one.

Non-interactive: `claude-code-add -Email you@example.com -Yes` saves the current
login and clears it, `-Clear` only clears.

Snapshots go to `~/.claude-cc-accounts/<email>.json`, encrypted with **DPAPI**
on Windows and readable only by your Windows user on that machine. Each one is
also registered in a signed manifest (see *Trust* below).

> ⚠️ **Never use "Log out" while adding accounts** and never copy or commit
> `~/.claude-cc-accounts` anywhere — it holds live logins.

---

## Step 3 — Switch

```powershell
claude-code-list                    # who is saved, usage, reset times, trust
claude-code-select -Next            # the account with the most 5h headroom
claude-code-select -Index 2         # by position in the list
claude-code-select -Email work      # by email, or any unambiguous fragment
claude-code-select -Next -DryRun    # say what would happen, change nothing
```

The list looks like this:

```
=== Claude Code accounts ===
  [1] * you@example.com     usable yes   5h  12% / 7d   8% used
        5h resets in 4h15m (21:49)   |   7d resets Sun Jun 7, 02:29
  [2]   work@example.com    usable no    5h  99% / 7d  31% used
        5h resets in 1h02m (18:36)   |   7d resets Fri Jun 5, 09:00
  (* = current   |   usable = the switcher accepts it: 5h < 99%, week < 99.8%)
```

`usable` is the switch decision itself, not a second opinion on the
percentages: `no` means `claude-code-auto` would skip that account right now,
either because a window is at its cap or because the snapshot is not trusted.
The two caps differ on purpose — a 5-hour window comes back within the day, so
switching at 99% costs almost nothing, while a weekly window takes days and is
therefore spent down to 99.8%.

Before overwriting anything, the switcher writes the **outgoing** account's live
credentials back into its own snapshot — Claude Code rotates its refresh token,
so a stale snapshot would eventually log that account out — and keeps a copy in
`~/.claude-cc-accounts/.backups`.

### Why a saved account never has to `/login` again

A login is an OAuth pair: an access token good for hours, and a refresh token
that buys the next pair. The refresh token is **rotated on every use** and the
server retires the previous one immediately, so a saved snapshot decays on its
own — nobody has to touch it. Two things keep the pool alive:

- **Sync-back**, on every switch, on every session start, and on every watcher
  tick: whenever the live login rotates, the snapshot of that account is
  rewritten with the current pair. This covers the session that keeps running on
  the old account for a few minutes after a switch, which is what used to
  orphan a snapshot.
- **`claude-code-renew`**, hourly from the watcher, for the accounts that are
  *not* logged in: it spends their stored refresh token itself and writes the
  new pair back, so an account can sit in the pool for weeks and still be
  switchable without a browser.

```powershell
claude-code-renew            # whatever is close to expiring
claude-code-renew -Force     # every account
claude-code-renew -DryRun    # say what would happen, call nothing
```

Exit `1` means an account's refresh token is genuinely spent (it was rotated
somewhere this machine cannot see) and that one does need `/login` followed by
`claude-code-add`. Exit `2` is the token endpoint rate-limiting the caller —
nothing was spent, and the watcher backs off for three hours.

**A running `claude` process cannot pick up the new account by itself.** It read
its credentials once at startup and holds the access token in memory. Either
start a new session (`claude --resume`), or use the in-place restart below.

### Restarting the session in place (Windows)

```powershell
claude-code-shim -Install     # once; then restart your terminal app once
claude-code-select -Next -Relaunch
```

`claude-code-shim` puts a small wrapper called `claude.exe` in front of your
PATH. Whatever starts your session then starts the wrapper, and the real Claude
Code is its child. When `-Relaunch` ends that child, the wrapper starts Claude
Code again **in the same terminal, on the same conversation**, and the fresh
process reads the credentials that were just swapped. Without a marker file the
wrapper only forwards the exit code, so every other `claude` call behaves
exactly as before.

`claude-code-shim -Status` shows what is in place, `-Uninstall` removes it, and
`-RealBin <path>` pins which `claude.exe` the wrapper runs if detection picks
the wrong one.

### Switching automatically on a rate limit

```powershell
claude-code-auto -DryRun      # what it would do right now
claude-code-auto              # switch if the current account is close to its limit
claude-code-auto -Relaunch    # …and restart the session on the new account
```

It only moves when the current account is actually near a limit and another
saved account has real headroom; otherwise it prints one line and exits.

### Switching by itself, the moment a limit expires

`claude-code-auto` answers the question once, when something calls it. Nothing
calls it when a quota comes back at 23:39 — and a session that is already rate
limited cannot even fire a hook, because you cannot send anything. So the
watcher runs beside your sessions instead:

```powershell
claude-code-watch -Install    # runs at logon, ticks every 10 s, checked every 15 min
claude-code-watch -Status     # is it running, what does it see, when did it last switch
claude-code-watch -Stop       # ask it to exit
```

The watcher checks the clock every 10 seconds but only queries the accounts when
something can actually have changed:

- every account limited → it looks again just after the earliest reset time,
  read from the usage each snapshot already recorded;
- the current account close to a threshold → every two minutes;
- plenty of headroom → the wait grows with the room left, up to 15 minutes. An
  account at 40% cannot reach 99% before the next look.

The scheduled task carries two triggers: one at logon, and one every 15 minutes
so a watcher that died between two logons is replaced without waiting for the
next one. The repeated start costs nothing while a watcher is alive — the task
instance is still running, so the scheduler drops the new one, and a watcher
started any other way exits on the `Global\ClaudeCodeAccountWatch` mutex.

After a switch it holds for ten minutes (`-CooldownSeconds`) before considering
another one, and restarts at most eight sessions (`-MaxRestarts`): every switch
restarts every registered session, and each of those comes back with a turn of
its own — two switches a minute apart would spend the account they just moved to
on nothing but restarts.

Restarting a session needs its pid and session id, which Claude Code only
exports inside that session. So each session records itself in
`~/.claude-cc-accounts/.threads.state` through a `SessionStart` hook.
`claude-code-watch -Install` adds it to `~/.claude/settings.json` for you,
keeping every other hook (`-InstallHook` does only that part):

```json
"SessionStart": [
  { "hooks": [ { "type": "command",
      "command": "pwsh -NoProfile -File \"C:/Users/<you>/.claude-tools/claude-code-hook.ps1\"",
      "timeout": 20 } ] }
]
```

That hook also starts the watcher if nothing is watching, so opening any session
is enough to get it back. Entries whose process is gone are dropped on the next
read, and a recycled pid is rejected by comparing the process start time — both
when the registry is read and again before anything is ended.

When a switch happens, every registered session is restarted through the wrapper
— same panes, same conversations, new account — a fraction of a second apart so
they do not all come back in the same instant.

### The switcher in the status line (optional)

One line under the prompt, saying which account is answering, how many of the
saved ones the switcher could still move to, and — when none are — how long
until one comes back:

```
⇄ alaric · 2/3 free ⏳4h20 pierre
```

The arrow is green while the switch is armed and red when it is not. The counts
are the ones `claude-code-list` prints, read from the snapshots on disk: no API
call, no `pwsh` process, nothing that slows a render down.

The `⏳` timer is the wait until the next account comes back, and the handle
after it is the account that will come back first — the one the switcher would
move to. It counts the soonest of the five-hour and seven-day windows of every
saved account other than the one currently answering, so it never promises a
switch to the account you are already on. `⏳?` means an account is over its
limit but its snapshot carries no reset time yet; the timer disappears entirely
once at least one account is free again.

```powershell
claude-cc statusline            # what is configured right now
claude-cc statusline install    # add the segment
claude-cc statusline uninstall  # put back exactly what was there before
claude-cc statusline render     # print it once, without installing anything
```

Installing never replaces a status line. If `statusLine` is already set in
`~/.claude/settings.json` — your own script, another tool's, anything — that
command is stored in `~/.claude-cc-accounts/.statusline.json`, keeps running
with the same payload on stdin, and its output is printed first, untouched, with
the segment appended after it. If no status line is set, the segment becomes the
whole line. `uninstall` restores the stored command string byte for byte.

`CLAUDE_CC_STATUSLINE=0` hides the segment while leaving a wrapped line alone.
A hand-written status line can also place the segment itself:

```js
const cc = require(require('os').homedir() + '/.claude-tools/claude-cc-statusline.js');
const parts = cc.accountSegments(payload); // ['⇄ alaric', '2/3 free']
```

#### Split panes, narrow terminals, no Unicode

Claude Code's status-line payload does not carry a terminal width, and the
segment is rendered into a pipe, so nothing in the render path can measure the
pane on its own. Tell it, and it narrows instead of overflowing: the handles
shorten first, then the account name after the timer is dropped, then the
current handle, and the counts and the timer — the part that actually decides
whether you switch — are the last thing to go. Multi-agent terminals that run
several sessions in split panes ([Boite](https://github.com/beboite/boite) and
the like) are the case this exists for.

```powershell
$env:COLUMNS = 60                     # or CLAUDE_CC_STATUSLINE_WIDTH, which wins
$env:CLAUDE_CC_STATUSLINE_ASCII = 1   # <> and ~ instead of ⇄ and ⏳, | as separator
```

```js
cc.accountSegments(payload, { width: 48, ascii: true });
```

```
claude-cc-statusline.js --width 48 --ascii   # the same two knobs on the CLI
```

A host that cannot set environment variables per pane can put the same two
settings in `~/.claude-cc-accounts/.statusline.json`, next to the wrapped
command: `{"width": 60, "ascii": true}`. Explicit arguments win over the
environment, which wins over that file. With none of them set the segment is
rendered at full width, exactly as before.

ASCII is also picked automatically under `TERM=dumb` or a non-UTF-8 locale, and
colour already follows `NO_COLOR` and `TERM=dumb`. The other environment
variables the segment reads: `CLAUDE_CC_ACCOUNTS` for the pool directory,
`CLAUDE_AUTOSWITCH_THRESHOLD` and `CLAUDE_AUTOSWITCH_WEEKLY_THRESHOLD` for the
percentages at which an account counts as spent.

### Refreshing threads by hand

The same restart, without waiting for a limit — useful after editing an MCP
config, or upgrading Claude Code:

```powershell
claude-code-refresh            # this thread
claude-code-refresh -All       # every registered session, this one last
claude-code-refresh -List      # what would be refreshed
claude-code-refresh -All -Idle # come back and wait instead of continuing the work
```

Inside Claude Code the same two moves are `/refresh-t` (this thread) and
`/refresh-a` (all of them). Neither closes or restarts the terminal app around
them: only the `claude` processes are ended, and the wrapper brings each one
back in its own pane.

---

## Trust

A snapshot is a login. Anything that can drop a file into
`~/.claude-cc-accounts` could otherwise make the switcher log you into an
account someone else controls, and a relaunch marker is a command line that gets
run. So both are signed.

- `~/.claude-cc-accounts/.pool.key` is a random key, DPAPI-encrypted for your
  Windows user. It is created on the first `claude-code-add`.
- `.pool.json` records, for each snapshot, an HMAC over its filename, email,
  account id and a hash of its credentials.
- Every switch checks that record and reports **trusted**, **unknown** (never
  registered), **changed** (edited since) or **nokey** (no key yet).

```powershell
claude-code-pool -Status      # per-account verdicts
claude-code-pool -Adopt       # trust what is on disk right now
claude-code-pool -Protect     # re-encrypt plain-text snapshots and re-register
```

An untrusted account is skipped rather than used. `-AllowUntrusted` on
`claude-code-select` / `claude-code-auto` overrides that for one run, once you
know why the verdict changed.

Relaunch markers carry an HMAC sidecar signed with the same key; the wrapper
refuses any marker it cannot verify and notes the refusal in
`~/.claude-cc-accounts/relaunch.log`. Deleting the key does not open that door
either: once a pool exists, a wrapper that cannot find its key refuses every
marker instead of falling back to unsigned ones.

`.threads.state` — which process gets ended and which conversation it comes back
on — is locked to your user like the snapshots are.

---

## Switching the desktop app (Windows)

The Claude desktop app is an Electron app — the login is a **browser session**
(cookies + Local Storage + IndexedDB), not a token file, so the switcher works
at session level.

1. Log into your first account in the app.
2. Run `claude-add-account`, enter its email. Claude briefly closes and reopens.
3. Answer **y** to "Add ANOTHER account now?" — the app reopens at a fresh
   sign-in screen and your first account is *not* logged out.
4. Sign in as the next account, run `claude-add-account` again. Answer **n** on
   the last.

Then double-click **"Claude Switch Account"** on the Desktop, or run
`claude-switch-account` in a standalone PowerShell window, and pick a number.

- `claude-add-account` snapshots the complete app profile into
  `~/.claude-accounts/<email>/profile/`.
- `claude-switch-account` closes Claude, backs the current profile up to
  `~/.claude-accounts/.backup-<timestamp>/`, restores the chosen one, restarts.

> ⚠️ Run it from a standalone window, **not** from inside a Claude session —
> switching force-closes the desktop app.
>
> **Do NOT use the app's "Log out" while adding accounts.** That revokes the
> session on Anthropic's servers and kills the saved snapshot;
> `claude-add-account` clears the *local* login for you instead.

---

## Updating

```powershell
claude-switch-update
```

Pulls the latest version (re-running the install one-liner does the same). After
an update, run `claude-code-shim -Install` once if you use the in-place restart,
so the wrapper is rebuilt from the new source.

---

## Uninstall

```powershell
irm https://raw.githubusercontent.com/karthiknl0/claude-account-switcher/main/uninstall.ps1 | iex
```

Removes the scripts, the shortcuts, the wrapper and its PATH entry, and the
managed block from your PowerShell profiles. Your saved accounts are left alone;
remove them yourself if you want:

```powershell
Remove-Item -Recurse -Force ~/.claude-cc-accounts   # Claude Code
Remove-Item -Recurse -Force ~/.claude-accounts      # desktop app
```

---

## Notes & caveats

- **Use only accounts you own.** This is for moving between your own accounts,
  not for sharing accounts or evading limits.
- **Saved logins are machine-bound.** They are encrypted with a Windows (DPAPI)
  key tied to your user account, so a snapshot only works on the Windows user
  and machine it was taken on. Never copy those folders elsewhere, and never
  commit them.
- **Switching the desktop app closes it.** The app must fully quit so its
  session files unlock; the switcher waits, then reopens it.
- **Usage readouts** need no Node or other dependency. An account whose saved
  token has expired shows `usage n/a` until you next switch to it.
- **Sign-in can still be required by Claude.** A server-side session expiry,
  security check, or organization policy cannot be bypassed locally. This tool
  keeps accounts from mixing; it does not override Anthropic's authentication
  rules.
- If a desktop switch ever leaves Claude in a strange state, the previous
  session is in `~/.claude-accounts/.backup-<timestamp>/`.

## License

MIT — see [LICENSE](LICENSE).
