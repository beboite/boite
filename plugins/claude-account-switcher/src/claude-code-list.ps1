# The saved logins for one provider, with what is known about their quota.
param(
    [string]$Provider = 'claude',
    [switch]$Refresh
)

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')

$pool = @(Get-CcPool)
Say ("{0} — {1}" -f $CcName, $CcStore) Cyan
if (-not $pool.Count) {
    Say 'No accounts saved yet.' Yellow
    Say ("Log in to {0}, then run: claude-cc add -Provider {1}" -f $CcName, $CcProviderId) DarkGray
    exit 0
}

$current = Find-CcCurrent $pool
$problem = $false

foreach ($entry in $pool) {
    $mark = if ($current -and $entry.File -eq $current.File) { '*' } else { ' ' }
    # Refresh reaches the API; without it this stays offline and prints the cache.
    $usage = if ($Refresh) { Get-CcPoolUsage $entry -Force } else { ConvertFrom-CcUsageCache $entry.Cache }
    $line  = '{0} {1,-34} {2}' -f $mark, $entry.Email, (Format-CcUsagePair $usage)

    $ready = Get-CcReadyAt $usage
    if ($ready) { $line += ('  back in {0}' -f (Format-CcWait $ready)) }

    $colour = if ($mark -eq '*') { 'Green' } else { $null }
    if ($usage -and -not (Test-CcUsable $usage)) { $colour = 'DarkGray' }
    Say $line $colour

    if ($entry.Trust -ne 'trusted') {
        $verdict = Format-CcPoolVerdict $entry.Trust
        Say ('  ! {0}' -f $verdict.Text) $verdict.Color
        $problem = $true
    }
    if (-not $entry.Protected) {
        Say '  ! stored in plain text' Yellow
        $problem = $true
    }
    if (-not $entry.Creds) {
        Say '  ! credentials could not be read back' Red
        $problem = $true
    }
}

if (-not $current) { Say 'The live login is not one of the saved ones.' DarkGray }
exit $(if ($problem) { 1 } else { 0 })
