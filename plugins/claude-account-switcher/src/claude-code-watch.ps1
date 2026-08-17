# Watch the saved accounts and switch the moment one of them is out of its
# rate limit again.
#
# claude-code-auto.ps1 answers "is the current account limited, and is another
# one free" once, when something calls it. Nothing calls it when a quota expires
# at 23:39 - and a session that is rate limited cannot even fire a hook, because
# the user cannot send anything. So this runs beside the sessions instead, ticks
# every few seconds, and calls the switcher itself.
#
# What it restarts comes out of the thread registry (claude-cc-threads.ps1):
# CLAUDE_PID and CLAUDE_CODE_SESSION_ID exist only inside a session, so a
# watcher started from a scheduled task has to be told which processes to bring
# back. Every session records itself there when it starts.
#
# Usage:
#   claude-code-watch.ps1                 run in the foreground until Ctrl-C
#   claude-code-watch.ps1 -Once           one tick, then exit (for a hook)
#   claude-code-watch.ps1 -Status         is a watcher running, and on what
#   claude-code-watch.ps1 -Install        start it at logon, hidden
#   claude-code-watch.ps1 -InstallHook    add the SessionStart hook to settings.json
#   claude-code-watch.ps1 -Uninstall      remove that scheduled task
#   claude-code-watch.ps1 -Stop           ask a running watcher to exit
#
# Exit codes: 0 = finished cleanly, 1 = another watcher already holds the lock,
# 30 = setup problem.

