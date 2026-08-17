# Restart the Claude Code process of this thread, on the same conversation, so
# it picks up credentials that were just swapped underneath it.
#
# A running Claude Code process reads its credentials once at startup and keeps
# the access token in memory, so the only way to continue the same conversation
# as another account is a fresh process on the same session id.
#
# Inside Boite the app owns the terminal: it starts `claude` itself in a ConPTY
# and, measured twice, never starts it again when that process dies. Reloading
# the window does not bring it back either, and Boite's local API is signed and
# exposes no restart. The only thing Boite itself does is `thread_move`, which
# restarts the terminal but moves the thread to another project.
#
# So the restart is done one level below the app, by a wrapper: with
# `~/.claude-tools/shim` in front of `~/.local/bin` on PATH, the process Boite
# spawns is the wrapper and Claude Code is its child. This script drops a marker
# file named after the child's pid, then ends the child; the wrapper sees the
# marker and starts Claude Code again in the very same terminal - same pane,
# same conversation, new credentials. The app is never touched.
#
# The marker carries the command line to come back on: the one the dying process
# was started with, minus the prompt it was opened on, plus `--resume` if it was
# missing, plus a prompt of its own so the thread does not come back and wait.
# Resuming only restores the conversation - whatever the thread was asked to do
# when it was ended would stay unanswered - so the new process is handed
# "Continue from where you left off." as its first turn. -NoContinue leaves the
# thread idle instead, and -ContinueMessage says something else.
#
# Exit codes: 0 = refresh scheduled, 1 = not running under Boite (the caller
# should open a window instead), 2 = the Claude Code process was not found,
# 3 = the wrapper is not in front of this process, so ending it would just stop
# the thread (the caller should say so instead of killing anything).

param(
    [double]$Delay = 0,     # extra seconds before the process is ended; fractions are honoured.
                            # 0 means as soon as the watchdog is up, about 0.8 s away:
                            # starting the detached process is what the wait is made of.
    [int]$Wait  = 12,       # seconds to wait for the thread to come back before logging a failure
    [string]$SessionId = $env:CLAUDE_CODE_SESSION_ID,
    [switch]$NoContinue,    # come back on the conversation without picking the work up again
    # Said by nobody: it arrives as a user turn, so it names itself as the
    # restart's own doing rather than reading as something the user typed.
    [string]$ContinueMessage = '[auto-resume] This thread was restarted on the same conversation to pick up a new account. Nobody typed this - continue from where you left off.',
    [switch]$AnyHost,      # act even when the Boite environment is not visible
    # The process to restart, when the caller is not running inside it. A
    # watcher started from a scheduled task has neither CLAUDE_PID nor the
    # session's parent chain, so it passes both this and -SessionId from the
    # thread registry.
    [int]$VictimPid = 0,
    # When the pid comes out of the registry, the moment that process started is
    # recorded next to it. Pids are reused, and a name check alone would let a
    # stale entry end a different Claude Code session - on someone else's
    # conversation, since -SessionId comes from the same entry.
    [string]$VictimStartedAt = ''
)

if (-not $env:BOITE_THREAD_ID -and -not $AnyHost -and -not $VictimPid) { exit 1 }

# The marker is a command line the wrapper runs, so it is signed with the pool
# key: anything that can write into the marker folder could otherwise choose
# what this terminal restarts as.
$poolLib = Join-Path $PSScriptRoot 'claude-cc-pool.ps1'
if (Test-Path $poolLib) { . $poolLib }

# Claude Code exports its own pid to everything it runs; the parent chain is
# only the fallback for shells that were not started by it.
function Get-HostSessionPid {
    if ($env:CLAUDE_PID) {
        $p = Get-Process -Id ([int]$env:CLAUDE_PID) -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -match '^claude') { return $p.Id }
    }
    $walk = $PID
    for ($i = 0; $i -lt 8 -and $walk; $i++) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId = $walk" -ErrorAction SilentlyContinue
        if (-not $p) { return $null }
        if ($p.Name -match '^claude') { return [int]$p.ProcessId }
        $walk = $p.ParentProcessId
    }
    return $null
}

