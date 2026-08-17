# Refresh a Claude Code thread in place, without touching the app around it.
#
# A thread is refreshed by ending its Claude Code process while the `claude`
# wrapper is in front of it on PATH: the wrapper starts Claude Code again in the
# same terminal, on the same conversation, and the fresh process picks up
# whatever changed underneath it - the account, the MCP servers, a new binary.
# Boite itself is never closed and never restarted.
#
# Usage:
#   claude-code-refresh.ps1              refresh the thread this runs in
#   claude-code-refresh.ps1 -All         refresh every registered session
#   claude-code-refresh.ps1 -List        show what would be refreshed
#   claude-code-refresh.ps1 -Idle        come back without picking the work up
#
# Exit codes: 0 = refresh scheduled, 2 = nothing to refresh, 3 = the wrapper is
# not in front of the session, so ending it would only stop the thread.

[CmdletBinding()]
param(
    [switch]$All,                 # every session in the registry, not just this one
    [switch]$List,                # say what would happen, end nothing
    [switch]$Idle,                # come back on the conversation and wait, no auto-resume turn
    [double]$Delay = 0,           # extra seconds before the process is ended
    [double]$Stagger = 0.4,       # seconds between two sessions coming back
    [string]$Message              # first turn of the resumed session; default is the auto-resume note
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')
. (Join-Path $PSScriptRoot 'claude-cc-threads.ps1')

$relaunch = Join-Path $PSScriptRoot 'claude-code-relaunch.ps1'
if (-not (Test-Path $relaunch)) {
    Write-Host "claude-code-relaunch.ps1 is missing - reinstall the toolkit." -ForegroundColor Red
    exit 2
}

$common = @{}
if ($Idle)    { $common['NoContinue'] = $true }
if ($Message) { $common['ContinueMessage'] = $Message }

function Show-Verdict($label, $code) {
    switch ($code) {
        0 { Write-Host "$label refreshing - about a second away." -ForegroundColor Cyan }
        2 { Write-Host "$label its process is gone already." -ForegroundColor Yellow }
        3 { Write-Host "$label the claude wrapper is not in front of it, so it cannot come back." -ForegroundColor Yellow
            Write-Host "  Run: pwsh -NoProfile -File `"$HOME\.claude-tools\claude-code-shim.ps1`" -Install, then restart Boite once." -ForegroundColor DarkGray }
        default { Write-Host "$label relaunch exit $code" -ForegroundColor Yellow }
    }
}

# -- Every registered session ---------------------------------------------------
if ($All -or $List) {
    $threads = @(Get-CcLiveThreads)
    if (-not $threads.Count) {
        Write-Host "No session is registered. The SessionStart hook is what fills the registry:" -ForegroundColor Yellow
        Write-Host "  pwsh -NoProfile -File `"$HOME\.claude-tools\claude-code-watch.ps1`" -InstallHook" -ForegroundColor DarkGray
        exit 2
    }
    $self = 0
    if ($env:CLAUDE_PID -and ($env:CLAUDE_PID -match '^\d+$')) { $self = [int]$env:CLAUDE_PID }

    if ($List) {
        Write-Host ("{0} session(s) registered:" -f $threads.Count) -ForegroundColor Cyan
        foreach ($t in $threads) {
            $tag = if ($t.pid -eq $self) { ' (this one)' } else { '' }
            Write-Host ("  pid {0,-7} {1}{2}" -f $t.pid, $t.workDir, $tag) -ForegroundColor DarkGray
        }
        exit 0
    }

    # This thread goes last: refreshing it ends the process running this script,
    # and the others would never be reached.
    $ordered = @($threads | Where-Object { $_.pid -ne $self }) + @($threads | Where-Object { $_.pid -eq $self })
    Write-Host ("Refreshing {0} session(s) - same panes, same conversations." -f $ordered.Count) -ForegroundColor Cyan
    $i = 0
    foreach ($t in $ordered) {
        & $relaunch -VictimPid ([int]$t.pid) -VictimStartedAt ([string]$t.startedAt) `
                    -SessionId $t.sessionId -AnyHost -Delay ($Delay + $Stagger * $i) @common
        Show-Verdict ("  pid $($t.pid):") $LASTEXITCODE
        $i++
    }
    exit 0
}

# -- Just this thread -----------------------------------------------------------
& $relaunch -Delay $Delay -AnyHost @common
$code = $LASTEXITCODE
Show-Verdict "This thread:" $code
exit $code
