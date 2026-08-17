# Diagnostics for the Claude Code (CLI) account switcher: which platform and
# credential backend were detected, whether a live login is found, which
# snapshots are saved and whether each one is trusted, encrypted and usable, and
# whether the wrapper that refreshes a Boite thread in place is in front of the
# PATH.
#
# Read-only: it writes nothing and switches nothing.
#
# Cross-platform (Windows / Linux / macOS) - on Unix run with PowerShell (pwsh).

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')
$poolLib = Join-Path $PSScriptRoot 'claude-cc-pool.ps1'
if (Test-Path $poolLib) { . $poolLib }

$PlatformLinux = $false
if (Test-Path variable:IsLinux) { $PlatformLinux = $IsLinux }
$osName = if ($CcPlatformMac) { 'macOS' } elseif ($PlatformLinux) { 'Linux' } elseif ($CcPlatformWin) { 'Windows' } else { 'Unknown' }

function Show-Line($label, $value, $color) {
    if (-not $color) { $color = 'Gray' }
    Write-Host ("  {0,-22}" -f $label) -NoNewline
    Write-Host $value -ForegroundColor $color
}

$problems = @()

Write-Host ""
Write-Host "=== Claude Code switcher - doctor ===" -ForegroundColor Cyan
Write-Host ""

# -- Environment ---------------------------------------------------------------
Show-Line "Platform"        $osName
Show-Line "PowerShell"      $PSVersionTable.PSVersion.ToString()
Show-Line "Home"            $HOME

# -- Credential backend --------------------------------------------------------
if ($CcPlatformMac) {
    Show-Line "Credential backend" "macOS Keychain ($CcKeychainService)"
    $hasSecurity = [bool](Get-Command security -ErrorAction SilentlyContinue)
    Show-Line "security CLI"  $(if ($hasSecurity) { "found" } else { "MISSING" }) $(if ($hasSecurity) { 'Green' } else { 'Red' })
    if (-not $hasSecurity) { $problems += "the 'security' CLI is missing, so the Keychain cannot be read" }
} else {
    Show-Line "Credential backend" "file"
    Show-Line "Credential file" $CcCredFile
}
Show-Line "Claude Code config" $(if ($CcConfigFile) { $CcConfigFile } else { 'not found' }) $(if ($CcConfigFile) { 'Gray' } else { 'Yellow' })

# DPAPI is what keeps a saved login from being a readable file; without it the
# snapshots are plain JSON and that is worth saying out loud.
if ($CcPlatformWin) {
    $dpapi = Test-CcDpapi
    Show-Line "Login encryption" $(if ($dpapi) { 'DPAPI (this Windows user)' } else { 'UNAVAILABLE - snapshots stay plain JSON' }) $(if ($dpapi) { 'Green' } else { 'Yellow' })
}

# -- Live login ----------------------------------------------------------------
$live         = Get-CcLiveIdentity
$raw          = $live.Raw
$liveToken    = $live.Token
$liveOAuthRaw = $live.OAuthRaw
$liveEmail    = $live.Email

if ($raw) {
    $tail = if ($liveToken) { " (token ...{0})" -f $liveToken.Substring([Math]::Max(0, $liveToken.Length - 6)) } else { '' }
    Show-Line "Live login"     "detected$tail" 'Green'
    Show-Line "Logged in as"   $(if ($liveEmail) { $liveEmail } else { 'unknown (no oauthAccount in the config)' }) $(if ($liveEmail) { 'Green' } else { 'Yellow' })
} else {
    $hint = if ($CcPlatformMac) { "no Keychain item - run /login in Claude Code" } else { "not logged in - run /login in Claude Code" }
    Show-Line "Live login"     "none ($hint)" 'Yellow'
    $problems += 'no live login: run /login in Claude Code'
}

# -- Saved accounts ------------------------------------------------------------
Write-Host ""
Show-Line "Accounts folder"  $CcStore
$poolKey = Join-Path $CcStore '.pool.key'
$manifest = Join-Path $CcStore '.pool.json'
$keyState = if (-not (Test-Path $poolKey)) { 'none yet' }
            elseif ((Get-Command Get-PoolKey -ErrorAction SilentlyContinue) -and (Get-PoolKey)) { 'readable by this user' }
            else { 'PRESENT BUT UNREADABLE (written by another user or machine)' }
