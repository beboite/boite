# Takes back what the installer put down. The saved logins are left alone: they
# are the expensive thing to rebuild, and a reinstall finds them again.
[CmdletBinding()]
param(
    [string]$ToolsDir = (Join-Path $HOME '.claude-tools'),
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$claude = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }

function Say { param([string]$Text, [string]$Color) if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text } }

if (-not $Yes) {
    Say "This removes $ToolsDir, the slash commands and the profile function."
    Say 'Saved logins are not touched.' DarkGray
    if ((Read-Host 'Continue? [y/N]') -notmatch '^(y|yes)$') { Say 'Nothing removed.'; exit 0 }
}

if (Test-Path -LiteralPath $ToolsDir) {
    Remove-Item -LiteralPath $ToolsDir -Recurse -Force
    Say "Removed $ToolsDir" Green
}

$commands = Join-Path $claude 'commands'
if (Test-Path -LiteralPath $commands) {
    $gone = @(Get-ChildItem -LiteralPath $commands -File |
        Where-Object { $_.Name -like 'account-*.md' -or $_.Name -like 'claude-account-*.md' })
    $gone | Remove-Item -Force
    if ($gone.Count) { Say "Removed $($gone.Count) slash command(s)" Green }
}

# The function is one block between a marker and the line under it, so only
# those two lines go and anything else in the profile stays.
$profilePath = $PROFILE.CurrentUserAllHosts
if (Test-Path -LiteralPath $profilePath) {
    $lines = Get-Content -LiteralPath $profilePath
    $kept  = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*#\s*claude-cc account switcher') { $i++; continue }
        $kept += $lines[$i]
    }
    if ($kept.Count -ne $lines.Count) {
        Set-Content -LiteralPath $profilePath -Value $kept -Encoding utf8
        Say "Removed claude-cc from $profilePath" Green
    }
}

# The status line points at a file that no longer exists, so it goes too.
$settingsPath = Join-Path $claude 'settings.json'
if (Test-Path -LiteralPath $settingsPath) {
    try {
        $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        $line = $settings.PSObject.Properties['statusLine']
        if ($line -and "$($line.Value.command)" -like '*claude-cc-statusline*') {
            $settings.PSObject.Properties.Remove('statusLine')
            [IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
            Say 'Removed the status line from settings.json' Green
        }
    } catch { }
}

Say ''
Say 'Uninstalled. The saved logins are still in ~/.claude-cc-accounts and ~/.codex-cc-accounts.' DarkGray
exit 0
