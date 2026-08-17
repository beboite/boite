<#
    Claude Account Switcher - uninstaller

    One-line uninstall:
      irm https://raw.githubusercontent.com/karthiknl0/claude-account-switcher/main/uninstall.ps1 | iex

    Removes the scripts, the Desktop shortcuts, the `claude` wrapper (and its
    entry on your PATH), and the managed block from your PowerShell profiles.

    Does NOT touch your saved accounts (~/.claude-cc-accounts) or your Claude
    login, so reinstalling picks the pool back up. Remove them yourself if you
    mean to:
      Remove-Item -Recurse -Force ~/.claude-cc-accounts
#>

Write-Host "Removing Claude Account Switcher..." -ForegroundColor Cyan

# 1. The wrapper first: it has to come off the PATH before its folder goes, or
#    every new shell would resolve `claude` to something that is not there.
$ToolsDir = Join-Path $env:USERPROFILE '.claude-tools'
$shimDir  = Join-Path $ToolsDir 'shim'
$userPath = @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ })
if ($userPath -contains $shimDir) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath | Where-Object { $_ -ne $shimDir }) -join ';'), 'User')
    Write-Host " - removed $shimDir from the user PATH"
}

# 1b. The watcher: stop it before its script is deleted, and take the scheduled
#     task with it, or it would fire at every logon on a missing file.
$watchPidFile = Join-Path $env:USERPROFILE '.claude-cc-accounts\.watch.pid'
if (Test-Path $watchPidFile) {
    # The pid is checked before anything is stopped: pids are reused, and a file
    # left behind by a crash names whatever process inherited the number.
    $raw = ''
    try { $raw = ((Get-Content -LiteralPath $watchPidFile -Raw -ErrorAction SilentlyContinue) + '').Trim() } catch {}
    if ($raw -match '^\d+$') {
        $p = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -match '^(pwsh|powershell)$') {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            Write-Host " - stopped the account watcher (pid $($p.Id))"
        }
    }
    Remove-Item -Force $watchPidFile -ErrorAction SilentlyContinue
}
Remove-Item -Force (Join-Path $env:USERPROFILE '.claude-cc-accounts\.watch.state') -ErrorAction SilentlyContinue
if (Get-ScheduledTask -TaskName 'ClaudeCodeAccountWatch' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName 'ClaudeCodeAccountWatch' -Confirm:$false
    Write-Host " - removed the 'ClaudeCodeAccountWatch' scheduled task"
}
# The registry of live sessions describes processes, not accounts: nothing in it
# survives a reboot, so it goes with the tools.
Remove-Item -Force (Join-Path $env:USERPROFILE '.claude-cc-accounts\.threads.state') -ErrorAction SilentlyContinue

# 1c. The SessionStart hook that registers sessions, left in place, would run a
#     script that no longer exists.
$settings = Join-Path $env:USERPROFILE '.claude\settings.json'
if ((Test-Path $settings) -and (Select-String -Path $settings -Pattern 'claude-code-hook.ps1' -Quiet)) {
    Write-Host " ! ~/.claude/settings.json still has a SessionStart hook calling claude-code-hook.ps1" -ForegroundColor Yellow
    Write-Host "   remove that entry by hand - this uninstaller does not edit your settings." -ForegroundColor Yellow
}

# 2. Tools dir
if (Test-Path $ToolsDir) {
    try {
        Remove-Item -Recurse -Force $ToolsDir -ErrorAction Stop
        Write-Host " - removed $ToolsDir"
    } catch {
        Write-Host " - $ToolsDir could not be fully removed (the wrapper is still running in an open thread)" -ForegroundColor Yellow
        Write-Host "   close those terminals, then delete the folder." -ForegroundColor Yellow
    }
}

# 2b. The slash commands this installer wrote into ~/.claude/commands. Only
#     those two: anything else in that folder belongs to the user.
$commandsDir = Join-Path $env:USERPROFILE '.claude\commands'
foreach ($cmd in @('refresh-t.md', 'refresh-a.md', 'claude-account-status.md', 'claude-account-list.md',
                   'claude-account-switch.md', 'claude-account-auto-switch.md', 'claude-account-add.md',
                   'claude-account-remove.md')) {
    $p = Join-Path $commandsDir $cmd
    if (Test-Path $p) { Remove-Item -Force $p -ErrorAction SilentlyContinue; Write-Host " - removed /$($cmd -replace '\.md$','')" }
}

# 3. Relaunch markers, which are only meaningful with the wrapper installed
$markerDir = Join-Path $env:LOCALAPPDATA 'claude-cc-relaunch'
if (Test-Path $markerDir) { Remove-Item -Recurse -Force $markerDir -ErrorAction SilentlyContinue }

# 4. Desktop shortcuts
$desktop = [Environment]::GetFolderPath('Desktop')
foreach ($name in @('Claude Switch Account.lnk', 'Claude Code Switch.lnk', 'Claude Code Accounts.lnk',
                    'Claude Code.lnk', 'Claude Code Resume.lnk', 'Claude Code Continue.lnk')) {
    $lnk = Join-Path $desktop $name
    if (Test-Path $lnk) { Remove-Item -Force $lnk; Write-Host " - removed shortcut: $name" }
}

# 5. The managed block in both profiles, plus the un-delimited block older
#    versions wrote before the markers existed.
$beginMark = '# >>> claude-account-switcher >>>'
$endMark   = '# <<< claude-account-switcher <<<'
$docs = [Environment]::GetFolderPath('MyDocuments')
$profiles = @(
    (Join-Path $docs 'WindowsPowerShell\Microsoft.PowerShell_profile.ps1'),
    (Join-Path $docs 'PowerShell\Microsoft.PowerShell_profile.ps1')
)
foreach ($pf in $profiles) {
    if (-not (Test-Path $pf)) { continue }
    $c = Get-Content $pf -Raw -ErrorAction SilentlyContinue
    if ($null -eq $c) { continue }
    $pattern = [Regex]::Escape($beginMark) + '.*?' + [Regex]::Escape($endMark)
    $new = [Regex]::Replace($c, $pattern, '', 'Singleline')
    $new = $new -replace '(?s)\r?\n#\s*Claude desktop account switcher[^\r\n]*.*?function\s+claude-add-account\s*\{[^}]*\}', ''
    if ($new -ne $c) {
        Set-Content -Path $pf -Value ($new.TrimEnd() + "`r`n") -Encoding UTF8
        Write-Host " - cleaned $pf"
    }
}

Write-Host "Done. Open a new PowerShell window for changes to take effect." -ForegroundColor Green
Write-Host "Your saved accounts are still in ~/.claude-cc-accounts." -ForegroundColor DarkGray
