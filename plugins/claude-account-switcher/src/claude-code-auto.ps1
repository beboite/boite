# Auto-switch the Claude Code (CLI) account when the current one is rate limited.
#
# Non-interactive companion to claude-code-select.ps1: instead of taking a
# choice, it reads the usage of every saved account and swaps the live
# credentials to the account with the most headroom - but only when the current
# account is actually out of quota.
#
# Usage:
#   claude-code-auto.ps1                  check + switch if needed
#   claude-code-auto.ps1 -DryRun          report only, never write
#   claude-code-auto.ps1 -Threshold 80    switch at 80% of the 5h window
#                                         (defaults: 99% for 5h, 99.8% weekly)
#   claude-code-auto.ps1 -Force           switch even if the current account is fine
#
# Exit codes: 0 = no switch needed, 10 = switched, 20 = limited but no free
# account available, 30 = setup problem (no accounts / no live login).

[CmdletBinding()]
param(
    # Utilization (%) that counts as "rate limited", per window. Left at -1 they
    # take the toolkit-wide values from claude-cc-common.ps1 (99% for the 5-hour
    # window, 99.8% for the weekly one), so the switcher, the watcher and the
    # listing all agree on what "full" means. Fractions are honoured.
    [double]$Threshold = -1,
    [double]$WeeklyThreshold = -1,
    [switch]$Force,                # switch to the best account regardless of current usage
    [switch]$DryRun,               # report what would happen, change nothing
    [switch]$Quiet,                # only print the outcome line
    [switch]$Machine,              # add one parseable CCUSAGE line for the watcher
    [switch]$NoRelaunch,           # switch the credentials but leave the running session alone
    [switch]$AllowUntrusted,       # use snapshots that are not registered in the pool manifest
    [double]$RestartDelay = 0,     # extra seconds before the session is restarted; fractions are honoured
    # Which session to restart, when this is not running inside it. The watcher
    # reads both out of the thread registry; left empty they come from the
    # environment Claude Code exports to whatever it runs.
    [string]$SessionId = $env:CLAUDE_CODE_SESSION_ID,
    [int]$VictimPid = 0
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')

# The defaults live in the common file, which cannot be read from a param block.
if ($Threshold -lt 0)       { $Threshold = $CcThreshold }
if ($WeeklyThreshold -lt 0) { $WeeklyThreshold = $CcWeeklyThreshold }

# When an account stops being rate limited: the latest reset among the windows
# that are over their threshold right now. $null means it is not limited - a
# 5-hour window resetting in 20 minutes is no help while the 7-day one is full.
function Get-LimitedUntil($u) {
    if (-not $u) { return $null }
    $windows = @(
        @{ Name = 'five_hour'; Util = (Get-Util $u 'five_hour'); Cap = $Threshold },
        @{ Name = 'seven_day'; Util = (Get-Util $u 'seven_day'); Cap = $WeeklyThreshold }
    )
    $until = $null
    foreach ($w in $windows) {
        if (-not (Test-CcOverCap $w.Util $w.Cap)) { continue }
        $t = ConvertTo-LocalTime $u.($w.Name).resets_at
        if ($t -and (-not $until -or $t -gt $until)) { $until = $t }
    }
    return $until
}

# A refresh that never came back is worth one line here rather than a silent
# entry in a log file nobody opens.
Show-CcRelaunchFailure

# -- Load saved accounts -------------------------------------------------------
# A snapshot is restored into the live credentials as it is, so one that
# arrived in the folder on its own would hand the seat to a stranger's account.
# Get-CcPool asks the manifest about each one; a refused entry is named here and
# then left out, because switching to it is exactly what must not happen.
$poolLib = Join-Path $PSScriptRoot 'claude-cc-pool.ps1'
if (Test-Path $poolLib) { . $poolLib }

if (-not @(Get-CcSnapshotFiles).Count) {
    Write-Host "No saved Claude Code accounts. Run 'claude-code-add' first." -ForegroundColor Yellow
    exit 30
}

$all = @(Get-CcPool -AllowUntrusted:$AllowUntrusted)
foreach ($r in ($all | Where-Object { $_.Refused })) {
    Write-Host "! Ignoring $($r.Name): $($r.Refused)." -ForegroundColor Yellow
}
$list = @($all | Where-Object { -not $_.Refused })
if ($list.Count -lt 1) { Write-Host "No usable account snapshots in $CcStore." -ForegroundColor Yellow; exit 30 }

# -- Identify the current account ---------------------------------------------
$live = Get-CcLiveIdentity
$liveRaw = $live.Raw
if (-not $liveRaw) { Write-Host "No live Claude Code login found. Run '/login' in Claude Code." -ForegroundColor Yellow; exit 30 }
$liveToken    = $live.Token
$liveOAuthRaw = $live.OAuthRaw
$currentEmail = $live.Email
$current = Find-CcCurrent $list $live

# -- Sync-back: Claude Code rotates the refresh token, so refresh the snapshot --
# of the account the live credentials belong to before touching anything else.
# The pool entry is re-stamped with the new login: the stamp covers the tokens,
# so a rotation the switcher did itself must not read as tampering afterwards.
if ($current -and -not $DryRun) {
    try {
        $liveCreds = $liveRaw | ConvertFrom-Json
        # A snapshot saved under the wrong email carries the wrong identity for
        # good unless it is refreshed here, while its real owner is logged in.
        $identityStale = ($currentEmail -and $currentEmail -eq $current.Email -and
                          $liveOAuthRaw -and $current.Identity -ne $currentEmail)
        if (($liveCreds.claudeAiOauth.accessToken -and $liveCreds.claudeAiOauth.accessToken -ne $current.Token) -or $identityStale) {
            $keepRaw = if ($identityStale) { $liveOAuthRaw } else { $current.OAuthRaw }
            # Keep the last usage reading: it is what keeps this account
            # measurable once its snapshot token expires.
            Write-CcJsonFile $current.File (New-CcSnapshotEntry $current.Email $liveCreds $keepRaw $current.Cache)
            if (Get-Command Register-PoolEntry -ErrorAction SilentlyContinue) {
                Register-PoolEntry $current.Name $current.Email $keepRaw $liveCreds | Out-Null
            }
            $current.Creds    = $liveCreds
            $current.Token    = $liveCreds.claudeAiOauth.accessToken
            $current.OAuthRaw = $keepRaw
            if ($identityStale) { $current.Identity = $currentEmail }
            $liveToken        = $current.Token
            Say "  (refreshed the saved snapshot for $($current.Email))" DarkGray
        }
    } catch {}
}

# -- Is the current account rate limited? --------------------------------------
# Always query the LIVE token: a stale snapshot token would report the wrong
# account (or nothing at all).
$currentUsage = Get-ClaudeUsage $liveToken
if ($current -and $currentUsage -and -not $DryRun) { Save-UsageCache $current.File $currentUsage }
$cur5 = Get-Util $currentUsage 'five_hour'
$cur7 = Get-Util $currentUsage 'seven_day'
$currentName = if ($current) { $current.Email } elseif ($currentEmail) { $currentEmail } else { 'unknown account' }

# One line the watcher can read without depending on the wording of the prose
# below. -1 is "unmeasured", which is not the same as 0.
if ($Machine) {
    # Written with the invariant culture: a French locale would print "99,8",
    # which the watcher's regex would read as two numbers.
    $inv = [cultureinfo]::InvariantCulture
    Write-Output ("CCUSAGE five={0} seven={1} account={2}" -f `
        $(if ($null -ne $cur5) { ([double]$cur5).ToString($inv) } else { '-1' }),
        $(if ($null -ne $cur7) { ([double]$cur7).ToString($inv) } else { '-1' }),
        $currentName)
}

if (-not $Force) {
    if ($null -eq $cur5 -and $null -eq $cur7) {
        Write-Host "Usage unavailable for $currentName - leaving the account as is." -ForegroundColor Yellow
        exit 0
    }
    $limited = (Test-CcOverCap $cur5 $Threshold) -or (Test-CcOverCap $cur7 $WeeklyThreshold)
    if (-not $limited) {
        Say ("$currentName is fine ({0}) - no switch." -f (Format-UsagePair $currentUsage)) Green
        exit 0
    }
    $curUntil = Get-LimitedUntil $currentUsage
    $curWhen  = if ($curUntil) { "back in " + (Format-Until $curUntil) } else { '' }
    Say ("$currentName is rate limited ({0}) {1}" -f (Format-UsagePair $currentUsage), $curWhen) Yellow
}

# -- Rank the other accounts by headroom ---------------------------------------
$candidates = @()
$dupTokens = @($list | Where-Object { $_.Token } | Group-Object Token |
                Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
$badSnapshots = @()
foreach ($a in $list) {
    if ($current -and $a.File -eq $current.File) { continue }
    if ($liveToken -and $a.Token -eq $liveToken) { continue }
    # A snapshot holding someone else's login is worse than a missing account:
    # its usage reading describes the OTHER account, so switching to it would
    # land back on the exhausted login while reporting fresh quota.
    if ($a.Identity -and $a.Identity -ne $a.Email) {
        $badSnapshots += "$($a.Email) (snapshot holds $($a.Identity))"
        continue
    }
    # A snapshot carrying its own matching identity has proved whose login it
    # holds, so a shared token only condemns the ones that prove nothing.
    if (-not $a.Identity -and $a.Token -and ($dupTokens -contains $a.Token)) {
        $badSnapshots += "$($a.Email) (same login as another entry)"
        continue
    }
    # A reading taken moments ago answers the same question as a fresh HTTP
    # call, so a run that follows another one does not re-query the whole pool.
    if (Test-CcUsageCacheFresh $a.Cache) {
        $u = ConvertFrom-UsageCache $a.Cache
    } else {
        $u = Get-ClaudeUsage $a.Token
        if ($u -and -not $DryRun) { Save-UsageCache $a.File $u }
        # A dead snapshot token means no live answer; the last recorded reading
        # is still better evidence than nothing, as long as its window has not
        # reset.
        if (-not $u -and $a.Cache) {
            $c5 = ConvertTo-LocalTime $a.Cache.five_hour.resets_at
            $c7 = ConvertTo-LocalTime $a.Cache.seven_day.resets_at
            $now = Get-Date
            $u = [pscustomobject]@{
                five_hour = [pscustomobject]@{
                    utilization = if ($c5 -and $c5 -lt $now) { $null } else { $a.Cache.five_hour.utilization }
                    resets_at   = $a.Cache.five_hour.resets_at
                }
                seven_day = [pscustomobject]@{
                    utilization = if ($c7 -and $c7 -lt $now) { $null } else { $a.Cache.seven_day.utilization }
                    resets_at   = $a.Cache.seven_day.resets_at
                }
            }
        }
    }
    $u5 = Get-Util $u 'five_hour'
    $u7 = Get-Util $u 'seven_day'
    # Unknown usage is not a rejection: the snapshot's access token may simply be
    # expired while its refresh token still works. Rank those last.
    $known   = ($null -ne $u5) -or ($null -ne $u7)
    $overCap = $known -and ((Test-CcOverCap $u5 $Threshold) -or (Test-CcOverCap $u7 $WeeklyThreshold))
    $candidates += [pscustomobject]@{
        Acct = $a; Usage = $u; Five = $u5; Seven = $u7; Known = $known; Over = $overCap
        # Rank by 5h headroom; an account whose 5h window is unmeasured sits
        # between the measured ones and the fully unknown ones.
        Rank = if (-not $known) { 1000 } elseif ($null -eq $u5) { 500 } else { [double]$u5 }
    }
}

# An account with no usage reading is not proven limited, so it stays eligible -
# only accounts measured at or over a threshold are ruled out.
$free = $candidates | Where-Object { -not $_.Over } | Sort-Object Rank | Select-Object -First 1

if ($badSnapshots.Count -gt 0) {
    Write-Host ("Ignoring {0} unusable snapshot(s): {1}" -f $badSnapshots.Count, ($badSnapshots -join ', ')) -ForegroundColor Yellow
    Write-Host "Re-save each one: '/login' as that account in Claude Code, then 'claude-code-add'." -ForegroundColor Yellow
}

if (-not $free) {
    # Every saved account is out of quota: say so, name when each one comes
    # back, and leave the live credentials exactly where they are. Switching
    # here would only trade one exhausted account for another.
    Write-Host ""
    if ($candidates.Count -eq 0) {
        $why = if ($badSnapshots.Count -gt 0) { 'the other snapshots do not hold the accounts they name' }
               else { 'there is no second account saved' }
        Write-Host "No account to switch to - $why. Staying on $currentName." -ForegroundColor Red
        exit 20
    }
    Write-Host "All saved accounts are rate limited. Staying on $currentName - no switch." -ForegroundColor Red
    $soonest = $null
    $report = @([pscustomobject]@{ Email = "$currentName (current)"; Usage = $currentUsage })
    foreach ($c in $candidates) { $report += [pscustomobject]@{ Email = $c.Acct.Email; Usage = $c.Usage } }
    foreach ($r in $report) {
        $until = Get-LimitedUntil $r.Usage
        $when  = if ($until) { "free in " + (Format-Until $until) } else { '' }
        Write-Host ("  {0,-34} {1}   {2}" -f $r.Email, (Format-UsagePair $r.Usage), $when) -ForegroundColor DarkGray
        if ($until -and (-not $soonest -or $until -lt $soonest)) { $soonest = $until }
    }
    if ($soonest) {
        Write-Host ("First account back in " + (Format-Until $soonest)) -ForegroundColor Yellow
    }
    exit 20
}

if (-not $Quiet) {
    foreach ($c in ($candidates | Sort-Object Rank)) {
        $tag = if ($c.Over) { 'limited' } elseif (-not $c.Known) { 'unknown' } else { 'free   ' }
        Say ("  - {0,-34} {1}   {2}" -f $c.Acct.Email, (Format-UsagePair $c.Usage), $tag) DarkGray
    }
}
$chosen = $free.Acct

if ($DryRun) {
    Write-Host "Would switch to $($chosen.Email)." -ForegroundColor Cyan
    exit 10
}

# -- Back up the live credentials, then swap -----------------------------------
# Under the swap lock: the watcher ticks on its own schedule, and a switch
# started by hand at the same moment would interleave the backup, the write and
# the .claude.json rewrite into a login that belongs to no account.
Invoke-CcCredSwapLocked {
    Backup-CcLiveCreds $liveRaw
    Set-CcLiveCredsRaw ($chosen.Creds | ConvertTo-Json -Depth 20)
    # Keep the identity shown by /status in sync with the credentials we just wrote.
    Set-CcLiveOAuthRaw $chosen.OAuthRaw | Out-Null
} | Out-Null

Write-Host "Switched Claude Code to $($chosen.Email)." -ForegroundColor Green

# The session that hit the limit is still holding the old account's token, so
# swapping the credentials underneath it changes nothing until it restarts.
# Boite does not restart a thread on its own; the wrapper on PATH does, in the
# same pane, without touching the app.
$relaunched = $false
$noShim = $false
if (-not $NoRelaunch) {
    $relaunchScript = Join-Path $PSScriptRoot 'claude-code-relaunch.ps1'
    if ((Test-Path $relaunchScript) -and ($env:BOITE_THREAD_ID -or $VictimPid)) {
        if ($VictimPid) {
            & $relaunchScript -Delay $RestartDelay -VictimPid $VictimPid -SessionId $SessionId -AnyHost
        } else {
            & $relaunchScript -Delay $RestartDelay -SessionId $SessionId
        }
        $relaunched = ($LASTEXITCODE -eq 0)
        $noShim = ($LASTEXITCODE -eq 3)
    }
}
if ($relaunched) {
    Write-Host "Refreshing this thread on $($chosen.Email) - about a second away." -ForegroundColor Cyan
} elseif ($noShim) {
    Write-Host "! The claude wrapper is not on PATH, so this thread cannot restart itself." -ForegroundColor Yellow
    Write-Host "  Run: pwsh -NoProfile -File `"$HOME\.claude-tools\claude-code-shim.ps1`" -Install" -ForegroundColor Yellow
    Write-Host "  then restart Boite once. Until then this session still runs on the rate-limited account." -ForegroundColor Yellow
} elseif ($env:BOITE_THREAD_ID) {
    Write-Host "! Restart this Boite thread to run as $($chosen.Email) - same conversation, and this" -ForegroundColor Yellow
    Write-Host "  session still runs on the rate-limited account until you do." -ForegroundColor Yellow
} else {
    Write-Host "! Restart Claude Code ('claude --resume') - this session still holds the old login." -ForegroundColor Yellow
}
exit 10
