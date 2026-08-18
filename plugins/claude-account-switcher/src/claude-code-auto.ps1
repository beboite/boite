# Switches away from the account in use only when it is out of quota, and only
# to one that is not.
#
# Exit codes are the point of this command: 0 nothing to do, 10 switched,
# 20 every saved account is capped, 30 nothing is set up yet.
param(
    [string]$Provider = 'claude',
    [switch]$Quiet
)

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')

function Note {
    param([string]$Text, [string]$Color)
    if (-not $Quiet) { Say $Text $Color }
}

$pool = @(Get-CcPool)
if ($pool.Count -lt 2) {
    Note "Nothing to switch between: $CcName has $($pool.Count) saved account(s)." Yellow
    exit 30
}

$current = Find-CcCurrent $pool
if ($current) {
    $usage = Get-CcPoolUsage $current
    if (Test-CcUsable $usage) {
        Note ("{0} still has room ({1})." -f $current.Email, (Format-CcUsagePair $usage)) DarkGray
        exit 0
    }
    Note ("{0} is out of quota ({1})." -f $current.Email, (Format-CcUsagePair $usage)) Yellow
}

$soonest = $null
foreach ($entry in $pool) {
    if ($current -and $entry.File -eq $current.File) { continue }
    if ($entry.Trust -eq 'changed') { continue }
    if (-not $entry.Creds) { continue }

    $usage = Get-CcPoolUsage $entry
    if (Test-CcUsable $usage) {
        Set-CcActiveAccount $entry
        Note ("Switched {0} to {1} ({2})." -f $CcName, $entry.Email, (Format-CcUsagePair $usage)) Green
        exit 10
    }
    $ready = Get-CcReadyAt $usage
    if ($ready -and (-not $soonest -or $ready -lt $soonest)) { $soonest = $ready }
}

if ($soonest) { Note ("Every saved account is capped. The first one is back in {0}." -f (Format-CcWait $soonest)) Red }
else { Note 'Every saved account is capped.' Red }
exit 20
