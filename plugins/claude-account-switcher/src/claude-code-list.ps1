# List the Claude Code accounts saved in the switcher pool, with their usage.
#
# Read-only companion to claude-code-auto.ps1: it never writes credentials, so
# it is safe to run at any time, including from inside a live Claude Code
# session.
#
#   claude-code-list.ps1            table with usage and reset times
#   claude-code-list.ps1 -NoUsage   offline listing (no network call)
#   claude-code-list.ps1 -Json      machine-readable output
#
# Exit codes: 0 = listed, 30 = no saved accounts.

[CmdletBinding()]
param(
    [switch]$NoUsage,   # skip the usage API calls
    [switch]$CacheOnly, # report the recorded usage, however old, without calling the API
    [switch]$Json       # emit JSON instead of a table
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')

$poolLib   = Join-Path $PSScriptRoot 'claude-cc-pool.ps1'
if (Test-Path $poolLib) { . $poolLib }

function Format-Reset($u) {
    if (-not $u) { return '' }
    $parts = @()
    $r5 = ConvertTo-LocalTime $u.five_hour.resets_at
    if ($r5) {
        $d = $r5 - (Get-Date)
        # Format-CcWait, not a local format: [int] on TotalHours ROUNDS in
        # PowerShell, so 2h39 came out as "3h39m" - an hour off, and one hour
        # away from the "available in" countdown computed from the same date.
        if ($d.TotalSeconds -gt 0) { $parts += "5h resets in " + (Format-CcWait $d) }
    }
    $r7 = ConvertTo-LocalTime $u.seven_day.resets_at
    if ($r7) { $parts += "7d resets $($r7.ToString('ddd MMM d, HH:mm'))" }
    return ($parts -join '   |   ')
}

function Format-Age($when) {
    $t = ConvertTo-LocalTime $when
    if (-not $t) { return 'unknown age' }
    $d = (Get-Date) - $t
    if ($d.TotalMinutes -lt 1) { return 'just now' }
    # Floor, not [int]: the cast rounds, and a reading 50 minutes old must not
    # announce itself as "1h ago".
    if ($d.TotalHours -lt 1)   { return "{0}m ago" -f [int][math]::Floor($d.TotalMinutes) }
    if ($d.TotalDays -lt 1)    { return "{0}h ago" -f [int][math]::Floor($d.TotalHours) }
    return "{0}d ago" -f [int][math]::Floor($d.TotalDays)
}

# A quota window that has already reset makes its cached percentage meaningless:
# the number describes a window that no longer exists.
function Test-WindowExpired($resetsAt) {
    $t = ConvertTo-LocalTime $resetsAt
    if (-not $t) { return $false }
    return ($t -lt (Get-Date))
}

# -- Saved accounts ------------------------------------------------------------
$files = @(Get-CcSnapshotFiles)

# Who is logged in right now, whether or not that account was ever saved.
$live         = Get-CcLiveIdentity
$liveRaw      = $live.Raw
$liveToken    = $live.Token
$liveOAuthRaw = $live.OAuthRaw
$liveEmail    = $live.Email

if (-not $files.Count) {
    if ($Json) {
        [pscustomobject]@{ accounts = @(); liveEmail = $liveEmail; store = $CcStore } | ConvertTo-Json -Depth 5
    } else {
        Write-Host "No saved Claude Code accounts in $CcStore." -ForegroundColor Yellow
        if ($liveEmail) { Write-Host "Logged in as $liveEmail - run 'claude-code-add' to save it." -ForegroundColor Yellow }
        else { Write-Host "Run '/login' in Claude Code, then 'claude-code-add'." -ForegroundColor Yellow }
    }
    exit 30
}

# The switcher refuses a snapshot the manifest does not vouch for, so this list
# shows the same verdict - an entry that reads as healthy here and is then
# refused at switch time is the confusing case. Every row is kept, refused or
# not: this is the inventory, not the set of switch targets.
$saved = @(Get-CcPool -AllowUntrusted)

# -- Snapshots that are not the account they claim to be -----------------------
# Two rows showing the SAME percentages is the visible symptom of one snapshot
# holding another account's login (saving account X under email Y, or re-running
# claude-code-add without a /login in between). Querying such a row would report
# X's quota under Y's name, so it is not queried at all: a wrong number is worse
# than a missing one, because the auto-switcher trusts these readings.
# A snapshot carrying its own matching identity is proof of whose login it holds,
# so a shared token only condemns the entries that cannot prove anything.
$dupTokens = @($saved | Where-Object { $_.Token } | Group-Object Token |
                Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })

