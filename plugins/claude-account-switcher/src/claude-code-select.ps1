# Switch the Claude Code (CLI) account on demand, without waiting for a rate
# limit and without going through /login and a browser: the saved OAuth
# credentials of the chosen account are written straight into the live
# credential store.
#
#   claude-code-select.ps1 -List                 show the pool, switch nothing
#   claude-code-select.ps1 -Email bob@x.com      switch to that account
#   claude-code-select.ps1 -Index 2              switch to the 2nd listed
#   claude-code-select.ps1 -Next                 switch to the freest other one
#   claude-code-select.ps1 -Email bob@x.com -DryRun    say what it would do
#
# Non-interactive by design: it takes the choice as an argument, so a slash
# command can call it from inside a live session (there is no stdin there).
#
# Exit codes: 0 = switched (or already there), 30 = nothing usable saved,
# 40 = no such account, 41 = that account's snapshot is not usable.

[CmdletBinding()]
param(
    [string]$Email,
    [int]$Index = 0,
    [switch]$Next,
    [switch]$List,
    [switch]$DryRun,
    [switch]$Relaunch,       # restart Claude Code on the same conversation
    [switch]$CloseCurrent,   # ...and end the session that ran this (new window only)
    [switch]$NewWindow,      # force a terminal window even inside a host app
    [switch]$NoRefresh,      # inside Boite: swap the account but leave the thread running
    [switch]$AllowUntrusted, # use snapshots that are not registered in the pool manifest
    [double]$RestartDelay = 0,  # extra seconds before the running session is ended; fractions are honoured
    [string]$SessionId,      # default: $env:CLAUDE_CODE_SESSION_ID, else newest transcript
    [string]$WorkDir         # default: where this script was started from
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')

# Snapshots are restored into the live credentials as they are, so a file that
# arrived in that folder on its own would put a stranger's account in the seat.
# The manifest says which ones were registered on purpose; with no manifest at
# all there is nothing to check against and every snapshot is taken as it was
# before the check existed.
$poolLib = Join-Path $PSScriptRoot 'claude-cc-pool.ps1'
if (Test-Path $poolLib) { . $poolLib }

# A refresh that never came back is worth one line here rather than a silent
# entry in a log file nobody opens.
Show-CcRelaunchFailure

# -- Load the pool -------------------------------------------------------------
# Refused snapshots keep their place in the list: the numbering behind -Index
# has to mean the same thing from one run to the next, and an entry that
# vanished silently would be blamed on the switcher.
if (-not @(Get-CcSnapshotFiles).Count) {
    Write-Host "No saved Claude Code accounts in $CcStore." -ForegroundColor Yellow
    Write-Host "Run 'claude-code-add' while logged in to save the current account." -ForegroundColor Yellow
    exit 30
}

$pool = @(Get-CcPool -AllowUntrusted:$AllowUntrusted)
$usable = @($pool | Where-Object { -not $_.Refused })
if ($usable.Count -lt 1) {
    Write-Host "No usable account snapshots in $CcStore." -ForegroundColor Yellow
    foreach ($r in ($pool | Where-Object { $_.Refused })) {
        Write-Host "  $($r.Name): $($r.Refused)" -ForegroundColor Yellow
    }
    Write-Host "Register a snapshot with 'claude-code-add' after /login, or force it with -AllowUntrusted." -ForegroundColor Yellow
    exit 30
}

# -- Who is live right now -----------------------------------------------------
$live         = Get-CcLiveIdentity
$liveRaw      = $live.Raw
$liveToken    = $live.Token
$liveOAuthRaw = $live.OAuthRaw
$liveEmail    = $live.Email
$current      = Find-CcCurrent $usable $live

# -- Sync-back before anything else --------------------------------------------
# Claude Code rotates its refresh token on every refresh, which invalidates the
# previous one server-side: switching away without saving the live credentials
# first would log the current account out for good. The stored identity is
# refreshed at the same time, from the live one, so a snapshot that was saved
# under the wrong email heals itself the first time its real owner is logged in.
# The pool entry is re-stamped with it: the stamp covers the login, so a
# rotation the switcher did itself must not read as tampering afterwards.
if ($current -and $liveRaw -and -not $DryRun) {
    try {
        $liveCreds = $liveRaw | ConvertFrom-Json
        $identityStale = ($liveEmail -and $liveEmail -eq $current.Email -and
                          $liveOAuthRaw -and $current.Identity -ne $liveEmail)
        if (($liveCreds.claudeAiOauth.accessToken -and $liveCreds.claudeAiOauth.accessToken -ne $current.Token) -or $identityStale) {
            $keepRaw = if ($identityStale) { $liveOAuthRaw } else { $current.OAuthRaw }
            Write-CcJsonFile $current.File (New-CcSnapshotEntry $current.Email $liveCreds $keepRaw $current.Cache)
            if (Get-Command Register-PoolEntry -ErrorAction SilentlyContinue) {
                Register-PoolEntry $current.Name $current.Email $keepRaw $liveCreds | Out-Null
            }
            $current.Creds    = $liveCreds
            $current.Token    = $liveCreds.claudeAiOauth.accessToken
            $current.OAuthRaw = $keepRaw
            if ($identityStale) {
                $heldBefore = if ($current.Identity) { $current.Identity } else { 'an unidentified account' }
                $current.Identity = $liveEmail
                Write-Host "  (repaired the saved snapshot for $($current.Email) - it held $heldBefore's login)" -ForegroundColor DarkGray
            }
            # The ordinary refresh is silent: it happens on every switch and
            # saying so each time only costs the reader (and the agent) tokens.
        }
    } catch {}
}

# -- Health of each snapshot ---------------------------------------------------
# A snapshot proving its own identity is trustworthy even if another file holds
# a copy of the same login; only the ones that prove nothing are ambiguous.
$dupTokens = @($usable | Where-Object { $_.Token } | Group-Object Token |
                Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
foreach ($a in $pool) {
    $bad = $null
    if ($a.Refused) { $bad = $null }
    elseif ($a.Identity -and $a.Identity -ne $a.Email) { $bad = "holds $($a.Identity)'s login" }
    elseif (-not $a.Identity -and $a.Token -and ($dupTokens -contains $a.Token)) { $bad = 'same login as another entry' }
    $a | Add-Member -NotePropertyName Problem -NotePropertyValue $bad -Force
    $a | Add-Member -NotePropertyName Current -NotePropertyValue ($current -and $a.File -eq $current.File) -Force
}

# A reading taken moments ago is reused rather than asked for again: -List used
# to make one HTTP call per account every time it ran.
function Get-PoolUsage($account) {
    if ($account.Refused) { return $null }
    $token = if ($account.Current -and $liveToken) { $liveToken } else { $account.Token }
    if ((Test-CcUsageCacheFresh $account.Cache) -and -not $account.Current) {
        return (ConvertFrom-UsageCache $account.Cache)
    }
    $u = Get-ClaudeUsage $token
    if ($u -and -not $DryRun) { Save-UsageCache $account.File $u }
    if (-not $u -and $account.Cache) { return (ConvertFrom-UsageCache $account.Cache) }
    return $u
}

# -- -List ---------------------------------------------------------------------
if ($List) {
    Write-Host ""
    Write-Host "=== Claude Code accounts ($($pool.Count)) ===" -ForegroundColor Cyan
    for ($i = 0; $i -lt $pool.Count; $i++) {
        $a = $pool[$i]
        $mark = if ($a.Current) { '*' } else { ' ' }
        if ($a.Refused) {
            Write-Host ("  [{0}] {1} {2,-32} refused" -f ($i + 1), $mark, $a.Email) -ForegroundColor DarkYellow
            Write-Host "        $($a.Refused)" -ForegroundColor DarkYellow
            continue
        }
        $u = Get-PoolUsage $a
        $usage = Format-UsagePair $u
        $color = if ($a.Problem) { 'Red' } elseif ($a.Current) { 'Green' } else { 'Gray' }
        Write-Host ("  [{0}] {1} {2,-32} {3}" -f ($i + 1), $mark, $a.Email, $usage) -ForegroundColor $color
        if ($a.Problem) { Write-Host "        unusable: $($a.Problem)" -ForegroundColor DarkYellow }
    }
    Write-Host ""
    Write-Host "  (* = current)   switch with: -Email <address> | -Index <n> | -Next" -ForegroundColor DarkGray
    exit 0
}

# -- Resolve the target --------------------------------------------------------
$target = $null
if ($Email) {
    $target = $pool | Where-Object { $_.Email -eq $Email } | Select-Object -First 1
    if (-not $target) {
        # Not $matches: that name is PowerShell's own regex-capture variable.
        $hits = @($pool | Where-Object { $_.Email -like "*$Email*" })
        if ($hits.Count -eq 1) { $target = $hits[0] }
        elseif ($hits.Count -gt 1) {
            Write-Host "'$Email' matches several accounts: $($hits.Email -join ', ')" -ForegroundColor Red
            exit 40
        }
    }
    if (-not $target) {
        Write-Host "No saved account matching '$Email'. Saved: $($pool.Email -join ', ')" -ForegroundColor Red
        exit 40
    }
} elseif ($Index -gt 0) {
    if ($Index -gt $pool.Count) {
        Write-Host "There are only $($pool.Count) saved accounts." -ForegroundColor Red
        exit 40
    }
    $target = $pool[$Index - 1]
} elseif ($Next) {
    # Freest other account, measured now; an unreadable one ranks last rather
    # than being ruled out, since its token may simply have expired.
    $others = @($pool | Where-Object { -not $_.Current -and -not $_.Problem -and -not $_.Refused })
    if ($others.Count -eq 0) {
        Write-Host "No other usable account to switch to." -ForegroundColor Red
        exit 40
    }
    $ranked = foreach ($a in $others) {
        $u5 = Get-Util (Get-PoolUsage $a) 'five_hour'
        [pscustomobject]@{ Acct = $a; Rank = if ($null -eq $u5) { 1000 } else { $u5 } }
    }
    $target = ($ranked | Sort-Object Rank | Select-Object -First 1).Acct
} else {
    Write-Host "Pick an account: -Email <address>, -Index <n>, or -Next. Use -List to see them." -ForegroundColor Yellow
    exit 40
}

if ($target.Refused) {
    Write-Host "Cannot switch to $($target.Email): $($target.Refused)." -ForegroundColor Red
    Write-Host "Re-save it ('/login' as that account, then 'claude-code-add'), or force it with -AllowUntrusted." -ForegroundColor Yellow
    exit 41
}

# A snapshot that holds someone else's login would silently switch to the WRONG
# account, so it is refused instead of restored.
if ($target.Problem) {
    Write-Host "Cannot switch to $($target.Email): its saved snapshot $($target.Problem)." -ForegroundColor Red
    Write-Host "Log in as $($target.Email) once ('/login'), then run 'claude-code-add' to re-save it." -ForegroundColor Yellow
    exit 41
}

if ($target.Current -or ($target.Token -and $target.Token -eq $liveToken)) {
    Write-Host "Already logged in as $($target.Email)." -ForegroundColor Green
    exit 0
}

if ($DryRun) {
    Write-Host "Would switch from $(if ($current) { $current.Email } else { $liveEmail }) to $($target.Email)." -ForegroundColor Cyan
    exit 0
}

# Under the swap lock, so this and a watcher tick cannot interleave their writes
# into a login that belongs to no account.
Invoke-CcCredSwapLocked {
    Backup-CcLiveCreds $liveRaw
    Set-CcLiveCredsRaw ($target.Creds | ConvertTo-Json -Depth 20)
    # Claude Code shows the account from oauthAccount in .claude.json, not from
    # the token, so /status keeps naming the old account unless this moves too.
    Set-CcLiveOAuthRaw $target.OAuthRaw | Out-Null
} | Out-Null

Write-Host "Switched Claude Code to $($target.Email)." -ForegroundColor Green

if (-not $Relaunch) {
    if ($env:BOITE_THREAD_ID) {
        Write-Host "! Restart this Boite thread to run as $($target.Email) - it still holds the old login." -ForegroundColor Yellow
    } else {
        Write-Host "! Restart the session ('claude --resume') - it still holds the old login." -ForegroundColor Yellow
    }
    exit 0
}

# -- Relaunch on the same conversation -----------------------------------------
# A running Claude Code process cannot adopt the new credentials: it read them
# once at startup and holds the access token in memory for hours. The only way
# to continue the SAME conversation as the new account is a fresh process on
# `claude --resume <session>`, which is what this does - the transcripts under
# ~/.claude/projects are shared between accounts, so nothing is lost.
if (-not $WorkDir) { $WorkDir = (Get-Location).Path }

# Claude Code names a project's transcript folder after its path, with every
# character that is not a letter or a digit turned into a dash.
$slug        = ($WorkDir -replace '[^A-Za-z0-9]', '-')
$projectDir  = Join-Path (Join-Path $HOME '.claude') (Join-Path 'projects' $slug)

# Claude Code exports its own session id to everything it runs, so when this
# script was launched from inside a session there is nothing to guess.
if (-not $SessionId -and $env:CLAUDE_CODE_SESSION_ID) { $SessionId = $env:CLAUDE_CODE_SESSION_ID }
if (-not $SessionId) {
    $newest = Get-ChildItem $projectDir -Filter '*.jsonl' -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) { $SessionId = $newest.BaseName }
}

# Ending the session from inside itself would kill this script mid-sentence and
# swallow whatever the agent was still writing, so the kill is handed to a
# detached process that waits first.
# Created with SW_HIDE rather than hidden after the fact: -WindowStyle Hidden
# only takes effect once PowerShell is up, which is long enough for a console
# window to flash over whatever the user is doing.
function Start-DelayedStop([int]$targetPid, [double]$delay) {
    $ms = [int][Math]::Round($delay * 1000)
    $inner = "Start-Sleep -Milliseconds $ms; Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue"
    $exe = (Get-Process -Id $PID).Path
    if (-not $exe) { $exe = 'pwsh' }
    Start-CcDetached $exe ('-NoProfile -WindowStyle Hidden -Command "{0}"' -f $inner) | Out-Null
}

# -- Inside Boite: the app owns the terminal ------------------------------------
# Boite starts each thread itself as `claude --resume <session>`, so there is no
# window to open: ending the process is the restart. The thread comes back on
# the same conversation, and that new process reads the credentials written
# above. Opening a terminal window here would put the session outside the app.
if ($env:BOITE_THREAD_ID -and -not $NewWindow) {
    # One command, two moves: the account is swapped and the thread's process is
    # restarted in place by the wrapper on PATH - same pane, same conversation,
    # the app untouched. -NoRefresh stops after the swap.
    # NOT $relaunch: that is the -Relaunch parameter, and a path in a [switch] throws.
    $relaunchScript = Join-Path $PSScriptRoot 'claude-code-relaunch.ps1'
    if (-not $NoRefresh -and (Test-Path $relaunchScript)) {
        & $relaunchScript -Delay $RestartDelay
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Refreshing this thread on $($target.Email) - about a second away." -ForegroundColor Cyan
            exit 0
        }
        if ($LASTEXITCODE -eq 3) {
            # Ending the process without the wrapper in front of it would stop
            # the thread for good, so it is left running on the old token.
            Write-Host "! The claude wrapper is not on PATH, so this thread cannot restart itself." -ForegroundColor Yellow
            Write-Host "  Run: pwsh -NoProfile -File `"$HOME\.claude-tools\claude-code-shim.ps1`" -Install" -ForegroundColor Yellow
            Write-Host "  then restart Boite once. Until then this session still runs on the old account." -ForegroundColor Yellow
            exit 0
        }
    }
    # The running process keeps the token it loaded at startup, so until the
    # thread is restarted every request still bills the account we just left.
    Write-Host "! Restart this Boite thread to run as $($target.Email) - same conversation, and this" -ForegroundColor Yellow
    Write-Host "  session still runs on the old account until you do." -ForegroundColor Yellow
    exit 0
}

# Without a session id `claude --resume` opens its own picker, which is a fine
# fallback: the account has already been switched either way.
$resumeCmd = if ($SessionId) { "claude --resume $SessionId" } else { 'claude --resume' }

$launched = $false
try {
    $inner = "Set-Location -LiteralPath '$($WorkDir -replace "'", "''")'; $resumeCmd"
    $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
    if ($wt) {
        Start-Process $wt.Source -ArgumentList @('-w', '0', 'nt', 'pwsh', '-NoProfile', '-NoExit', '-Command', $inner)
    } else {
        # Through conhost, not straight to pwsh: started from inside a
        # pseudo-console - Boite, Windows Terminal, anything that owns the
        # terminal - a console program inherits that pseudo-console and never
        # gets a window of its own. conhost gives it one.
        Start-Process 'conhost.exe' -ArgumentList @('pwsh', '-NoProfile', '-NoExit', '-Command', $inner)
    }
    $launched = $true
} catch {
    Write-Host "Could not open a new window: $($_.Exception.Message)" -ForegroundColor Red
}

if ($launched) {
    Write-Host "Opened a new session as $($target.Email) on: $resumeCmd" -ForegroundColor Cyan
    if (-not $SessionId) {
        Write-Host "No transcript found under $projectDir - pick the conversation in the resume list." -ForegroundColor DarkYellow
    }
}

# The old process is still alive and still running as the previous account, so
# anything typed there would bill the account we just left.
if ($launched -and $CloseCurrent) {
    $victim = Get-HostSessionPid
    if ($victim) {
        Write-Host "Closing the previous session (pid $victim)." -ForegroundColor DarkGray
        Start-DelayedStop $victim $RestartDelay
    } else {
        Write-Host "Could not find the Claude Code process to close - close that window yourself." -ForegroundColor DarkYellow
    }
} elseif ($launched) {
    Write-Host "The old window still runs as the previous account - close it." -ForegroundColor DarkGray
}
exit 0
