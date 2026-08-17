# Save the Claude Code (CLI) account currently logged in, so it can be switched
# to later. Claude Code stores its login as a flat OAuth token (like Codex's
# auth.json), so this is a simple, safe snapshot.
#
#   claude-code-add.ps1              ask for the email (or confirm the detected one)
#   claude-code-add.ps1 -Yes         take the detected account, ask nothing
#   claude-code-add.ps1 -Email a@b.c save under that address
#   claude-code-add.ps1 -Yes -Clear  save, then clear the local login for the next /login
#
# -Yes is what makes this usable from inside a live Claude Code session: there
# is no stdin there, so a Read-Host prompt can only fail.
#
# On Windows the login is stored DPAPI-encrypted for the current user, and the
# snapshot is registered in the pool manifest so the switcher will accept it.
#
# Exit codes: 0 = saved, 1 = nothing to save, 2 = refused (identity mismatch, or
# no email to save it under).

[CmdletBinding()]
param(
    [string]$Email,
    [switch]$Yes,      # no questions: take what is detected, accept a mismatch
    [switch]$Clear,    # clear the local login afterwards (does NOT log the account out)
    [switch]$Quiet
)

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')
$poolLib = Join-Path $PSScriptRoot 'claude-cc-pool.ps1'
if (Test-Path $poolLib) { . $poolLib }

# Read-Host cannot work where there is no console to read from - inside a Claude
# Code session it returns immediately and the script would "cancel" itself.
$interactive = -not $Yes -and -not [System.Console]::IsInputRedirected

Say ""
Say "=== Add Claude Code account ===" Cyan

$raw = Get-CcLiveCredsRaw
if (-not $raw) {
    Write-Host "Claude Code is not logged in (no credentials in $CcCredLabel)." -ForegroundColor Red
    Write-Host "Run /login in Claude Code, then run this again." -ForegroundColor Red
    exit 1
}
try { $c = $raw | ConvertFrom-Json } catch {
    Write-Host "Could not read the Claude Code credentials." -ForegroundColor Red
    exit 1
}
if (-not $c.claudeAiOauth) {
    Write-Host "No subscription login found in credentials (API-key setup?)." -ForegroundColor Red
    exit 1
}

# This account's display identity (oauthAccount) so a later switch can update
# .claude.json too - otherwise /status keeps showing the previous account. It
# also says which login is really being snapshotted, which catches a mistyped
# email: saving login X under email Y makes two picker entries point at the SAME
# account, and Y's real credentials are lost.
$oauthAccountRaw = Get-CcLiveOAuthRaw
$detected = $null
if ($oauthAccountRaw) { try { $detected = ($oauthAccountRaw | ConvertFrom-Json).emailAddress } catch {} }

if (-not $Email) {
    if ($interactive) {
        if ($detected) {
            $Email = Read-Host "Email of the logged-in account [Enter = $detected]"
            if ([string]::IsNullOrWhiteSpace($Email)) { $Email = $detected }
        } else {
            $Email = Read-Host "Email of the account currently logged into Claude Code"
        }
    } elseif ($detected) {
        $Email = $detected
    }
}
if ([string]::IsNullOrWhiteSpace($Email)) {
    Write-Host "No email to save this account under, and Claude Code does not report one." -ForegroundColor Red
    Write-Host "Pass it: claude-code-add.ps1 -Email you@example.com" -ForegroundColor Yellow
    exit 2
}

if ($detected -and $Email -ne $detected) {
    Write-Host ""
    Write-Host "Warning: Claude Code says the CURRENT login is $detected, not $Email." -ForegroundColor Yellow
    Write-Host "Saving this login under $Email would overwrite that account's saved" -ForegroundColor Yellow
    Write-Host "credentials with $detected's (both entries would then be the same account)." -ForegroundColor Yellow
    Write-Host "If you meant to add $Email, run /login as $Email first, then run this again." -ForegroundColor Yellow
    if ($interactive) {
        $go = Read-Host "Save anyway as $Email? [y/N]"
        if ($go -notmatch '^(y|yes)$') { Write-Host "Cancelled." -ForegroundColor Yellow; exit 2 }
    } elseif (-not $Yes) {
        Write-Host "Refused (pass -Yes to save it anyway)." -ForegroundColor Red
        exit 2
    }
}

New-Item -ItemType Directory -Force -Path $CcStore | Out-Null
Protect-CcDirectory $CcStore
$safe = ($Email -replace '[^\w.@+-]', '_')
$file = Join-Path $CcStore "$safe.json"

# Keep whatever usage readings that account already had: they are what keeps it
# measurable once this snapshot's access token expires.
$usageCache = $null
if (Test-Path $file) { try { $usageCache = (Get-Content $file -Raw | ConvertFrom-Json).usageCache } catch {} }

$entry = New-CcSnapshotEntry $Email $c $oauthAccountRaw $usageCache
Write-CcJsonFile $file $entry

# Register it in the pool manifest: this is the one place where a snapshot is
# created by someone who had to log in first, so this is where the switcher
# learns the file can be trusted. Anything that appears in the folder without
# going through here is refused.
if (Get-Command Register-PoolEntry -ErrorAction SilentlyContinue) {
    try {
        if (-not (Register-PoolEntry (Split-Path $file -Leaf) $Email $oauthAccountRaw $c)) {
            Write-Host "Note: this snapshot could not be registered (no accountUuid in it)." -ForegroundColor DarkYellow
        }
    } catch {
        Write-Host "Note: the account pool manifest could not be updated: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

$how = if ($entry.credentialsProtected) { 'encrypted for this Windows user' } else { 'stored as plain JSON (DPAPI unavailable here)' }
Write-Host ""
Write-Host "Saved Claude Code account: $Email" -ForegroundColor Green
Say "  $file - login $how" DarkGray

# Clearing the LOCAL credentials does NOT call the logout API, so the account
# just saved stays valid.
$clearIt = $Clear
if (-not $clearIt -and $interactive) {
    $more = Read-Host "Add ANOTHER account now? (clears local login WITHOUT logging out) [y/N]"
    $clearIt = ($more -match '^(y|yes)$')
}
if ($clearIt) {
    Remove-CcLiveCreds
    Write-Host ""
    Write-Host "Local Claude Code login cleared (not revoked)." -ForegroundColor Green
    Write-Host "In Claude Code: run /login as the NEXT account, then run 'claude-code-add' again." -ForegroundColor Green
    Write-Host "(If a Claude Code session is open, restart it so it sees the cleared login.)" -ForegroundColor DarkGray
}
exit 0
