# Saves the login the CLI is using right now into the pool.
param(
    [string]$Provider = 'claude',
    [string]$Email,
    [switch]$Quiet
)

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')

$raw = Get-CcLiveCredsRaw
if (-not $raw) {
    Say "No $CcName credentials found ($CcCredLabel)." Red
    Say "Run /login in $CcName first, then add the account." DarkGray
    exit 1
}

$identity = Get-CcLiveIdentity
if (-not $Email -and $identity) { $Email = "$($identity.emailAddress)" }
if (-not $Email) {
    # Codex API keys carry no identity, so the pool needs a name for the file.
    Say 'Could not work out which account this is.' Red
    Say 'Pass one: claude-cc add -Provider codex -Email you@example.com' DarkGray
    exit 2
}

if (-not (Test-Path -LiteralPath $CcStore)) { New-Item -ItemType Directory -Path $CcStore -Force | Out-Null }
Protect-CcDirectory $CcStore

$path     = Get-CcSnapshotPath $Email
$existed  = Test-Path -LiteralPath $path
$previous = Read-CcJsonFile $path
$cache    = if (Test-CcHasProperty $previous 'usageCache') { $previous.usageCache } else { $null }
# Saving over an account already in the pool refreshes its tokens; it does not
# make it a new saved login, so the date it was first saved is kept.
$saved    = if (Test-CcHasProperty $previous 'savedAt') { $previous.savedAt } else { $null }

$snapshot = New-CcSnapshotEntry -Email $Email -CredsRaw $raw -Identity $identity -UsageCache $cache -SavedAt $saved
Write-CcJsonFile $path $snapshot

$registered = Register-CcPoolEntry -FileName (Split-Path -Leaf $path) -Snapshot $snapshot

if (-not $Quiet) {
    Say ("{0} {1} ({2})" -f $(if ($existed) { 'Updated' } else { 'Saved' }), $Email, $CcName) Green
    if (-not (Test-CcHasProperty $snapshot 'credentialsProtected')) {
        Say 'Stored in plain text: no OS secret store was available on this machine.' Yellow
    }
    if (-not $registered) {
        Say 'Saved but not stamped: this account has no stable id to stamp.' DarkGray
    }
}
exit 0