# Which saved account the live login belongs to, decided once so exactly one row
# can wear the marker. Token match is the reliable test, but it fails routinely:
# Claude Code rotates the token on every refresh and on every /login, so a
# snapshot goes stale while still describing the right account. The email in
# .claude.json is then the fallback - the same rule claude-code-auto.ps1 uses.
$currentFile = $null
if ($liveToken) {
    $currentFile = ($saved | Where-Object { $_.Token -eq $liveToken } | Select-Object -First 1).File
}
if (-not $currentFile -and $liveEmail) {
    $currentFile = ($saved | Where-Object { $_.Json.email -eq $liveEmail } | Select-Object -First 1).File
}

$rows = @()
foreach ($s in $saved) {
    $j       = $s.Json
    $token   = $s.Token
    $current = ($s.File -eq $currentFile)

    # NOT $status: dot-sourcing claude-cc-pool.ps1 brings its own [switch]$Status
    # into this scope, and assigning a string to it fails the whole script.
    $rowStatus = 'ok'
    if ($s.Trust -eq 'sealed') {
        $rowStatus = 'sealed'
    } elseif ($s.Trust -eq 'unknown' -or $s.Trust -eq 'changed' -or $s.Trust -eq 'nokey') {
        $rowStatus = $s.Trust
    } elseif ($s.Identity -and $s.Identity -ne $j.email) {
        $rowStatus = 'mislabeled'
    } elseif (-not $s.Identity -and $token -and ($dupTokens -contains $token)) {
        # Shares a login with another entry and carries nothing to prove it is
        # the account it names.
        $rowStatus = 'duplicate'
    }

    # The live token is the fresh one and belongs to the account Claude Code is
    # logged into right now, so on the current row it outranks the snapshot -
    # including a snapshot that turned out to hold someone else's login.
    $usageToken = if ($current -and $liveToken) { $liveToken } else { $token }
    $queryable  = ($current -and $liveToken) -or ($rowStatus -eq 'ok')

    # A reading taken moments ago answers the same question as a fresh HTTP
    # call; listing the pool twice in a row must not cost one call per account.
    $cached   = $false
    $cacheAge = ''
    $u        = $null
    if ($queryable -and $CacheOnly) {
        # Whatever was recorded last, at any age: the caller asked for a reading
        # that costs nothing and works offline.
        if ($s.Cache) {
            $u        = ConvertFrom-UsageCache $s.Cache
            $cached   = $true
            $cacheAge = Format-Age $s.Cache.checkedAt
        }
    } elseif ($queryable -and -not $NoUsage -and (Test-CcUsageCacheFresh $s.Cache) -and -not $current) {
        $u = ConvertFrom-UsageCache $s.Cache
        $cached = $true
        $cacheAge = Format-Age $s.Cache.checkedAt
    } elseif ($queryable -and -not $NoUsage) {
        $u = Get-ClaudeUsage $usageToken
        # A live answer is recorded so this account stays measurable after its
        # token expires; a dead one falls back to whatever was recorded last.
        if ($u) {
            Save-UsageCache $s.File $u
        } elseif ($s.Cache) {
            $u        = ConvertFrom-UsageCache $s.Cache
            $cached   = $true
            $cacheAge = Format-Age $s.Cache.checkedAt
        }
    }

    $expires = $null
    if ($s.Creds) {
        try {
            $ms = [double]$s.Creds.claudeAiOauth.expiresAt
            if ($ms -gt 0) { $expires = [datetimeoffset]::FromUnixTimeMilliseconds([long]$ms).LocalDateTime }
        } catch {}
    }

    # A cached percentage for a window that has already rolled over describes a
    # window that no longer exists, so it is dropped rather than shown as fact.
    # An absent reading has to stay absent: 0 would read as "completely free".
    # The decimal is kept - the weekly cap is 99.8%, so rounding to the unit
    # turns a usable account into a full one and back.
    $five  = if ($u -and $null -ne $u.five_hour.utilization)  { [math]::Round([double]$u.five_hour.utilization, 1) }  else { $null }
    $seven = if ($u -and $null -ne $u.seven_day.utilization) { [math]::Round([double]$u.seven_day.utilization, 1) } else { $null }
    if ($cached) {
        if (Test-WindowExpired $u.five_hour.resets_at)  { $five  = $null }
        if (Test-WindowExpired $u.seven_day.resets_at) { $seven = $null }
    }

    # How long until the switcher would take this account again. Computed from
    # the same reading the row shows, so the countdown and the "usable no" next
    # to it always describe the same windows.
    $ready     = Get-CcReadyAt $u
    $readyAt   = if ($ready) { $ready.At } else { $null }
    $readyIn   = if ($readyAt) { [int][math]::Max(1, [math]::Round(($readyAt - (Get-Date)).TotalMinutes)) } else { $null }

    $rows += [pscustomobject]@{
        Email     = $j.email
        Current   = [bool]$current
        Status    = $rowStatus
        Identity  = $s.Identity
        Five      = $five
        Seven     = $seven
        # "Can the switcher move to it right now": the same rule claude-code-auto
        # applies (5h under 99%, week under 99.8%), plus the snapshot being sound
        # - a sealed or unregistered entry is refused whatever its quota says.
        # An unread window is not proof of a full one, so it stays usable.
        Usable    = ($rowStatus -eq 'ok') -and (Test-CcUsable $five $seven)
        Cached    = $cached
        CacheAge  = $cacheAge
        Reset     = if ($cached -and $null -eq $five -and $null -eq $seven) { '' } else { Format-Reset $u }
        # Blocked accounts only: when the switcher takes this one again, as a
        # moment and as a number of minutes from now. Both are $null when the
        # account is usable; ReadyIn alone is $null when the wait cannot be timed
        # because a full window reported no reset time.
        ReadyAt   = $readyAt
        ReadyIn   = $readyIn
        ReadyUnknown = [bool]($ready -and -not $readyAt)
        SavedAt   = $j.savedAt
        ExpiresAt = $expires
        HasIdentity = [bool]$j.oauthAccountRaw
        Protected = $s.Protected
        File      = $s.File
    }
}

