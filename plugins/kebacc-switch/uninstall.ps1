# Takes back what the installer put down. The saved logins are left alone: they
# are the expensive thing to rebuild, and a reinstall finds them again.
[CmdletBinding()]
param(
    [string]$ToolsDir = (Join-Path $HOME '.claude-tools'),
    # Leave the shell profile alone. The profile is not under $ToolsDir and not
    # under CLAUDE_CONFIG_DIR, so it is the one thing a run against a sandbox
    # would still reach out and change.
    [switch]$NoProfileEdit,
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
if (-not $NoProfileEdit -and (Test-Path -LiteralPath $profilePath)) {
    $lines = Get-Content -LiteralPath $profilePath
    $kept  = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*#\s*kebacc-switch account switcher') { $i++; continue }
        $kept += $lines[$i]
    }
    if ($kept.Count -ne $lines.Count) {
        Set-Content -LiteralPath $profilePath -Value $kept -Encoding utf8
        Say "Removed kebacc-switch from $profilePath" Green
    }
}

# The status line and the session hook both point at files that no longer
# exist, so they go too. A hook left behind is worse than a stale setting: it
# fails at the start of every session the user opens from here on.
$settingsPath = Join-Path $claude 'settings.json'
if (Test-Path -LiteralPath $settingsPath) {
    try {
        $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        $touched = $false

        $line = $settings.PSObject.Properties['statusLine']
        # 5.x runs `kebacc-switch statusline`; 4.x ran a node script called
        # kebacc-switch-statusline.js. Both spellings match this.
        if ($line -and "$($line.Value.command)" -like '*kebacc-switch*statusline*') {
            $settings.PSObject.Properties.Remove('statusLine')
            Say 'Removed the status line from settings.json' Green
            $touched = $true
        }

        $hooks = $settings.PSObject.Properties['hooks']
        if ($hooks -and $hooks.Value.PSObject.Properties['SessionStart']) {
            $all  = @($hooks.Value.SessionStart)
            # Every spelling this toolkit ever wrote: the binary, the 4.x
            # dispatcher, the 3.x script. Whatever else the user put there is
            # left where it is.
            $kept = @($all | Where-Object {
                -not (@($_.hooks) | Where-Object { ("$($_.command)" -like '*kebacc-switch*auto*' -or "$($_.command)" -like '*claude-c*auto*') })
            })
            if ($kept.Count -ne $all.Count) {
                if ($kept.Count) { $hooks.Value.SessionStart = $kept }
                else { $hooks.Value.PSObject.Properties.Remove('SessionStart') }
                Say 'Removed the session hook from settings.json' Green
                $touched = $true
            }
        }

        if ($touched) {
            if (-not (Test-Path -LiteralPath "$settingsPath.cc-backup")) {
                Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.cc-backup" -Force
            }
            Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.cc-backup.prev" -Force
            $json = $settings | ConvertTo-Json -Depth 100
            try { $null = $json | ConvertFrom-Json } catch {
                Say "Refusing to rewrite $settingsPath: the result would not parse. Nothing changed." Red
                exit 1
            }
            [IO.File]::WriteAllText($settingsPath, $json, [Text.UTF8Encoding]::new($false))
        }
    } catch { }
}

Say ''
Say 'Uninstalled. The saved logins are still in ~/.kebacc-switch-accounts and ~/.kebacc-switch-codex-accounts.' DarkGray
exit 0
