# claude-cc - one entry point in front of the switcher.
#
# The tools underneath each do one thing and print a full report. That is the
# right shape for a person at a prompt and the wrong one for an agent, which
# pays for every line it reads back and for every command it has to chain
# itself. This dispatcher does the chaining, and answers in a few lines.
#
#   claude-cc status            accounts, watcher, sessions - no network call
#   claude-cc status -Fresh     same, with a live usage reading
#   claude-cc list              the full table (usage API)
#   claude-cc switch <who>      2 | bob | bob@x.com | next
#   claude-cc auto              switch if the current account is out of quota
#   claude-cc auto status       what a switch would do, change nothing
#   claude-cc refresh [all]     restart this session, or every registered one
#   claude-cc add               save the account that is logged in right now
#   claude-cc remove <who>      take a saved account back out of the pool
#   claude-cc renew             keep the saved logins alive (no browser)
#   claude-cc watch [status|install|stop]
#   claude-cc statusline [status|install|uninstall|render]
#                               add "who is logged in, how many free" to the
#                               status line, keeping the one already there
#   claude-cc doctor            the long diagnosis
#   claude-cc fix               repair what doctor would complain about
#
# Exit codes are the ones the underlying tool returned, so a caller can still
# tell 10 (switched) from 20 (all limited) from 30 (setup incomplete). `status`
# returns 1 only when the setup itself needs work; a pool with no headroom left
# is printed as a note and still exits 0, because nothing can repair a quota.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = 'status',
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Rest = @()
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')
. (Join-Path $PSScriptRoot 'claude-cc-threads.ps1')

function Get-Tool($name) { Join-Path $PSScriptRoot $name }

# `& script.ps1 @array` passes the elements positionally - a script with named
# parameters only rejects them. A hashtable is the splat form that binds, so
# command lines are carried around here as tables, not as strings.
function ConvertTo-ArgTable([string[]]$tokens) {
    $h = @{}
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        $t = $tokens[$i]
        if (-not $t -or $t -notlike '-*') { continue }
        $name = $t.TrimStart('-').TrimEnd(':')
        $next = if ($i + 1 -lt $tokens.Count) { $tokens[$i + 1] } else { $null }
        if ($next -and $next -notlike '-*') { $h[$name] = $next; $i++ } else { $h[$name] = $true }
    }
    return $h
}

function Join-ArgTable($base, $extra) {
    $h = @{}
    foreach ($k in $base.Keys)  { $h[$k] = $base[$k] }
    foreach ($k in $extra.Keys) { $h[$k] = $extra[$k] }
    return $h
}

# Called with & rather than a child pwsh: `exit` inside a script called that way
# ends the script and sets $LASTEXITCODE, without a second process to start.
function Invoke-Tool($name, $toolArgs) {
    $global:LASTEXITCODE = 0
    if (-not $toolArgs) { $toolArgs = @{} }
    & (Get-Tool $name) @toolArgs
    return $LASTEXITCODE
}

# One "key   value" line, so twenty of them still read as a block.
function Line($key, $value, $color = 'Gray') {
    Write-Host ("  {0,-9} {1}" -f $key, $value) -ForegroundColor $color
}

# -- status --------------------------------------------------------------------

function Get-AccountRows([switch]$Fresh) {
    $listArgs = @{ Json = $true }
    # Cached readings by default: `status` is what an agent calls, and it must
    # not cost one API round trip per account every time.
    if (-not $Fresh) { $listArgs.CacheOnly = $true }
    $raw = & (Get-Tool 'claude-code-list.ps1') @listArgs 2>$null
    if ($LASTEXITCODE -eq 30) { return $null }
    try { return (($raw | Out-String) | ConvertFrom-Json).accounts } catch { return @() }
}