if ($Json) {
    [pscustomobject]@{ accounts = $rows; liveEmail = $liveEmail; store = $CcStore } | ConvertTo-Json -Depth 5
    exit 0
}

Write-Host ""
Write-Host "=== Saved Claude Code accounts ($($rows.Count)) ===" -ForegroundColor Cyan
Write-Host "    $CcStore" -ForegroundColor DarkGray
Write-Host ""
function Format-Pct($v) { return Format-CcPct $v }

foreach ($r in ($rows | Sort-Object @{ Expression = { -not $_.Current } }, Email)) {
    $mark  = if ($r.Current) { '*' } else { ' ' }
    # Usage wins the main column whenever there is a reading to show - a broken
    # snapshot is reported underneath, not instead of the numbers.
    $usage = switch ($true) {
        (($null -ne $r.Five) -or ($null -ne $r.Seven)) {
            $t = "5h {0} / 7d {1} used" -f (Format-Pct $r.Five), (Format-Pct $r.Seven)
            if ($r.Cached) { $t += " (last reading $($r.CacheAge))" }
            $t; break
        }
        ($r.Status -eq 'mislabeled') { "MISLABELED - holds $($r.Identity)'s login"; break }
        ($r.Status -eq 'duplicate')  { 'DUPLICATE - same login as another entry';  break }
        ($r.Status -eq 'sealed')     { 'SEALED - encrypted for another user/machine'; break }
        ($r.Status -eq 'unknown')    { 'UNREGISTERED - not in the pool manifest';  break }
        ($r.Status -eq 'changed')    { 'CHANGED - does not match its registration'; break }
        ($r.Status -eq 'nokey')      { 'UNVERIFIED - the pool key cannot be read'; break }
        ($NoUsage -eq $true)         { 'usage not checked';                        break }
        ($CacheOnly -eq $true)       { 'usage never recorded';                     break }
        default { if ($r.Cached) { 'quota windows reset since last reading' } else { 'usage n/a - never read' } }
    }
    $color = if ($r.Status -ne 'ok') { 'Red' } elseif ($r.Current) { 'Green' } else { 'Gray' }
    # The usable cell is coloured on its own, so it is answered at a glance
    # without reading the two percentages next to it.
    Write-Host ("  {0} {1,-34} " -f $mark, $r.Email) -NoNewline -ForegroundColor $color
    Write-Host ("usable {0,-3}  " -f $(if ($r.Usable) { 'yes' } else { 'no' })) -NoNewline `
        -ForegroundColor $(if ($r.Usable) { 'Green' } else { 'Red' })
    Write-Host $usage -ForegroundColor $color
    # The one number a blocked row is missing: not when a window resets, but
    # when the account itself is a switch target again - the later of its two
    # windows, which is not something to work out by reading the line below.
    # Quota is the only thing a wait repairs: a sealed or unregistered snapshot
    # stays refused at 0%, so it gets the diagnosis below and no countdown.
    if ($r.Status -eq 'ok' -and -not $r.Usable -and $r.ReadyAt) {
        Write-Host ("      available in {0}  (at {1})" -f `
            (Format-CcWait ($r.ReadyAt - (Get-Date))), ([datetime]$r.ReadyAt).ToString('HH:mm')) -ForegroundColor Yellow
    } elseif ($r.Status -eq 'ok' -and -not $r.Usable -and $r.ReadyUnknown) {
        Write-Host "      available in ? - a full window reported no reset time" -ForegroundColor DarkGray
    }
    if ($r.Reset) { Write-Host ("      $($r.Reset)") -ForegroundColor DarkGray }
    if ($r.Status -eq 'mislabeled') {
        $what = if ($r.Current) { "the numbers above are live, but the SAVED login in this entry is $($r.Identity)'s" }
                else { "not $($r.Email)'s quota - the saved login is $($r.Identity)'s" }
        Write-Host "      $what - re-run 'claude-code-add' while logged in as $($r.Email)" -ForegroundColor DarkYellow
    } elseif ($r.Status -eq 'duplicate') {
        Write-Host "      re-save it: '/login' as $($r.Email), then 'claude-code-add'" -ForegroundColor DarkYellow
    } elseif ($r.Status -eq 'sealed') {
        Write-Host "      DPAPI cannot open it here - re-save it on this machine as this user" -ForegroundColor DarkYellow
    } elseif ($r.Status -eq 'unknown' -or $r.Status -eq 'changed') {
        Write-Host "      switching refuses it - adopt it with 'claude-cc-pool.ps1 -Adopt' if you put it there" -ForegroundColor DarkYellow
    } elseif ($r.Status -eq 'nokey') {
        Write-Host "      the manifest key is unreadable for this user - re-save the pool with 'claude-code-add'" -ForegroundColor DarkYellow
    } elseif (-not $r.HasIdentity) {
        Write-Host "      no cached identity - switch to it once and re-run 'claude-code-add' so /status shows the right email" -ForegroundColor DarkYellow
    }
}
Write-Host ""
Write-Host ("  (* = currently logged in   |   usable = the switcher accepts it: 5h < {0}, week < {1})" -f (Format-CcPct $CcThreshold 0), (Format-CcPct $CcWeeklyThreshold 0)) -ForegroundColor DarkGray
Write-Host "  (lower % = more headroom   |   ? = window unread, which does not block a switch)" -ForegroundColor DarkGray

