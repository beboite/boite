# Forgets a saved login. The live session is left exactly as it is.
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

if (-not $Email) {
    for ($i = 0; $i -lt $pool.Count; $i++) { Say ('  [{0}] {1}' -f ($i + 1), $pool[$i].Email) }
    $answer = Read-Host 'Remove which number'
    $index  = 0
    if (-not [int]::TryParse($answer, [ref]$index) -or $index -lt 1 -or $index -gt $pool.Count) {
        Say 'Nothing removed.' DarkGray
        exit 0
    }
    $target = $pool[$index - 1]
} else {
    $key = $Email.ToLowerInvariant()
    $target = $pool | Where-Object { "$($_.Email)".ToLowerInvariant() -eq $key } | Select-Object -First 1
}

if (-not $target) {
    Say 'No matching account.' Red
    exit 1
}

if (-not $Yes) {
    if ((Read-Host ("Remove {0} from the pool? [y/N]" -f $target.Email)) -notmatch '^(y|yes)$') {
        Say 'Nothing removed.' DarkGray
        exit 0
    }
}

Remove-Item -LiteralPath $target.File -Force
Unregister-CcPoolEntry -FileName (Split-Path -Leaf $target.File)
Say ("Removed {0}. The live login is untouched." -f $target.Email) Green
exit 0