if ($VictimPid) {
    # Named from outside, so it is checked rather than trusted: a stale registry
    # entry whose pid has been recycled would otherwise end an unrelated program.
    $named = Get-Process -Id $VictimPid -ErrorAction SilentlyContinue
    $victim = if ($named -and $named.ProcessName -match '^claude') { $named.Id } else { $null }
    if ($victim -and $VictimStartedAt) {
        try {
            $recorded = [datetime]::Parse($VictimStartedAt, [Globalization.CultureInfo]::InvariantCulture)
            if ([Math]::Abs(($named.StartTime - $recorded).TotalSeconds) -gt 2) { $victim = $null }
        } catch { $victim = $null }
    }
} else {
    $victim = Get-HostSessionPid
}
if (-not $victim) { exit 2 }

$proc = Get-CimInstance Win32_Process -Filter "ProcessId = $victim" -ErrorAction SilentlyContinue
if (-not $proc) { exit 2 }

# The wrapper has to be the parent, otherwise nothing would start the thread
# again and the kill would only cost the user their terminal.
$shimExe = Join-Path (Join-Path $HOME '.claude-tools') 'shim\claude.exe'
$parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)" -ErrorAction SilentlyContinue
if (-not $parent -or -not $parent.ExecutablePath -or
    $parent.ExecutablePath -ne (Resolve-Path -LiteralPath $shimExe -ErrorAction SilentlyContinue).Path) {
    exit 3
}

# The command line to come back on. Taken from the dying process so the MCP
# config and every other flag Boite passed are kept as they were, quoting
# included - rebuilding them by hand would break on paths with spaces.
function Get-RelaunchArguments($commandLine, $sessionId, $continueMessage) {
    $line = $commandLine
    # Drop the executable itself, quoted or not.
    if ($line.StartsWith('"')) {
        $end = $line.IndexOf('"', 1)
        $line = if ($end -ge 0) { $line.Substring($end + 1) } else { '' }
    } else {
        $sp = $line.IndexOf(' ')
        $line = if ($sp -ge 0) { $line.Substring($sp) } else { '' }
    }
    $line = $line.Trim()
    # Drop the opening prompt: it was said once already, and Boite would have
    # the restarted thread answer it a second time.
    # Cut at the separator itself, not at ' -- ': a command line ending on a
    # bare `--` has no trailing space, IndexOf(' -- ') returns -1, and the
    # Substring(0, 0) that followed threw every flag away - the thread came back
    # with no --resume and no MCP config.
    $sep = [regex]::Match($line, '(^|\s)--(\s|$)')
    if ($sep.Success) { $line = $line.Substring(0, $sep.Index).Trim() }
    if ($line -notmatch '(^|\s)(--resume|-r)(\s|$)' -and $sessionId) {
        $line = ("--resume {0} {1}" -f $sessionId, $line).Trim()
    }
    # Resuming alone brings the conversation back and then waits: the request the
    # thread was working on when it was ended would sit there unanswered. A
    # prompt after `--` is what Claude Code takes as the first turn of the
    # resumed session, so the work carries on by itself.
    if ($continueMessage) {
        $quoted = '"' + ($continueMessage -replace '"', '\"') + '"'
        $line = ("{0} -- {1}" -f $line, $quoted).Trim()
    }
    return $line
}

$markerDir = Get-CcMarkerDir
New-Item -ItemType Directory -Force -Path $markerDir | Out-Null
# Markers left behind by a kill that never happened would restart a thread the
# user closed on purpose; a day is far longer than the few seconds one lives.
Get-ChildItem -LiteralPath $markerDir -Filter 'relaunch-*' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
# And signatures whose marker is already gone, which the sweep above never
# matches once the marker it belonged to has been consumed.
Clear-CcOrphanMarkerSigs | Out-Null

$marker = Join-Path $markerDir ("relaunch-{0}" -f $victim)
$continueWith = if ($NoContinue) { $null } else { $ContinueMessage }
# NOT $args: that name is PowerShell's own automatic variable.
$relaunchArgs = Get-RelaunchArguments $proc.CommandLine $SessionId $continueWith
if (Get-Command Write-SignedMarker -ErrorAction SilentlyContinue) {
    Write-SignedMarker $marker $relaunchArgs | Out-Null
} else {
    [System.IO.File]::WriteAllText($marker, $relaunchArgs, (New-Object System.Text.UTF8Encoding($false)))
}