[CmdletBinding()]
param(
    [int]$Interval = 10,            # seconds between ticks
    # The clock is checked every tick; the accounts are only queried when a
    # reset time has passed, or when this many seconds have gone by. Querying
    # every 10 s would be six HTTP calls a minute per account for an answer that
    # cannot change before a window resets.
    [int]$IdleProbeSeconds = 120,
    # An account with room to spare cannot reach its limit in two minutes
    # either. With headroom the wait grows with the room left - up to this -
    # instead of asking the API 720 times a day for a number that moves slowly.
    [int]$MaxProbeSeconds = 900,
    # -1 means "whatever the toolkit uses" (claude-cc-common.ps1: 99% for the
    # 5-hour window, 99.8% for the weekly one), which a param block cannot read.
    [double]$Threshold = -1,
    [double]$WeeklyThreshold = -1,
    # After a switch, no second switch for this long. Every switch restarts
    # every registered session, and each of those comes back with a turn of its
    # own: two switches a minute apart would spend the account they just moved
    # to on nothing but restarts.
    [int]$CooldownSeconds = 600,
    [int]$MaxRestarts = 8,          # sessions restarted per switch, at most
    [switch]$Once,                  # a single tick, no loop
    [switch]$NoRelaunch,            # switch the credentials, leave the sessions alone
    [switch]$AllowUntrusted,
    [switch]$Quiet,                 # log to the file only, print nothing
    [switch]$Status,
    [switch]$Install,
    [switch]$InstallHook,
    [switch]$Uninstall,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')
. (Join-Path $PSScriptRoot 'claude-cc-threads.ps1')

# The defaults live in the common file, which a param block cannot read.
if ($Threshold -lt 0)       { $Threshold = $CcThreshold }
if ($WeeklyThreshold -lt 0) { $WeeklyThreshold = $CcWeeklyThreshold }
# pwsh -File takes strings: a French locale would hand the switcher "99,8",
# which its [double] param reads with the invariant culture and rejects.
$script:ThresholdArg       = ([double]$Threshold).ToString([cultureinfo]::InvariantCulture)
$script:WeeklyThresholdArg = ([double]$WeeklyThreshold).ToString([cultureinfo]::InvariantCulture)

$WatchLog     = Join-Path $CcStore 'watch.log'
$WatchPidFile = Join-Path $CcStore '.watch.pid'
$WatchStop    = Join-Path $CcStore '.watch.stop'
$WatchState   = Join-Path $CcStore '.watch.state'
# The console-less launcher the scheduled task runs; see New-HiddenLauncher.
$WatchStub    = Join-Path $CcStore 'watch-hidden.vbs'
$TaskName     = 'ClaudeCodeAccountWatch'

$script:LogLines = 0
function Write-WatchLog($msg, $color = 'Gray') {
    if (-not $Quiet) { Write-Host $msg -ForegroundColor $color }
    try {
        New-Item -ItemType Directory -Force -Path $CcStore | Out-Null
        Add-Content -LiteralPath $WatchLog -Value ("{0:s} {1}" -f (Get-Date), $msg)
        # A line every probe, day after day: kept to the last few hundred.
        $script:LogLines++
        if ($script:LogLines % 200 -eq 0) { Limit-CcLog $WatchLog 500 }
    } catch {}
}

function Get-RunningWatcher { Get-CcPidFileProcess $WatchPidFile '^(pwsh|powershell)$' }

# Survives a restart of the watcher: when the last switch happened (so the
# cooldown is not reset by a restart), and which sessions that switch could not
# get to.
function Get-WatchState {
    try {
        if (-not (Test-Path $WatchState)) { return $null }
        return (Get-Content -LiteralPath $WatchState -Raw | ConvertFrom-Json)
    } catch { return $null }
}
function Save-WatchState($lastSwitchAt, $pending) {
    try {
        New-Item -ItemType Directory -Force -Path $CcStore | Out-Null
        [System.IO.File]::WriteAllText($WatchState,
            ([pscustomobject]@{ lastSwitchAt = $lastSwitchAt; pending = @($pending) } | ConvertTo-Json -Compress),
            (New-Object System.Text.UTF8Encoding($false)))
        Protect-CcFile $WatchState
    } catch {}
}
function Get-LastSwitchTime {
    $s = Get-WatchState
    if (-not $s -or -not $s.lastSwitchAt) { return $null }
    return (ConvertTo-LocalTime $s.lastSwitchAt)
}
function Set-LastSwitchTime {
    $s = Get-WatchState
    Save-WatchState (Get-Date -Format o) @(if ($s) { $s.pending } else { @() })
}
function Get-PendingRestarts {
    $s = Get-WatchState
    if (-not $s -or -not $s.pending) { return @() }
    return @($s.pending | ForEach-Object { [int]$_ })
}
function Set-PendingRestarts($pids) {
    $s = Get-WatchState
    Save-WatchState $(if ($s) { $s.lastSwitchAt } else { $null }) @($pids)
}

# -- Subcommands ---------------------------------------------------------------

# Scheduled tasks are a Windows notion; asking for one on Linux is a
# CommandNotFoundException, which -ErrorAction cannot swallow.
function Get-WatchTask {
    if (-not $CcPlatformWin) { return $null }
    return (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
}

if ($Status) {
    $p = Get-RunningWatcher
    Write-Host ("watcher      : {0}" -f $(if ($p) { "running (pid $($p.Id), up since $($p.StartTime))" } else { 'not running' }))
    $task = Get-WatchTask
    Write-Host ("at logon     : {0}" -f $(if ($task) { "yes ($($task.State))" } else { 'no' }))
    $last = Get-LastSwitchTime
    if ($last) { Write-Host ("last switch  : {0:yyyy-MM-dd HH:mm:ss}" -f $last) }
    $threads = @(Get-CcLiveThreads)
    Write-Host ("live sessions: {0}" -f $threads.Count)
    foreach ($t in $threads) {
        Write-Host ("  pid {0,-7} session {1}  {2}" -f $t.pid, $t.sessionId, $t.workDir) -ForegroundColor DarkGray
    }
    if (Test-Path $WatchLog) {
        Write-Host "last lines:" -ForegroundColor DarkGray
        Get-Content -LiteralPath $WatchLog -Tail 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    }
    exit 0
}

if ($Stop) {
    $p = Get-RunningWatcher
    if (-not $p) { Write-Host "No watcher is running." -ForegroundColor Yellow; exit 0 }
    # Asked to leave rather than killed: a watcher taken down mid-tick could
    # leave the credentials half written.
    [System.IO.File]::WriteAllText($WatchStop, (Get-Date).ToString('o'), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Asked the watcher (pid $($p.Id)) to stop; it exits within $Interval s." -ForegroundColor Green
    exit 0
}

if ($Uninstall) {
    if (Get-WatchTask) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed the '$TaskName' scheduled task." -ForegroundColor Green
    } else {
        Write-Host "No '$TaskName' scheduled task to remove." -ForegroundColor Yellow
    }
    # Nothing else runs it once the task is gone.
    Remove-Item -LiteralPath $WatchStub -Force -ErrorAction SilentlyContinue
    exit 0
}

# The SessionStart hook is what puts a session in the registry; without it the
# watcher can switch the account but has nothing to restart. Merged into
# settings.json rather than described in a README: hand-editing JSON is how the
# hook ended up missing in the first place.
function Install-SessionHook {
    $settingsFile = $CcSettingsFile
    $hookScript   = (Join-Path $PSScriptRoot 'claude-code-hook.ps1') -replace '\\', '/'
    $command      = 'pwsh -NoProfile -File "{0}"' -f $hookScript

    # Read-CcSettings throws on a file that is not JSON rather than dropping it:
    # a settings file we cannot read is one we must not overwrite.
    try { $root = Read-CcSettings $settingsFile } catch {
        Write-Host "$settingsFile is not readable as JSON - left alone." -ForegroundColor Red
        return $false
    }
    $hooks = [ordered]@{}
    if ($root['hooks']) { foreach ($p in $root['hooks'].PSObject.Properties) { $hooks[$p.Name] = $p.Value } }

    $starts = @()
    if ($hooks['SessionStart']) { $starts = @($hooks['SessionStart']) }
    foreach ($entry in $starts) {
        foreach ($h in @($entry.hooks)) {
            if ($h.command -and $h.command -match 'claude-code-hook\.ps1') {
                Write-Host "The SessionStart hook is already in $settingsFile." -ForegroundColor Green
                return $true
            }
        }
    }
    # Its own entry, so nothing already in SessionStart is touched.
    $starts += [pscustomobject]@{ hooks = @([pscustomobject]@{ type = 'command'; command = $command; timeout = 20 }) }
    $hooks['SessionStart'] = $starts
    $root['hooks'] = [pscustomobject]$hooks

    Save-CcSettings $root $settingsFile
    Write-Host "Added the SessionStart hook to $settingsFile (previous file kept as .bak)." -ForegroundColor Green
    return $true
}

if ($InstallHook) { if (Install-SessionHook) { exit 0 } else { exit 30 } }

# A one-line VBScript whose only job is to be a program with no console. It is
# written at install time with the command already baked in, so nothing has to
# survive a second round of Task Scheduler quoting.
function New-HiddenLauncher([string]$exe, [string]$argLine) {
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    if (-not (Test-Path $wscript)) { return $null }
    $cmd = ('"{0}" {1}' -f $exe, $argLine) -replace '"', '""'
    $vbs = @"
' Written by claude-code-watch.ps1 -Install; edit that, not this.
' Task Scheduler runs its action inside the interactive session, so pwsh.exe as
' the action flashes a console window every time the task fires. wscript.exe has
' no console of its own, and Run(cmd, 0, True) starts the watcher with its
' window hidden from creation and waits for it - so the task instance lasts as
' long as the watcher, which is what -MultipleInstances IgnoreNew relies on.
Set sh = CreateObject("WScript.Shell")
WScript.Quit sh.Run("$cmd", 0, True)
"@
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path $WatchStub) | Out-Null
        # UTF-16 with a BOM: that is the only encoding wscript reads as Unicode,
        # and the path baked in above goes through a user name it does not choose.
        [System.IO.File]::WriteAllText($WatchStub, $vbs, (New-Object System.Text.UnicodeEncoding($false, $true)))
    } catch { return $null }
    return [pscustomobject]@{ Execute = $wscript; Arguments = ('//nologo "{0}"' -f $WatchStub) }
}