# When there is nowhere to switch to, the question stops being "how full is
# each account" and becomes "how long do I wait": the pool comes back when its
# earliest account does, so that one account is what gets named and timed.
# Accounts refused for a reason a reset cannot fix (mislabeled, unregistered,
# sealed) are left out - no amount of waiting makes them switch targets.
$switchTargets = @($rows | Where-Object { -not $_.Current })
if ($switchTargets.Count) {
    $free = @($switchTargets | Where-Object { $_.Usable })
    if ($free.Count) {
        Write-Host ""
        Write-Host ("  Another account is available NOW: {0}" -f ($free[0].Email)) -ForegroundColor Green
    } else {
        $next = @($switchTargets | Where-Object { $_.Status -eq 'ok' -and $_.ReadyAt } |
                  Sort-Object ReadyAt | Select-Object -First 1)
        Write-Host ""
        if ($next.Count) {
            Write-Host ("  Next account available in {0} - {1} (at {2})" -f `
                (Format-CcWait ($next[0].ReadyAt - (Get-Date))), $next[0].Email,
                ([datetime]$next[0].ReadyAt).ToString('ddd HH:mm')) -ForegroundColor Yellow
        } else {
            Write-Host "  No other account is available, and none of them reported when that changes." -ForegroundColor Yellow
        }
    }
}

# A bad snapshot is not a display glitch: claude-code-auto ranks accounts by
# these readings, so an entry pointing at another account can send a rate-limit
# switch straight back to the account that ran out.
$bad = @($rows | Where-Object { $_.Status -ne 'ok' })
if ($bad.Count -gt 0) {
    Write-Host ""
    Write-Host "$($bad.Count) snapshot(s) are not usable for switching - see the note under each." -ForegroundColor Yellow
}

# A snapshot stored as plain JSON holds a working login in a readable file, so
# it is worth naming even when everything else about it is healthy.
$plain = @($saved | Where-Object { -not $_.Protected })
if ($plain.Count -gt 0 -and (Test-CcDpapi)) {
    Write-Host ""
    Write-Host "$($plain.Count) snapshot(s) store their login as plain JSON: $($plain.Name -join ', ')" -ForegroundColor Yellow
    Write-Host "Encrypt them for this Windows user: pwsh -NoProfile -File `"$PSScriptRoot\claude-cc-pool.ps1`" -Protect" -ForegroundColor Yellow
}

# An account logged in but never saved is the one thing this list cannot show as
# a row, and it is exactly the case that breaks a later switch.
if ($liveEmail -and -not ($rows | Where-Object { $_.Current })) {
    Write-Host ""
    Write-Host "Logged in as $liveEmail, which is NOT in the pool - run 'claude-code-add' to save it." -ForegroundColor Yellow
}
exit 0
