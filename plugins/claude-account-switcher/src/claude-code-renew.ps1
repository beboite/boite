# claude-code-renew - keep the saved logins alive without a browser.
#
#   claude-code-renew.ps1                 renew whatever is about to expire
#   claude-code-renew.ps1 bob             one account
#   claude-code-renew.ps1 -Force          renew every account, expired or not
#   claude-code-renew.ps1 -DryRun         say what would be renewed, call nothing
#
# Why this exists. A Claude Code login is an OAuth pair: a short-lived access
# token (hours) and a refresh token that buys a new pair. The refresh token is
# rotated on every use and the server retires the previous one immediately, so a
# snapshot that sits in the pool while its owner is not logged in does not just
# go stale - it stays pinned to a token that will still work, once, until
# something else refreshes that account. Sync-CcLiveSnapshot covers the account
# that is live. This covers the ones that are not: it spends the stored refresh
# token itself, on our own schedule, and writes the new pair back. Every account
# in the pool then stays usable indefinitely without /login.
#
# The account this machine is currently logged into is skipped on purpose:
# Claude Code refreshes it itself, and racing that would hand one of the two
# sides a token the server has already retired. The watcher's sync-back is what
# keeps that one current.
#
# Endpoint and client id are the ones Claude Code's own OAuth flow uses. They
# are constants of the public client, not secrets, and both can be overridden
# with CLAUDE_OAUTH_TOKEN_URL / CLAUDE_OAUTH_CLIENT_ID if Anthropic moves them.
#
# Exit codes: 0 everything that needed a renewal got one, 1 at least one account
# has a dead refresh token and needs /login, 2 the token endpoint is rate
# limiting and the run stopped early (nothing was spent), 30 the pool is empty.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Email,
    [int]$MarginMinutes = 120,   # renew this long before the access token expires
    [switch]$Force,              # renew even when the token has hours left
    [switch]$IncludeCurrent,     # also renew the live account (races the session)
    [switch]$DryRun,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')
$poolLib = Join-Path $PSScriptRoot 'claude-cc-pool.ps1'
if (Test-Path $poolLib) { . $poolLib }

# api.anthropic.com, not console.: the console host answers this route with a
# plain rate_limit_error whatever you send it, while the api host returns real
# OAuth errors (invalid_grant for a spent token) and the new pair for a good one.
$TokenUrl = if ($env:CLAUDE_OAUTH_TOKEN_URL) { $env:CLAUDE_OAUTH_TOKEN_URL } else { 'https://api.anthropic.com/v1/oauth/token' }
$ClientId = if ($env:CLAUDE_OAUTH_CLIENT_ID) { $env:CLAUDE_OAUTH_CLIENT_ID } else { '9d1c250a-e61b-44d9-88ed-5944d1962f5e' }

