# Launch Claude Code with an automatic account check.
#
# Before starting `claude`, swap to another saved account if the current one is
# rate limited (see claude-code-auto.ps1). With -Relaunch, the check runs again
# when the session ends: if `claude` stopped on a limit, the account is swapped
# and the session is resumed with `claude --continue`.
#
#   claude-go                     check, then launch claude
#   claude-go --resume            arguments are passed through to claude
#   claude-go -Relaunch           also swap + continue when a limit ends the run

[CmdletBinding()]
param(
    [switch]$Relaunch,
    # 5-hour cap only, and lower than the toolkit's 99%: this runs before a
    # session starts, where swapping early costs nothing. -1 defers to
    # claude-code-auto.ps1's own defaults (99% / 99.8% weekly).
    [double]$Threshold = 90,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArgs = @()
)

$auto = Join-Path (Join-Path $HOME '.claude-tools') 'claude-code-auto.ps1'
if (-not (Test-Path $auto)) { Write-Host "Missing $auto" -ForegroundColor Red; exit 1 }

$pwshExe = (Get-Process -Id $PID).Path
if (-not $pwshExe) { $pwshExe = 'pwsh' }

function Invoke-AutoSwitch {
    # Invariant culture: -File hands arguments over as strings.
    & $pwshExe -NoProfile -File $auto -Threshold ([double]$Threshold).ToString([cultureinfo]::InvariantCulture) -Quiet
    return $LASTEXITCODE
}

Invoke-AutoSwitch | Out-Null

& claude @ClaudeArgs
$claudeExit = $LASTEXITCODE

if ($Relaunch) {
    # The session is over; if it ended because the account ran out of quota, the
    # check swaps accounts (exit 10) and the work continues on the new one.
    if ((Invoke-AutoSwitch) -eq 10) {
        Write-Host "Account switched - resuming with 'claude --continue'." -ForegroundColor Cyan
        & claude --continue @ClaudeArgs
        $claudeExit = $LASTEXITCODE
    }
}

exit $claudeExit
