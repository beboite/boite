# Switches the CLI to another saved login.
param(
    [string]$Provider = 'claude',
    [string]$Email,
    [switch]$Yes
)

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')

$pool = @(Get-CcPool)
if (-not $pool.Count) {
    Say "No accounts saved for $CcName." Yellow
    exit 0
}

$current = Find-CcCurrent $pool

function Select-CcTarget {
    param($Pool, [string]$Wanted)
    if ($Wanted) {
        $key = $Wanted.ToLowerInvariant()
        $hit = $Pool | Where-Object { "$($_.Email)".ToLowerInvariant() -eq $key } | Select-Object -First 1
        if (-not $hit) {
            $hit = $Pool | Where-Object { "$($_.Email)".ToLowerInvariant().StartsWith($key) } | Select-Object -First 1
        }
        return $hit
    }
    if ($Pool.Count -eq 2 -and $current) {
        # Two accounts and one of them is in use: there is only one answer.
        return ($Pool | Where-Object { $_.File -ne $current.File } | Select-Object -First 1)
    }
    for ($i = 0; $i -lt $Pool.Count; $i++) {
        $mark = if ($current -and $Pool[$i].File -eq $current.File) { '*' } else { ' ' }
        Say ('{0} [{1}] {2}' -f $mark, ($i + 1), $Pool[$i].Email)
    }
    $answer = Read-Host 'Switch to which number'
    $index  = 0
    if (-not [int]::TryParse($answer, [ref]$index) -or $index -lt 1 -or $index -gt $Pool.Count) { return $null }
    return $Pool[$index - 1]
}

$target = Select-CcTarget -Pool $pool -Wanted $Email
if (-not $target) {
    Say 'No matching account.' Red
    exit 1
}
if ($current -and $target.File -eq $current.File) {
    Say ("Already on {0}." -f $target.Email) DarkGray
    exit 0
}

if ($target.Trust -ne 'trusted') {
    $verdict = Format-CcPoolVerdict $target.Trust
    Say ("This account is {0}: it is not one this machine registered, or it has changed since." -f $verdict.Text) $verdict.Color
    if (-not $Yes) {
        if ((Read-Host 'Switch to it anyway? [y/N]') -notmatch '^(y|yes)$') { exit 1 }
    }
}

Set-CcActiveAccount $target
Say ("Switched {0} to {1}" -f $CcName, $target.Email) Green
Say 'Restart or /login-free reload the CLI for it to pick the change up.' DarkGray
exit 10