# One refresh call. Returns the new token set, or a string starting with '!' for
# a refusal the caller should report rather than retry.
function Invoke-OAuthRefresh($refreshToken) {
    $body = @{ grant_type = 'refresh_token'; refresh_token = $refreshToken; client_id = $ClientId } |
            ConvertTo-Json -Compress
    try {
        return Invoke-RestMethod -Uri $TokenUrl -Method Post -Body $body `
                                 -ContentType 'application/json' -TimeoutSec 20
    } catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch {}
        # 400 and 401 are the server saying this refresh token is spent or
        # revoked. That is not a transient failure and retrying it is pointless:
        # the account needs a browser login.
        if ($status -eq 400 -or $status -eq 401) { return '!dead' }
        # The token endpoint rate-limits by caller, not by account: one 429 means
        # every account in this run would get the same answer. Reported as the
        # transient it is, and the caller stops asking.
        if ($status -eq 429) { return '!429' }
        return "!$($_.Exception.Message)"
    }
}

# The expiry Claude Code writes is epoch milliseconds.
function Get-ExpiryDate($o) {
    if (-not $o.expiresAt) { return $null }
    try { return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$o.expiresAt).LocalDateTime } catch { return $null }
}

$files = @(Get-CcSnapshotFiles)
if (-not $files.Count) {
    Say "No saved accounts in $CcStore." Yellow
    exit 30
}

# Who is live, so it can be left alone.
$live      = Get-CcLiveIdentity
$liveToken = $live.Token
$liveMail  = $live.Email

$renewed = 0
$dead    = 0
$limited = $false
$now     = Get-Date

foreach ($f in $files) {
    $j = $null
    try { $j = Get-Content $f.FullName -Raw | ConvertFrom-Json } catch { continue }
    $label = if ($j.email) { $j.email } else { $f.Name }
    if ($Email -and $label -notlike "*$Email*" -and $f.Name -notlike "*$Email*") { continue }

    if (-not (Test-CcSnapshotHasCreds $j)) { continue }
    $creds = Get-CcSnapshotCreds $j
    if (-not $creds) {
        # Written by another Windows user or another machine: the blob cannot be
        # opened here, so there is nothing to refresh.
        Say "  $label - sealed on this machine, skipped" DarkGray
        continue
    }
    $o = $creds.claudeAiOauth
    if (-not $o -or -not $o.refreshToken) {
        Say "  $label - no refresh token in the snapshot, needs /login" Yellow
        $dead++
        continue
    }

    $isLive = ($liveToken -and $o.accessToken -eq $liveToken) -or ($liveMail -and $j.email -eq $liveMail)
    if ($isLive -and -not $IncludeCurrent) {
        Say "  $label - live account, left to Claude Code itself" DarkGray
        continue
    }

    $exp  = Get-ExpiryDate $o
    $left = if ($exp) { ($exp - $now).TotalMinutes } else { -1 }
    if (-not $Force -and $exp -and $left -gt $MarginMinutes) {
        Say ("  {0} - good for {1:n0}h, left alone" -f $label, ($left / 60)) DarkGray
        continue
    }

    $why = if (-not $exp) { 'no expiry recorded' } elseif ($left -lt 0) { 'expired' } else { "expires in {0:n0}m" -f $left }
    if ($DryRun) {
        Say "  $label - would renew ($why)" Cyan
        continue
    }

    $r = Invoke-OAuthRefresh $o.refreshToken
    if ($r -is [string] -and $r.StartsWith('!')) {
        if ($r -eq '!dead') {
            Say "  $label - the saved refresh token is spent, this one needs /login" Yellow
            $dead++
        } elseif ($r -eq '!429') {
            Say "  $label - the token endpoint is rate limiting; nothing was spent, try later" DarkYellow
            $limited = $true
            break
        } else {
            Say ("  {0} - renewal failed: {1}" -f $label, $r.Substring(1)) Red
        }
        continue
    }
    if (-not $r.access_token) {
        Say "  $label - the server answered without a token" Red
        continue
    }

    # Only the three fields that the refresh actually replaces are touched:
    # subscriptionType, scopes and anything else Claude Code keeps in there stay
    # exactly as they were.
    $o.accessToken = $r.access_token
    if ($r.refresh_token) { $o.refreshToken = $r.refresh_token }
    if ($r.expires_in) {
        $o.expiresAt = [DateTimeOffset]::UtcNow.AddSeconds([double]$r.expires_in).ToUnixTimeMilliseconds()
    }

    Write-CcJsonFile $f.FullName (New-CcSnapshotEntry $j.email $creds $j.oauthAccountRaw $j.usageCache)
    if (Get-Command Register-PoolEntry -ErrorAction SilentlyContinue) {
        try { Register-PoolEntry $f.Name $j.email $j.oauthAccountRaw $creds | Out-Null } catch {}
    }
    $renewed++
    $until = if ($r.expires_in) { (Get-Date).AddSeconds([double]$r.expires_in) } else { $null }
    if ($until) { Say ("  {0} - renewed, good until {1:HH:mm}" -f $label, $until) Green }
    else        { Say "  $label - renewed" Green }
}

if ($renewed) { Say "$renewed account(s) renewed." Green }
elseif (-not $Quiet -and -not $dead) { Say "Nothing needed renewing." DarkGray }
if ($dead) {
    Say "$dead account(s) need a browser login: /login as that account, then claude-code-add." Yellow
    exit 1
}
# Its own code so a caller on a timer can back off instead of treating a rate
# limit as a broken account.
if ($limited) { exit 2 }
exit 0