$log    = Join-Path (Join-Path $HOME '.claude-cc-accounts') 'relaunch.log'
# Every refresh adds a few lines and nothing ever removed one.
if (Get-Command Limit-CcLog -ErrorAction SilentlyContinue) { Limit-CcLog $log 400 }
# A refresh that never came back leaves the thread dead and the user staring at
# an empty pane; the flag is what makes the next switcher run say so out loud
# instead of leaving the answer in a log file nobody opens.
$failed = Join-Path (Join-Path $HOME '.claude-cc-accounts') '.last-relaunch-failed'

# The kill has to happen from another process: run from here it would cut this
# session off mid-sentence and swallow whatever the agent was still writing.
# The same detached process then plays watchdog - it is the only thing left
# alive that can tell whether the wrapper actually brought the thread back.
$watchdog = @'
$victim = {0}; $delayMs = {1}; $wait = {2}; $log = '{3}'; $marker = '{4}'; $failed = '{5}'
function Note($m) {{ try {{ Add-Content -LiteralPath $log -Value ("{{0:s}} {{1}}" -f (Get-Date), $m) }} catch {{}} }}
Note "watchdog up (pid $PID, victim $victim, delay $delayMs ms)"
$before = @(Get-Process claude -ErrorAction SilentlyContinue | ForEach-Object {{ $_.Id }})
if ($delayMs -gt 0) {{ Start-Sleep -Milliseconds $delayMs }}
Stop-Process -Id $victim -Force -ErrorAction SilentlyContinue
Note "ended $victim, waiting for the wrapper to start it again"
$deadline = (Get-Date).AddSeconds($wait)
while ((Get-Date) -lt $deadline) {{
    Start-Sleep -Milliseconds 500
    $now = @(Get-Process claude -ErrorAction SilentlyContinue | ForEach-Object {{ $_.Id }})
    $new = @($now | Where-Object {{ $_ -ne $victim -and $before -notcontains $_ }})
    if ($new.Count) {{
        Note "thread back as $($new -join ', ')"
        Remove-Item -LiteralPath $failed -Force -ErrorAction SilentlyContinue
        return
    }}
}}
# Nothing came back: leave no marker behind to fire on some later pid, and drop
# a flag the next switcher run can read out loud.
Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$marker.sig" -Force -ErrorAction SilentlyContinue
try {{ Set-Content -LiteralPath $failed -Value ("{{0:s}} the thread (pid {{1}}) was ended but never came back - the claude wrapper did not restart it" -f (Get-Date), $victim) }} catch {{}}
Note "thread did not come back within $wait s (wrapper missing or refused)"
'@ -f $victim, ([int][Math]::Round($Delay * 1000)), $Wait, ($log -replace "'", "''"), ($marker -replace "'", "''"), ($failed -replace "'", "''")

# Handed over as a file, not as -Command: a multi-line script passed on the
# command line loses its newlines on the way through Start-Process.
$wdFile = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-relaunch-{0}.ps1" -f $victim)
# The cleanup goes first: PowerShell has the whole file in memory by then, and
# the body ends on `return`, which would skip anything appended after it.
[System.IO.File]::WriteAllText($wdFile,
    ("Remove-Item -LiteralPath `$PSCommandPath -Force -ErrorAction SilentlyContinue`n" + $watchdog),
    (New-Object System.Text.UTF8Encoding($false)))

# Detached on purpose: a process started the ordinary way inherits whatever job
# object Boite put this terminal in, and would be taken down with the session it
# is supposed to outlive. Created hidden as well - a refresh is not a reason to
# throw a console window over whatever the user is looking at.
$pwsh = (Get-Process -Id $PID).Path
if (-not $pwsh) { $pwsh = 'pwsh.exe' }
$wdArgs = '-NoProfile -WindowStyle Hidden -File "{0}"' -f $wdFile
if (Get-Command Start-CcDetached -ErrorAction SilentlyContinue) {
    Start-CcDetached $pwsh $wdArgs | Out-Null
} else {
    # An older claude-cc-common.ps1 next to this script: worth a flashing window,
    # not worth a refresh that never happens.
    Start-Process $pwsh -WindowStyle Hidden -ArgumentList @('-NoProfile', '-File', $wdFile) | Out-Null
}
exit 0
