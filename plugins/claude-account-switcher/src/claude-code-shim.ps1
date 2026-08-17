# Install the wrapper that lets a Boite thread restart itself after an account
# switch.
#
# Boite starts `claude` itself in the terminal of a thread and never starts it
# again when that process dies, so a switch used to cost a restart of the whole
# app. With this wrapper first on PATH, the process Boite spawns is the wrapper
# and Claude Code is its child: when the child is ended with a marker file next
# to it, the wrapper starts Claude Code again in the very same terminal, on the
# same conversation, and that fresh process reads the credentials that were just
# swapped. Nothing else changes - without a marker the wrapper only forwards the
# exit code, so every other `claude` call behaves as before.
#
# A marker is a command line the wrapper runs, so it is signed with the account
# pool's key (~/.claude-cc-accounts/.pool.key, DPAPI-encrypted for this user)
# and the wrapper ignores anything it cannot verify.
#
# -Install compiles the wrapper and puts its directory in front of the user PATH
# (csc.exe ships with Windows, so nothing has to be downloaded). -Status reports
# what is in place, -Uninstall removes both.
#
# Boite reads PATH when it starts, so it has to be restarted once after the
# install - once, not at every switch.

param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$Status,
    [string]$RealBin      # path to the real claude.exe; detected when omitted
)

$ErrorActionPreference = 'Stop'
$shimDir = Join-Path $HOME '.claude-tools\shim'
$shimExe = Join-Path $shimDir 'claude.exe'
$pinFile = Join-Path $shimDir 'real-bin.txt'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

# The wrapper's source lives in one file, next to this script. It used to be
# embedded in this script as well, and the two copies drifted: what got
# installed was not what the repository said the wrapper did.
$sourceFile = @(
    (Join-Path $PSScriptRoot 'shim\claude-shim.cs'),
    (Join-Path $PSScriptRoot 'claude-shim.cs')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

function Get-UserPathParts { @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ }) }

# The real binary, found the way the wrapper would look for it - minus the PATH
# scan, which by then points at the wrapper itself.
function Find-RealClaude {
    if ($RealBin) { return $RealBin }
    $guess = Join-Path $HOME '.local\bin\claude.exe'
    if (Test-Path $guess) { return $guess }
    $onPath = Get-Command claude.exe -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -and $_.Source -ne $shimExe } | Select-Object -First 1
    if ($onPath) { return $onPath.Source }
    return $null
}

function Show-Status {
    $parts = Get-UserPathParts
    $onPath = $parts -contains $shimDir
    $first = $false
    if ($onPath) {
        $real = $parts | Where-Object { Test-Path (Join-Path $_ 'claude.exe') } | Select-Object -First 1
        $first = ($real -eq $shimDir)
    }
    Write-Host ("wrapper built    : {0}" -f $(if (Test-Path $shimExe) { $shimExe } else { 'no' }))
    Write-Host ("on the user PATH : {0}" -f $(if ($onPath) { if ($first) { 'yes, in front' } else { 'yes, but behind another claude.exe' } } else { 'no' }))
    $pinned = if (Test-Path $pinFile) { (Get-Content $pinFile -Raw).Trim() } else { $null }
    Write-Host ("runs             : {0}" -f $(if ($pinned) { $pinned } else { 'not pinned - it will search PATH' }))
    if ($pinned -and -not (Test-Path $pinned)) {
        Write-Host "  (that path no longer exists - run this with -Install again)" -ForegroundColor Yellow
    }
    $key = Join-Path $HOME '.claude-cc-accounts\.pool.key'
    Write-Host ("marker signing   : {0}" -f $(if (Test-Path $key) { 'on (markers must be signed with the pool key)' } else { 'off (no pool key yet - run claude-code-add once)' }))
    $live = (Get-Command claude -ErrorAction SilentlyContinue).Source
    Write-Host ("claude resolves to : {0}" -f $(if ($live) { $live } else { 'nothing' }))
    if ($live -and (Test-Path $shimExe) -and $live -ne $shimExe) {
        Write-Host "  (this shell was started before the install; new processes get the wrapper)" -ForegroundColor DarkGray
    }
}

if ($Uninstall) {
    $parts = Get-UserPathParts | Where-Object { $_ -ne $shimDir }
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    Remove-Item -LiteralPath $shimDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Wrapper removed. Restart Boite for it to stop using it." -ForegroundColor Green
    exit 0
}

if ($Status -or (-not $Install)) { Show-Status; exit 0 }

if (-not $sourceFile) {
    Write-Host "claude-shim.cs was not found next to this script - reinstall the toolkit." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $csc)) {
    Write-Host "csc.exe was not found at $csc - .NET Framework 4 is missing." -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
$srcFile = Join-Path $shimDir 'claude-shim.cs'
# Installed in ~/.claude-tools, this script's source IS that file already.
if ((Resolve-Path -LiteralPath $sourceFile).Path -ne $srcFile) {
    Copy-Item -LiteralPath $sourceFile -Destination $srcFile -Force
}

# A wrapper that is running cannot be overwritten, and it is running in every
# thread Boite has open: build next to it and swap.
$tmpExe = Join-Path $shimDir 'claude.new.exe'
# System.Security.dll is where ProtectedData lives, which is what reads the
# DPAPI-encrypted pool key the marker signatures are checked against.
& $csc /nologo /target:exe /platform:anycpu /optimize+ /reference:System.Security.dll /out:"$tmpExe" "$srcFile"
if ($LASTEXITCODE -ne 0) { Write-Host "The wrapper did not compile." -ForegroundColor Red; exit 1 }
try {
    Move-Item -LiteralPath $tmpExe -Destination $shimExe -Force
} catch {
    # A running wrapper cannot be overwritten, and one is running in every open
    # thread - but Windows does allow renaming a file that is in use, so the old
    # binary is moved aside and the new one takes its name. The threads already
    # running keep the old code until they restart, which is what they would do
    # anyway.
    $parked = Join-Path $shimDir ("claude.old-{0}.exe" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try {
        Move-Item -LiteralPath $shimExe -Destination $parked -Force
        Move-Item -LiteralPath $tmpExe -Destination $shimExe -Force
        Write-Host "The old wrapper was in use; it was parked as $(Split-Path $parked -Leaf)." -ForegroundColor DarkGray
    } catch {
        Write-Host "Built, but $shimExe is in use and could not be replaced - close the threads running it and run this again." -ForegroundColor Yellow
        exit 1
    }
}
# Parked copies from earlier upgrades, once nothing is running them any more.
Get-ChildItem $shimDir -Filter 'claude.old-*.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

# Pin the binary the wrapper runs. Without this it falls back to scanning PATH,
# which means it would run whatever claude.exe someone else put there, with the
# arguments of every thread.
$real = Find-RealClaude
if ($real) {
    [System.IO.File]::WriteAllText($pinFile, $real, (New-Object System.Text.UTF8Encoding($false)))
} else {
    Write-Host "! The real claude.exe was not found - pass -RealBin <path> so the wrapper does not have to search PATH." -ForegroundColor Yellow
}

$parts = Get-UserPathParts
if ($parts[0] -ne $shimDir) {
    $parts = @($shimDir) + ($parts | Where-Object { $_ -ne $shimDir })
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    Write-Host "Wrapper installed and put in front of the user PATH." -ForegroundColor Green
} else {
    Write-Host "Wrapper rebuilt; the PATH was already pointing at it." -ForegroundColor Green
}
Write-Host "Restart Boite once so its threads start through the wrapper." -ForegroundColor Cyan
Write-Host ""
Show-Status
