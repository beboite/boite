# What is installed, what is readable, and what the pool thinks of itself.
#
# `-Protect` re-seals every snapshot that is still plain text, `-Adopt` stamps
# snapshots this machine did not register, `-Rollback` puts the credentials from
# before the last switch back in front of the CLI, and `-Clean` deletes the files
# earlier versions left in the pool.
param(
    [string]$Provider = 'claude',
    [switch]$Protect,
    [switch]$Adopt,
    [switch]$Rollback,
    [switch]$Clean
)

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')

$problems = 0
function Bad { param([string]$Text) Say "  ! $Text" Red; $script:problems++ }
function Warn { param([string]$Text) Say "  ~ $Text" Yellow }
function Good { param([string]$Text) Say "  . $Text" DarkGray }

Say ("{0} — {1}" -f $CcName, $CcStore) Cyan
Say ('  pwsh {0} on {1}' -f $PSVersionTable.PSVersion, [System.Runtime.InteropServices.RuntimeInformation]::OSDescription.Trim()) DarkGray

if ($Rollback) {
    $backup = Get-CcNewestBackup
    if (-not $backup) {
        Say '  No backup to roll back to.' Yellow
        exit 1
    }
    Invoke-CcCredSwapLocked { Set-CcLiveCredsRaw $backup.Raw }
    Say ("  Put the credentials from {0} back. The email in the config was left as it is." -f $backup.At) Green
    exit 0
}

# Earlier versions put a `claude.exe` shim on the PATH, in a directory this one
# does not write and cannot safely delete: while that directory is still on the
# PATH, `claude` runs the shim rather than the CLI.
$shim = Join-Path $PSScriptRoot 'shim'
if (Test-Path -LiteralPath $shim) {
    Warn "An earlier version left $shim on this machine. Remove it once nothing on your PATH points at it."
}

$backend = Get-CcSecretBackend
if ($backend -eq 'none') { Warn 'No OS secret store: snapshots cannot be encrypted on this machine.' }
else { Good "credentials sealed with $backend" }

if (Get-Command $CcCli -ErrorAction Ignore) { Good "$CcCli found on PATH" }
else { Warn "$CcCli is not on PATH." }

if (Get-CcLiveCredsRaw) {
    $live = Get-CcLiveIdentity
    if ($live -and $live.emailAddress) { Good "logged in as $($live.emailAddress)" }
    else { Good "logged in ($CcCredLabel)" }
} else {
    Warn "not logged in ($CcCredLabel)"
}

if (-not (Test-Path -LiteralPath $CcStore)) {
    Warn 'No pool directory yet. Nothing has been saved.'
    exit $(if ($problems) { 1 } else { 0 })
}

if (-not (Get-CcPoolKey)) { Warn 'The pool key is missing or unreadable: nothing can be verified.' }

$plain = 0
foreach ($entry in @(Get-CcPool)) {
    $name = Split-Path -Leaf $entry.File
    Say ('  {0}' -f $entry.Email)

    if ($Protect -and -not $entry.Protected -and $entry.Creds) {
        $saved  = $(if (Test-CcHasProperty $entry.Snapshot 'savedAt') { $entry.Snapshot.savedAt } else { $null })
        $sealed = New-CcSnapshotEntry -Email $entry.Email -CredsRaw $entry.Creds -Identity $entry.Identity -UsageCache $entry.Cache -SavedAt $saved
        Write-CcJsonFile $entry.File $sealed
        Register-CcPoolEntry -FileName $name -Snapshot $sealed | Out-Null
        Good 'sealed'
        continue
    }
    if ($Adopt -and $entry.Trust -ne 'trusted') {
        if (Register-CcPoolEntry -FileName $name -Snapshot $entry.Snapshot) { Good 'stamped' }
        else { Warn 'cannot be stamped: no stable account id' }
        continue
    }

    if (-not $entry.Creds) { Bad 'the credentials cannot be read back' }
    elseif (-not $entry.Protected) { Warn 'stored in plain text'; $plain++ }
    if ($entry.Trust -eq 'changed') { Bad 'CHANGED since it was registered' }
    elseif ($entry.Trust -ne 'trusted') { Warn (Format-CcPoolVerdict $entry.Trust).Text }
    if ($entry.Creds -and $entry.Protected -and $entry.Trust -eq 'trusted') { Good 'sealed and stamped' }
}

# Versions that had a watcher, a relauncher and background threads left their
# state in the pool. Nothing reads these any more, and they sit next to the
# snapshots looking like they mean something.
$stale = @(
    Get-ChildItem -LiteralPath $CcStore -Force -File -ErrorAction Ignore |
        Where-Object { $_.Name -in @('.threads.state', '.watch.pid', '.watch.state', 'watch.log', 'watch-hidden.vbs', 'relaunch.log') }
    Get-ChildItem -LiteralPath (Join-Path $CcStore '.backups') -Force -File -ErrorAction Ignore |
        Where-Object { $_.Name -like '*.json.bak' }
)
if ($stale.Count) {
    if ($Clean) {
        $stale | Remove-Item -Force -ErrorAction Ignore
        Good ("removed {0} leftover file(s) from an earlier version" -f $stale.Count)
    } else {
        Say ("  {0} leftover file(s) from an earlier version. Remove with: claude-cc doctor -Provider {1} -Clean" -f $stale.Count, $CcProviderId) Yellow
    }
}

if ($plain -and -not $Protect) {
    Say ("  {0} snapshot(s) in plain text. Fix with: claude-cc doctor -Provider {1} -Protect" -f $plain, $CcProviderId) Yellow
}
exit $(if ($problems) { 1 } else { 0 })