if ($Install) {
    if (-not $CcPlatformWin) {
        Write-Host "Starting at logon is Windows-only here. Run 'claude-code-watch' from your session manager instead." -ForegroundColor Yellow
        exit 30
    }
    $pwshPath = (Get-Process -Id $PID).Path
    if (-not $pwshPath) { $pwshPath = 'pwsh.exe' }
    $self = Join-Path $PSScriptRoot 'claude-code-watch.ps1'
    # -NonInteractive and no -WindowStyle: the task's own action must not ask for
    # a console at all - asking for one is what made the task exit with
    # 0xC000013A (CTRL_C) the moment it started.
    $argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Interval {1} -Quiet' -f $self, $Interval
    # The task runs in the user's interactive session (it has to: the snapshots
    # are DPAPI-encrypted for this user), so pwsh.exe as the action puts a
    # console window on screen every time the task fires - at logon, and again
    # whenever the 15-minute check finds no watcher running. wscript.exe has no
    # console of its own; the stub it runs starts pwsh with the window hidden
    # from creation, and waits for it, so the task instance still stands for the
    # running watcher and -MultipleInstances IgnoreNew keeps working.
    $launcher = New-HiddenLauncher $pwshPath $argLine
    if ($launcher) {
        $action = New-ScheduledTaskAction -Execute $launcher.Execute -Argument $launcher.Arguments
    } else {
        $action = New-ScheduledTaskAction -Execute $pwshPath -Argument $argLine
    }
    $triggers = @(New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME")
    # A watcher that dies between two logons would otherwise stay dead until the
    # next one. This second trigger looks in every 15 minutes; while a watcher is
    # up the task instance is still running and IgnoreNew drops the new start, so
    # in the normal case it costs nothing.
    # Ten years, not TimeSpan::MaxValue: the scheduler rejects the XML that one
    # serialises to (P99999999DT23H59M59S), and it rejects it at registration,
    # not when the trigger is built.
    $triggers += New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
        -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
    # Interactive: the snapshots are DPAPI-encrypted for this user, and a task
    # running without the user's logon session cannot decrypt them.
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    # No battery conditions: a laptop on battery is exactly when a session is
    # sitting there waiting for a quota. IgnoreNew, because the mutex would make
    # a second instance exit anyway.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
        -Description 'Switch the Claude Code account as soon as a rate limit expires' -Force | Out-Null

    Install-SessionHook | Out-Null

    if (Get-RunningWatcher) {
        Write-Host "Installed '$TaskName' - a watcher is already running, so it takes over at the next logon (and is checked every 15 min)." -ForegroundColor Green
    } else {
        Start-ScheduledTask -TaskName $TaskName
        Start-Sleep -Seconds 3
        $p = Get-RunningWatcher
        if ($p) {
            Write-Host "Installed '$TaskName' - it starts at logon, is checked every 15 min, and is running now (pid $($p.Id))." -ForegroundColor Green
        } else {
            $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
            Write-Host ("Installed '$TaskName', but it did not come up (last result {0})." -f $(if ($info) { $info.LastTaskResult } else { 'unknown' })) -ForegroundColor Yellow
            Write-Host "Opening any Claude Code session starts it through the hook in the meantime." -ForegroundColor DarkGray
        }
    }
    Write-Host "Check it with: claude-code-watch -Status" -ForegroundColor DarkGray
    exit 0
}

# -- The watcher itself --------------------------------------------------------

$autoScript = Join-Path $PSScriptRoot 'claude-code-auto.ps1'
$relaunch   = Join-Path $PSScriptRoot 'claude-code-relaunch.ps1'
if (-not (Test-Path $autoScript)) { Write-Host "claude-code-auto.ps1 is missing." -ForegroundColor Red; exit 30 }

# When every account is limited, the next thing that can change the answer is
# the earliest reset among them. The switcher writes each reading into the
# snapshot it came from, so that time is on disk already - no extra HTTP call to
# find out when to look again.
function Get-NextResetTime {
    $soonest = $null
    $now = Get-Date
    foreach ($f in (Get-ChildItem $CcStore -Filter '*.json' -ErrorAction SilentlyContinue | Where-Object { -not $_.Name.StartsWith('.') })) {
        try { $j = Get-Content $f.FullName -Raw | ConvertFrom-Json } catch { continue }
        if (-not $j.usageCache) { continue }
        foreach ($w in @('five_hour', 'seven_day')) {
            $t = ConvertTo-LocalTime $j.usageCache.$w.resets_at
            if ($t -and $t -gt $now -and (-not $soonest -or $t -lt $soonest)) { $soonest = $t }
        }
    }
    return $soonest
}

# The dormant accounts. Their access tokens expire while nobody is logged into
# them, and the refresh token that would replace one is only good until the next
# rotation, so the pool has to spend it on its own schedule or the account comes
# back needing a browser. Hourly is plenty: the access token lives hours, and
# the endpoint rate-limits the caller, not the account.
$script:nextRenew = Get-Date
function Invoke-Renew {
    $renew = Join-Path $PSScriptRoot 'claude-code-renew.ps1'
    if (-not (Test-Path $renew)) { return }
    if ((Get-Date) -lt $script:nextRenew) { return }
    $out = & $pwshSelf -NoProfile -File $renew -Quiet 2>&1
    $code = $LASTEXITCODE
    $script:nextRenew = (Get-Date).AddHours(1)
    switch ($code) {
        1 {
            # Named, because "an account needs /login" is the one thing here the
            # user has to act on and the log is where they would find it.
            foreach ($line in ($out -split "`n" | Where-Object { $_ -match 'needs /login' })) {
                Write-WatchLog ("renew: " + $line.Trim()) Yellow
            }
        }
        2 {
            $script:nextRenew = (Get-Date).AddHours(3)
            Write-WatchLog "renew: the token endpoint is rate limiting; next attempt in 3h" DarkYellow
        }
        0 {
            foreach ($line in ($out -split "`n" | Where-Object { $_ -match 'renewed' })) {
                Write-WatchLog ("renew: " + $line.Trim()) DarkGray
            }
        }
    }
}

function Invoke-Switcher {
    # -Machine adds the CCUSAGE line the backoff is computed from, so the wording
    # of the prose lines is free to change. The output is captured, not printed.
    $out = & $pwshSelf -NoProfile -File $autoScript -NoRelaunch -Machine `
        -Threshold $script:ThresholdArg -WeeklyThreshold $script:WeeklyThresholdArg @autoExtra 2>&1
    return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($out | Out-String).Trim() }
}

# How far the current account is from its nearest threshold. $null when the
# switcher reported nothing measurable.
function Get-HeadroomPercent($text) {
    # Decimals: the weekly window is compared against 99.8%, so the switcher
    # emits one decimal place (invariant culture, always a dot).
    $m = [regex]::Match($text, 'CCUSAGE five=(-?[\d.]+) seven=(-?[\d.]+)')
    # The prose line is the fallback, for a switcher too old to know -Machine.
    if (-not $m.Success) { $m = [regex]::Match($text, '5h\s+([\d.]+)%\s*/\s*7d\s+([\d.]+)%') }
    if (-not $m.Success) { return $null }
    # -1 is an unmeasured window. Counting it as 0% used would report all the
    # room in the world and push the next look 15 minutes out.
    $inv = [cultureinfo]::InvariantCulture
    $rooms = @()
    $u5 = [double]::Parse($m.Groups[1].Value, $inv)
    $u7 = [double]::Parse($m.Groups[2].Value, $inv)
    if ($u5 -ge 0) { $rooms += ($Threshold - $u5) }
    if ($u7 -ge 0) { $rooms += ($WeeklyThreshold - $u7) }
    if (-not $rooms.Count) { return $null }
    return [Math]::Max(0, ($rooms | Measure-Object -Minimum).Minimum)
}

# An account at 35% cannot hit 99% in two minutes; one at 95% can. The wait
# grows with the room left, so the quiet case costs a handful of calls a day
# instead of one every two minutes, and the tight case still reacts fast.
function Get-BackoffSeconds($headroom) {
    if ($null -eq $headroom) { return $IdleProbeSeconds }
    $span = [Math]::Max(0, $MaxProbeSeconds - $IdleProbeSeconds)
    $frac = [Math]::Min(1.0, [double]$headroom / 30.0)
    return [int]($IdleProbeSeconds + $span * $frac)
}

function Restart-LiveThreads {
    $threads = @(Get-CcLiveThreads)
    if (-not $threads.Count) {
        Write-WatchLog "  nothing to restart - no session is registered" DarkGray
        return
    }
    $extra = @()
    if ($threads.Count -gt $MaxRestarts) {
        $extra = @($threads | Select-Object -Skip $MaxRestarts)
        Write-WatchLog ("  {0} sessions registered; restarting {1} now, the other {2} on the next tick" -f `
            $threads.Count, $MaxRestarts, $extra.Count) Yellow
        $threads = @($threads | Select-Object -First $MaxRestarts)
    }
    Invoke-ThreadRestarts $threads
    # Whatever did not fit is remembered rather than dropped: those sessions are
    # still on the account that just ran out, and the cooldown means no second
    # switch would come along to pick them up.
    Set-PendingRestarts @($extra | ForEach-Object { [int]$_.pid })
}