function Show-Status([switch]$Fresh) {
    $problems = @()   # setup: something is missing or broken
    $notes    = @()   # state: true right now, nothing to repair
    $rows = Get-AccountRows -Fresh:$Fresh
    if ($null -eq $rows) {
        Say "No saved accounts. Save the one you are logged in as: claude-cc add" Yellow
        return 1
    }
    foreach ($r in $rows) {
        $usage = if ($null -ne $r.Five -or $null -ne $r.Seven) {
            "5h {0} / 7d {1}{2}" -f `
                (Format-CcPct $r.Five), (Format-CcPct $r.Seven),
                $(if ($r.Cached -and $r.CacheAge) { " (read $($r.CacheAge))" } else { '' })
        } else { 'usage unread' }
        # "usable" is the listing's own verdict, so status and list never disagree
        # about which account the switcher would accept.
        $usage = ("usable {0,-3}  " -f $(if ($r.Usable) { 'yes' } else { 'no' })) + $usage
        $flag = switch ($r.Status) {
            'ok'      { '' }
            'sealed'  { '  SEALED - saved for another user or machine' }
            'unknown' { '  UNREGISTERED - not in the pool manifest' }
            'changed' { '  CHANGED - does not match its registration' }
            'nokey'   { '  UNVERIFIED - the pool key cannot be read' }
            default   { "  $($r.Status)" }
        }
        if ($flag) { $problems += "$($r.Email):$flag".Trim() }
        # When the live account gets its 5h window back is the one date worth a
        # line here: it is what decides whether to wait or to switch.
        if ($r.Current -and -not $flag -and $r.Reset -match '5h resets in ([^|]+)') {
            $usage += "  5h back in {0}" -f $Matches[1].Trim()
        }
        # For every other blocked account, the wait that matters is until the
        # switcher would take it - the later of its two windows, not the 5h one.
        if (-not $r.Current -and -not $flag -and -not $r.Usable -and $null -ne $r.ReadyIn) {
            $usage += "  available in {0}" -f (Format-CcWait ([timespan]::FromMinutes([double]$r.ReadyIn)))
        }
        $mark = if ($r.Current) { '*' } else { ' ' }
        Write-Host ("  {0} {1,-32} {2}{3}" -f $mark, $r.Email, $usage, $flag) `
            -ForegroundColor $(if ($flag) { 'Red' } elseif ($r.Current) { 'Green' } else { 'Gray' })
    }
    if ($rows.Count -lt 2) { $problems += 'only one account saved: a switch has nowhere to go' }
    # Knowing there is nowhere to switch to is worth more than the percentages
    # themselves: it is the difference between "the watcher will handle it" and
    # "the next limit stops the work". The verdict comes from the listing, which
    # applies the toolkit thresholds ($CcThreshold / $CcWeeklyThreshold).
    $others = @($rows | Where-Object { -not $_.Current })
    $withRoom = @($others | Where-Object { $_.Usable })
    if ($others.Count -and -not $withRoom.Count) {
        $notes += 'no other account has headroom: a switch would report "all limited" (exit 20)'
        # "Wait or stop for today" is decided by the first account that comes
        # back, not by the one that is least full, so that is the one timed.
        # ReadyIn is minutes: the rows came back through JSON, where a date is a
        # string and subtracting one would throw.
        $next = @($others | Where-Object { $_.Status -eq 'ok' -and $null -ne $_.ReadyIn } |
                  Sort-Object ReadyIn | Select-Object -First 1)
        if ($next.Count) {
            $notes += "next account available in {0} - {1}" -f `
                (Format-CcWait ([timespan]::FromMinutes([double]$next[0].ReadyIn))), $next[0].Email
        } else {
            $notes += 'none of them reported when a quota window comes back, so the wait cannot be timed'
        }
    }

    # The watcher is what turns "would switch" into "switched", so its state
    # belongs in the same block as the accounts.
    $watchProc = Get-CcPidFileProcess (Join-Path $CcStore '.watch.pid') '^(pwsh|powershell)$'
    $taskState = ''
    if ($CcPlatformWin) {
        try {
            $task = Get-ScheduledTask -TaskName 'ClaudeCodeAccountWatch' -ErrorAction SilentlyContinue
            $taskState = if ($task) { ", task $($task.State)" } else { ', no scheduled task' }
        } catch { $taskState = '' }
    }
    $hook = Test-Path (Join-Path $CcStore '.threads.state')
    $hookInstalled = Test-CcSessionHook
    if ($watchProc) {
        Line 'watcher' ("running (pid {0}){1}" -f $watchProc.Id, $taskState) Green
    } else {
        Line 'watcher' ("not running{0}" -f $taskState) Yellow
        $problems += 'the watcher is not running: claude-cc fix'
    }
    if (-not $hookInstalled) { $problems += 'no SessionStart hook: sessions cannot be restarted after a switch' }

    $threads = @(Get-CcLiveThreads)
    # A switch that ran out of restarts leaves sessions on the old account until
    # the watcher catches up. Say so rather than let them look healthy.
    $pending = @()
    try {
        $st = Get-Content -LiteralPath (Join-Path $CcStore '.watch.state') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
        if ($st -and $st.pending) { $pending = @($st.pending) }
    } catch {}
    $sessionNote = @()
    if (-not $hookInstalled) { $sessionNote += 'hook missing' }
    if ($pending.Count) { $sessionNote += "$($pending.Count) still to restart" }
    Line 'sessions' ("{0} registered{1}" -f $threads.Count,
        $(if ($sessionNote.Count) { ', ' + ($sessionNote -join ', ') } else { '' })) `
        $(if ($sessionNote.Count) { 'Yellow' } else { 'Gray' })

    if ($notes.Count) {
        Write-Host ""
        foreach ($n in $notes) { Say "  - $n" DarkYellow }
    }
    # Only a setup problem is worth a non-zero exit: a pool with no headroom left
    # is the truth of the moment, and no amount of repairing changes it.
    if ($problems.Count) {
        Write-Host ""
        foreach ($p in $problems) { Say "  ! $p" Yellow }
        return 1
    }
    return 0
}

# -- fix -----------------------------------------------------------------------

# Everything doctor would tell the user to run, run instead. Each step is
# idempotent, so this is safe to call when nothing is wrong.
function Invoke-Fix {
    $did = @()

    # 1. The wrapper: without it in front of `claude`, no session can refresh.
    #    Checked against the filesystem and PATH rather than by reading the
    #    status text - those tools print with Write-Host, which never reaches the
    #    output stream, so scraping them would rebuild the wrapper every time.
    $shimExe = Join-Path $PSScriptRoot 'shim\claude.exe'
    $resolved = (Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not (Test-Path $shimExe) -or -not $resolved -or
        $resolved -ne (Resolve-Path -LiteralPath $shimExe -ErrorAction SilentlyContinue).Path) {
        & (Get-Tool 'claude-code-shim.ps1') -Install 6>$null | Out-Null
        $did += 'installed the claude wrapper (restart Boite once for threads to pick it up)'
    }

    # 2. Snapshots still readable by anyone holding the file.
    $rows = @(Get-AccountRows)
    if (@($rows | Where-Object { -not $_.Protected }).Count) {
        & (Get-Tool 'claude-cc-pool.ps1') -Protect 6>$null | Out-Null
        $did += 'encrypted the snapshots that were still plain JSON'
    }

    # 3. The watcher, its scheduled task and the SessionStart hook.
    $watchProc = Get-CcPidFileProcess (Join-Path $CcStore '.watch.pid') '^(pwsh|powershell)$'
    $haveTask = $false
    if ($CcPlatformWin) {
        try { $haveTask = [bool](Get-ScheduledTask -TaskName 'ClaudeCodeAccountWatch' -ErrorAction SilentlyContinue) } catch {}
    }
    $hookInstalled = Test-CcSessionHook
    if (-not $haveTask -or -not $hookInstalled) {
        & (Get-Tool 'claude-code-watch.ps1') -Install 6>$null | Out-Null
        $did += 'registered the watcher task and the SessionStart hook'
    } elseif (-not $watchProc) {
        try {
            Start-ScheduledTask -TaskName 'ClaudeCodeAccountWatch' -ErrorAction Stop
            Start-Sleep -Seconds 3
            $did += 'started the watcher through its scheduled task'
        } catch { $did += "could not start the watcher: $($_.Exception.Message)" }
    }

    # 4. Leftovers nobody will act on: signatures whose marker is gone, and the
    #    wrappers parked by earlier rebuilds. A parked wrapper still running a
    #    thread is locked by Windows and simply stays.
    $swept = Clear-CcOrphanMarkerSigs
    if ($swept) { $did += "swept $swept orphan relaunch signature(s)" }
    $old = @(Get-ChildItem (Join-Path $PSScriptRoot 'shim') -Filter 'claude.old-*' -ErrorAction SilentlyContinue |
             Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) })
    if ($old.Count) {
        $old | Remove-Item -Force -ErrorAction SilentlyContinue
        $gone = $old.Count - @($old | Where-Object { Test-Path $_.FullName }).Count
        if ($gone) { $did += "removed $gone parked wrapper(s)" }
    }

    if (-not $did.Count) { Say "Nothing to repair." Green } else { foreach ($d in $did) { Say " - $d" Cyan } }
    Write-Host ""
    return (Show-Status)
}

# -- dispatch ------------------------------------------------------------------

# `switch 2`, `switch bob`, `switch next` - the shape of the argument says which
# flag the select tool wants, so the caller never has to know.
function Get-SelectArgs([string[]]$a) {
    $who   = @($a | Where-Object { $_ -notlike '-*' })[0]
    $flags = ConvertTo-ArgTable (@($a | Where-Object { $_ -like '-*' }))
    if (-not $who -or $who -eq 'list') { return @{ List = $true } }
    $sel = switch -Regex ($who) {
        '^next$'  { @{ Next = $true }; break }
        '^\d+$'   { @{ Index = [int]$who }; break }
        default   { @{ Email = $who } }
    }
    # A switch with nothing restarted leaves the session on the old account, so
    # -Relaunch is the default and -NoRefresh is how you opt out.
    if (-not $flags.ContainsKey('NoRefresh')) { $sel.Relaunch = $true }
    return (Join-ArgTable $sel $flags)
}

$sub = if ($Rest.Count) { $Rest[0] } else { '' }
$tail = if ($Rest.Count -gt 1) { $Rest[1..($Rest.Count - 1)] } else { @() }

switch -Regex ($Command) {
    '^(status|st)$' {
        exit (Show-Status -Fresh:([bool]($Rest -contains '-Fresh' -or $Rest -contains 'fresh')))
    }
    '^(list|ls)$'   { exit (Invoke-Tool 'claude-code-list.ps1' (ConvertTo-ArgTable $Rest)) }
    '^(switch|sw)$' { exit (Invoke-Tool 'claude-code-select.ps1' (Get-SelectArgs $Rest)) }
    '^auto$' {
        if ($sub -in @('status', 'dry', 'dryrun')) {
            exit (Invoke-Tool 'claude-code-auto.ps1' (Join-ArgTable @{ DryRun = $true } (ConvertTo-ArgTable $tail)))
        }
        exit (Invoke-Tool 'claude-code-auto.ps1' (Join-ArgTable @{ Quiet = $true } (ConvertTo-ArgTable $Rest)))
    }
    '^(refresh|r)$' {
        $rArgs = ConvertTo-ArgTable $Rest
        if ($Rest -contains 'all' -or $Rest -contains 'a') { $rArgs.All = $true }
        exit (Invoke-Tool 'claude-code-refresh.ps1' $rArgs)
    }
    '^add$'    { exit (Invoke-Tool 'claude-code-add.ps1' (ConvertTo-ArgTable $Rest)) }
    '^(remove|rm|forget)$' {
        # `remove bob` and `remove 2`: the account is a positional argument to
        # the tool, and everything starting with a dash is a flag.
        $who = @($Rest | Where-Object { $_ -notlike '-*' })[0]
        $rmArgs = ConvertTo-ArgTable (@($Rest | Where-Object { $_ -like '-*' }))
        if ($who) { $rmArgs.Email = $who }
        exit (Invoke-Tool 'claude-code-remove.ps1' $rmArgs)
    }
    '^renew$'  {
        $who = @($Rest | Where-Object { $_ -notlike '-*' })[0]
        $nArgs = ConvertTo-ArgTable (@($Rest | Where-Object { $_ -like '-*' }))
        if ($who) { $nArgs.Email = $who }
        exit (Invoke-Tool 'claude-code-renew.ps1' $nArgs)
    }
    '^watch$'  {
        $map = @{ status = 'Status'; install = 'Install'; stop = 'Stop'; hook = 'InstallHook'; once = 'Once' }
        $wArgs = ConvertTo-ArgTable $tail
        if ($sub -and $map.ContainsKey($sub)) { $wArgs[$map[$sub]] = $true }
        elseif (-not $sub) { $wArgs.Status = $true }
        elseif ($sub -like '-*') { $wArgs = Join-ArgTable (ConvertTo-ArgTable @($sub)) $wArgs }
        else { Say "Unknown 'watch' subcommand '$sub'. Try: status, install, stop, hook, once" Yellow; exit 64 }
        exit (Invoke-Tool 'claude-code-watch.ps1' $wArgs)
    }
    '^(statusline|sl)$' {
        $map = @{ status = 'Status'; install = 'Install'; on = 'Install'; uninstall = 'Uninstall'; off = 'Uninstall'; remove = 'Uninstall'; render = 'Render'; preview = 'Render' }
        $slArgs = ConvertTo-ArgTable $tail
        if ($sub -and $map.ContainsKey($sub)) { $slArgs[$map[$sub]] = $true }
        elseif (-not $sub) { $slArgs.Status = $true }
        elseif ($sub -like '-*') { $slArgs = Join-ArgTable (ConvertTo-ArgTable @($sub)) $slArgs }
        else { Say "Unknown 'statusline' subcommand '$sub'. Try: status, install, uninstall, render" Yellow; exit 64 }
        exit (Invoke-Tool 'claude-cc-statusline.ps1' $slArgs)
    }
    '^doctor$' { exit (Invoke-Tool 'claude-code-doctor.ps1' (ConvertTo-ArgTable $Rest)) }
    '^fix$'    { exit (Invoke-Fix) }
    '^(help|-h|--help|/\?)$' {
        Get-Content -LiteralPath $PSCommandPath | Select-Object -First 28 |
            ForEach-Object { $_ -replace '^# ?', '' } | Write-Host
        exit 0
    }
    default {
        Say "Unknown command '$Command'. Try: claude-cc help" Yellow
        exit 64
    }
}