Show-Line "Pool key"         $keyState $(if ($keyState -like 'PRESENT*') { 'Red' } elseif ($keyState -eq 'none yet') { 'Yellow' } else { 'Green' })
if ($keyState -like 'PRESENT*') { $problems += 'the pool key cannot be read here, so no snapshot can be verified' }
Show-Line "Trust manifest"   $(if (Test-Path $manifest) { $manifest } else { 'none - every snapshot is accepted as before' }) $(if (Test-Path $manifest) { 'Gray' } else { 'Yellow' })

# Without a manifest nothing was verified, which is not the same as vouched for:
# 'unchecked' is what that state is called here.
$checked = (Test-Path $manifest) -and (Get-Command Test-PoolEntry -ErrorAction SilentlyContinue)
$rows = @(Get-CcPool -AllowUntrusted | ForEach-Object {
    [pscustomobject]@{
        Email     = $_.Email
        Name      = $_.Name
        Trust     = if (-not $checked -and $_.Trust -eq 'trusted') { 'unchecked' } else { $_.Trust }
        Protected = $_.Protected
        Identity  = $_.Identity
        Current   = [bool]($_.Token -and $liveToken -and $_.Token -eq $liveToken)
    }
})

if ($rows.Count) {
    Show-Line "Saved accounts"  ("{0} found" -f $rows.Count) 'Green'
    foreach ($r in $rows) {
        $bits = @()
        $bits += if ($r.Protected) { 'encrypted' } else { 'PLAIN TEXT' }
        $bits += switch ($r.Trust) {
            'trusted'   { 'trusted' }
            'unchecked' { 'unverified (no manifest)' }
            'sealed'    { 'SEALED for another user/machine' }
            default     { (Get-PoolVerdictText $r.Trust) }
        }
        if ($r.Identity -and $r.Identity -ne $r.Email) { $bits += "holds $($r.Identity)'s login" }
        if ($r.Current) { $bits += 'currently live' }
        $color = if ($r.Trust -eq 'trusted' -or $r.Trust -eq 'unchecked') {
                     if ($r.Protected) { 'Gray' } else { 'DarkYellow' }
                 } else { 'Red' }
        Write-Host ("      - {0,-32} {1}" -f $r.Email, ($bits -join ', ')) -ForegroundColor $color
    }
    $notTrusted = @($rows | Where-Object { $_.Trust -ne 'trusted' -and $_.Trust -ne 'unchecked' })
    if ($notTrusted.Count) { $problems += "$($notTrusted.Count) snapshot(s) the switcher will refuse - see the list above" }
    $plain = @($rows | Where-Object { -not $_.Protected })
    if ($plain.Count -and $CcPlatformWin -and (Test-CcDpapi)) {
        $problems += "$($plain.Count) snapshot(s) hold a working login in plain JSON - run 'claude-cc-pool.ps1 -Protect'"
    }
    if ($liveEmail -and -not ($rows | Where-Object { $_.Email -eq $liveEmail })) {
        $problems += "the live account ($liveEmail) is not saved - run 'claude-code-add'"
    }
} else {
    Show-Line "Saved accounts"  "none yet (run 'claude-code-add')" 'Yellow'
    $problems += "no saved account: run 'claude-code-add' while logged in"
}

