# What a Claude Code session runs when it starts, so the account tooling knows
# it exists.
#
# Two things happen here:
#   1. the session records its pid and session id in the thread registry, which
#      is the only way a watcher outside the session can restart it;
#   2. the watcher is started if nothing is watching yet.
#
# Meant for a SessionStart hook in ~/.claude/settings.json:
#
#   "SessionStart": [ { "hooks": [ { "type": "command",
#       "command": "pwsh -NoProfile -File \"C:/Users/<you>/.claude-tools/claude-code-hook.ps1\"",
#       "timeout": 15 } ] } ]
#
# It prints nothing on success: a hook that talks shows up in every session.

[CmdletBinding()]
param(
    [switch]$NoWatcher,     # register only; do not start the watcher
    [switch]$Verbose_       # say what happened (the automatic -Verbose is taken)
)

$ErrorActionPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')
. (Join-Path $PSScriptRoot 'claude-cc-threads.ps1')

$ok = Register-CcThread
if ($Verbose_) {
    if ($ok) { Write-Host "registered session $env:CLAUDE_CODE_SESSION_ID (pid $env:CLAUDE_PID)" -ForegroundColor DarkGray }
    else { Write-Host "not registered: CLAUDE_PID / CLAUDE_CODE_SESSION_ID are not set here" -ForegroundColor Yellow }
}

# A session that starts has just read - and often just renewed - the login, so
# this is the cheapest moment to put the current token back in the pool. Without
# it the saved copy points at a refresh token the server has already retired,
# and coming back to that account needs a browser /login.
$poolLib = Join-Path $PSScriptRoot 'claude-cc-pool.ps1'
if (Test-Path $poolLib) { . $poolLib }
$synced = Sync-CcLiveSnapshot
if ($Verbose_ -and $synced) {
    Write-Host "refreshed the saved login for $($synced.Email)" -ForegroundColor DarkGray
}

if ($NoWatcher) { exit 0 }

# Already watching? The pid file is written by another process and can be empty
# or stale, so it is read defensively and the process behind it is checked.
$pidFile = Join-Path $CcStore '.watch.pid'
if (Get-CcPidFileProcess $pidFile '^(pwsh|powershell)$') {
    if ($Verbose_) { Write-Host "watcher already running" -ForegroundColor DarkGray }
    exit 0
}

$watch = Join-Path $PSScriptRoot 'claude-code-watch.ps1'
if (-not (Test-Path $watch)) { exit 0 }

# Start-CcDetached, like the relaunch watchdog: a process started the ordinary
# way inherits the job object the terminal is in and dies with the session it is
# supposed to outlive, and it is created with SW_HIDE so no console window
# flashes up in front of whatever the user is doing when a session starts.
$pwshPath = (Get-Process -Id $PID).Path
if (-not $pwshPath) { $pwshPath = 'pwsh.exe' }
$argLine = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -Quiet' -f $watch
$watcherPid = Start-CcDetached $pwshPath $argLine
$started = ($watcherPid -gt 0)
if ($Verbose_) {
    if ($started) { Write-Host "watcher started (pid $watcherPid)" -ForegroundColor DarkGray }
    else { Write-Host "watcher could not be started" -ForegroundColor Yellow }
}

# The scheduler is the last resort: a process started the ordinary way from here
# joins the job object the terminal is in and is killed with the thread it was
# started from - which is how a watcher kept disappearing a few minutes after
# the session that spawned it went away. The task has no such parent.
if (-not $started) {
    try {
        $task = Get-ScheduledTask -TaskName 'ClaudeCodeAccountWatch' -ErrorAction SilentlyContinue
        if ($task) {
            Start-ScheduledTask -TaskName 'ClaudeCodeAccountWatch' -ErrorAction Stop
            $started = $true
            if ($Verbose_) { Write-Host "watcher started through the scheduled task" -ForegroundColor DarkGray }
        }
    } catch { $started = $false }
}
if (-not $started -and $Verbose_) {
    Write-Host "watcher not started - run 'claude-code-watch -Install'" -ForegroundColor Yellow
}
exit 0