# Sessions left over from a switch that hit -MaxRestarts. Runs inside the
# cooldown, since the point is to finish a restart that already started.
function Resume-PendingRestarts {
    $pending = @(Get-PendingRestarts)
    if (-not $pending.Count) { return $false }
    $threads = @(Get-CcLiveThreads | Where-Object { $pending -contains [int]$_.pid })
    $rest = @()
    if ($threads.Count -gt $MaxRestarts) {
        $rest = @($threads | Select-Object -Skip $MaxRestarts | ForEach-Object { [int]$_.pid })
        $threads = @($threads | Select-Object -First $MaxRestarts)
    }
    # Dropped from the list whatever the outcome: a session the wrapper cannot
    # restart must not be retried on every tick forever.
    Set-PendingRestarts $rest
    if (-not $threads.Count) { return $false }
    Write-WatchLog ("catching up on {0} session(s) left from the last switch" -f $threads.Count) Yellow
    Invoke-ThreadRestarts $threads
    return $true
}

function Invoke-ThreadRestarts($threads) {
    $i = 0
    foreach ($t in $threads) {
        # Staggered: every one of them dies and is restarted by the wrapper, and
        # a dozen ConPTYs coming back in the same instant is a thundering herd
        # for no gain.
        & $relaunch -VictimPid ([int]$t.pid) -VictimStartedAt ([string]$t.startedAt) `
                    -SessionId $t.sessionId -AnyHost -Delay (0.3 * $i)
        $rc = $LASTEXITCODE
        $verdict = switch ($rc) {
            0 { 'restarting' }
            2 { 'gone' }
            3 { 'no wrapper in front of it' }
            default { "relaunch exit $rc" }
        }
        Write-WatchLog ("  session {0} (pid {1}): {2}" -f $t.sessionId, $t.pid, $verdict) DarkGray
        $i++
    }
}

$pwshSelf = (Get-Process -Id $PID).Path
if (-not $pwshSelf) { $pwshSelf = 'pwsh' }
$autoExtra = @()
if ($AllowUntrusted) { $autoExtra += '-AllowUntrusted' }

# One watcher at a time, or two of them would race on the same credentials file.
$lock = New-Object System.Threading.Mutex($false, 'Global\ClaudeCodeAccountWatch')
$haveLock = $false
# -Once waits a moment rather than barging in: a single tick still swaps the
# live credentials, and two switchers doing that at once is the one race this
# lock exists to prevent.
$waitMs = if ($Once) { 20000 } else { 0 }
try { $haveLock = $lock.WaitOne($waitMs) } catch [System.Threading.AbandonedMutexException] { $haveLock = $true }
if (-not $haveLock) {
    $p = Get-RunningWatcher
    Write-Host ("A watcher is already running{0}." -f $(if ($p) { " (pid $($p.Id))" } else { '' })) -ForegroundColor Yellow
    exit 1
}

Remove-Item -LiteralPath $WatchStop -Force -ErrorAction SilentlyContinue
if (-not $Once) {
    # A pid file naming a process that is gone, with no "watcher down" line
    # before it, means the last watcher was killed rather than asked to stop.
    # Recorded here because the log is the only place that ever shows it.
    $stalePid = Read-CcPidFile $WatchPidFile
    if ($stalePid -and $stalePid -ne $PID -and -not (Get-RunningWatcher)) {
        Write-WatchLog "previous watcher (pid $stalePid) vanished without stopping" Yellow
    }
    New-Item -ItemType Directory -Force -Path $CcStore | Out-Null
    [System.IO.File]::WriteAllText($WatchPidFile, "$PID", (New-Object System.Text.UTF8Encoding($false)))
    Write-WatchLog "watcher up (pid $PID, tick ${Interval}s, threshold $Threshold/$WeeklyThreshold)" Cyan
    # Cheap housekeeping, once per watcher: signatures whose marker is gone.
    try { Clear-CcOrphanMarkerSigs | Out-Null } catch {}
}

$nextProbe = Get-Date   # the first tick probes
try {
    while ($true) {
        if (Test-Path $WatchStop) {
            Remove-Item -LiteralPath $WatchStop -Force -ErrorAction SilentlyContinue
            Write-WatchLog "watcher stopping on request" Cyan
            break
        }

        # Every tick, not only when a switch is due: the live session rotates its
        # refresh token on its own schedule, and the saved copy is dead the
        # moment it does. This is the whole reason an account that sat unused
        # used to come back asking for /login.
        try {
            $synced = Sync-CcLiveSnapshot
            if ($synced) { Write-WatchLog "refreshed the saved login for $($synced.Email)" DarkGray }
        } catch {
            Write-WatchLog "could not refresh the saved login: $($_.Exception.Message)" DarkYellow
        }
        try { Invoke-Renew } catch { Write-WatchLog "renew failed: $($_.Exception.Message)" DarkYellow }

        $now = Get-Date
        if ($now -ge $nextProbe) {
            $threads = @(Get-CcLiveThreads)
            if (-not $threads.Count -and -not $Once) {
                # No session is running, so there is no seat to move. Keep
                # ticking: a thread can start at any time.
                $nextProbe = $now.AddSeconds($IdleProbeSeconds)
            } elseif ((-not $NoRelaunch) -and (Resume-PendingRestarts)) {
                # A switch that ran out of restarts finishes here, before the
                # cooldown branch: those sessions are still on the old account.
                $nextProbe = (Get-Date).AddSeconds([Math]::Max(30, $Interval))
            } elseif ($CooldownSeconds -gt 0 -and ($last = Get-LastSwitchTime) -and
                      ($now - $last).TotalSeconds -lt $CooldownSeconds) {
                # Still inside the cooldown of the previous switch. Asking again
                # would only find the same answer and restart every session a
                # second time.
                $resume = $last.AddSeconds($CooldownSeconds)
                $nextProbe = $resume.AddSeconds(1)
                Write-WatchLog ("switched at {0:HH:mm:ss}; holding until {1:HH:mm:ss}" -f $last, $resume) DarkGray
            } else {
                $r = Invoke-Switcher
                switch ($r.Code) {
                    10 {
                        Write-WatchLog ("switched: " + (($r.Text -split "`n" | Where-Object { $_ -match 'Switched Claude Code to' } | Select-Object -Last 1) -replace '^\s+', '')) Green
                        Set-LastSwitchTime
                        if (-not $NoRelaunch) { Restart-LiveThreads }
                        # The sessions are coming back on the new account; give
                        # them time to register themselves again before the next
                        # look.
                        $nextProbe = (Get-Date).AddSeconds([Math]::Max(30, $Interval))
                    }
                    20 {
                        $reset = Get-NextResetTime
                        $nextProbe = if ($reset) {
                            # A few seconds past the reset: the server decides
                            # when the window is really open, and being early
                            # only buys another "still limited".
                            $candidate = $reset.AddSeconds(15)
                            if ($candidate -gt $now.AddSeconds($IdleProbeSeconds)) { $candidate } else { $now.AddSeconds($Interval) }
                        } else { $now.AddSeconds($IdleProbeSeconds) }
                        Write-WatchLog ("all limited; next look at {0:HH:mm:ss}" -f $nextProbe) DarkGray
                    }
                    30 {
                        Write-WatchLog ("setup problem: " + ($r.Text -split "`n" | Select-Object -First 1)) Yellow
                        $nextProbe = $now.AddSeconds([Math]::Max(300, $IdleProbeSeconds))
                    }
                    0 {
                        # The current account is fine. Nothing to do until it is
                        # not - but say so, or the log gives no way to tell a
                        # working watcher from a stuck one.
                        $headroom = Get-HeadroomPercent $r.Text
                        $nextProbe = $now.AddSeconds((Get-BackoffSeconds $headroom))
                        $room = if ($null -eq $headroom) { 'headroom' }
                                elseif ($headroom -eq 1) { '1 point of headroom' }
                                else { "{0} points of headroom" -f $headroom }
                        Write-WatchLog ("current account has $room; next look at {0:HH:mm:ss}" -f $nextProbe) DarkGray
                    }
                    default {
                        # Anything else is the switcher failing, not an account
                        # with room. Reported as such: silently backing off here
                        # is how a broken switcher passes for a healthy one.
                        $first = ($r.Text -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
                        $nextProbe = $now.AddSeconds([Math]::Max(300, $IdleProbeSeconds))
                        Write-WatchLog ("switcher failed (exit {0}): {1}; next look at {2:HH:mm:ss}" -f `
                            $r.Code, $(if ($first) { $first.Trim() } else { 'no output' }), $nextProbe) Red
                    }
                }
            }
        }

        if ($Once) { break }
        Start-Sleep -Seconds $Interval
    }
} finally {
    if (-not $Once) {
        Remove-Item -LiteralPath $WatchPidFile -Force -ErrorAction SilentlyContinue
        Write-WatchLog "watcher down (pid $PID)" Cyan
    }
    if ($haveLock) { $lock.ReleaseMutex() }
    $lock.Dispose()
}
exit 0