# -- In-place thread refresh ---------------------------------------------------
# The switch itself only rewrites the credentials; a running session keeps the
# token it read at startup, so the refresh is the half that makes it take
# effect. It needs the wrapper in front of the PATH.
Write-Host ""
$shimDir = Join-Path $HOME '.claude-tools\shim'
$shimExe = Join-Path $shimDir 'claude.exe'
$pinFile = Join-Path $shimDir 'real-bin.txt'
if ($CcPlatformWin) {
    $built = Test-Path $shimExe
    Show-Line "Refresh wrapper"  $(if ($built) { $shimExe } else { 'not built' }) $(if ($built) { 'Green' } else { 'Yellow' })
    $userPath = @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ })
    $firstClaude = $userPath | Where-Object { Test-Path (Join-Path $_ 'claude.exe') } | Select-Object -First 1
    $inFront = ($firstClaude -eq $shimDir)
    Show-Line "On the user PATH" $(if ($inFront) { 'yes, in front' } elseif ($userPath -contains $shimDir) { 'yes, but behind another claude.exe' } else { 'no' }) $(if ($inFront) { 'Green' } else { 'Yellow' })
    if ($built) {
        $pinned = if (Test-Path $pinFile) { (Get-Content $pinFile -Raw).Trim() } else { $null }
        Show-Line "Wrapper runs"   $(if ($pinned) { $pinned } else { 'not pinned - it searches PATH' }) $(if ($pinned) { 'Gray' } else { 'Yellow' })
    }
    if (-not $built -or -not $inFront) {
        $problems += "threads cannot refresh themselves: run 'claude-code-shim.ps1 -Install', then restart Boite once"
    }
    # A marker older than a few minutes is one nothing acted on: the wrapper was
    # missing, or it refused the marker.
    $markerDir = Get-CcMarkerDir
    # Signatures whose marker is gone are swept here rather than reported: there
    # is nothing for the user to decide about them.
    Clear-CcOrphanMarkerSigs | Out-Null
    $stale = @(Get-ChildItem -LiteralPath $markerDir -Filter 'relaunch-*' -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -notlike '*.sig' -and $_.LastWriteTime -lt (Get-Date).AddMinutes(-5) })
    if ($stale.Count) {
        Show-Line "Stale markers"  ("{0} left behind in {1}" -f $stale.Count, $markerDir) 'Yellow'
    }
}

# -- Unattended switching ------------------------------------------------------
# Nothing calls the switcher when a quota expires at 23:39, and a session that
# is rate limited cannot fire a hook either - the user cannot send anything. The
# watcher is what turns "would switch" into "switched".
Write-Host ""
$threadsLib = Join-Path $PSScriptRoot 'claude-cc-threads.ps1'
$watchPidFile = Join-Path $CcStore '.watch.pid'
$watchProc = Get-CcPidFileProcess $watchPidFile '^(pwsh|powershell)$'
Show-Line "Account watcher" $(if ($watchProc) { "running (pid $($watchProc.Id))" } else { 'not running' }) $(if ($watchProc) { 'Green' } else { 'Yellow' })
if ($CcPlatformWin) {
    $task = Get-ScheduledTask -TaskName 'ClaudeCodeAccountWatch' -ErrorAction SilentlyContinue
    Show-Line "Starts at logon" $(if ($task) { $task.State } else { 'no' }) $(if ($task) { 'Gray' } else { 'Yellow' })
    if (-not $task) { $problems += "the watcher does not start at logon: run 'claude-code-watch.ps1 -Install'" }
}
if (-not $watchProc) {
    $problems += "no watcher is running, so nothing switches when a limit expires: run 'claude-code-watch.ps1 -Install'"
}
# The watcher can only restart what has registered itself, which is the
# SessionStart hook's job.
$hookOn = Test-CcSessionHook
Show-Line "SessionStart hook" $(if ($hookOn) { 'installed' } else { 'missing' }) $(if ($hookOn) { 'Green' } else { 'Yellow' })
if (-not $hookOn) {
    $problems += "sessions do not register themselves: run 'claude-code-watch.ps1 -InstallHook'"
}
if (Test-Path $threadsLib) {
    . $threadsLib
    $live = @(Get-CcLiveThreads)
    Show-Line "Live sessions" ("{0} registered" -f $live.Count) $(if ($live.Count) { 'Gray' } else { 'DarkGray' })
}

if (Test-Path $CcRelaunchFailed) {
    Write-Host ""
    Write-Host "  Last refresh FAILED:" -ForegroundColor Yellow
    Write-Host ("      " + ((Get-Content $CcRelaunchFailed -Raw).Trim())) -ForegroundColor Yellow
    Write-Host "      (this note clears itself the next time a refresh works)" -ForegroundColor DarkGray
}

Write-Host ""
if ($problems.Count -eq 0) {
    Write-Host "Looks good - 'claude-code-select -List' and the /claude-account-* commands are ready." -ForegroundColor Green
} else {
    Write-Host "Setup incomplete:" -ForegroundColor Yellow
    foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Yellow }
}
Write-Host ""
