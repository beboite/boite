# Puts the switcher on this machine.
#
# Nothing is downloaded: the files come from `src/` beside this script, or they
# are already in place because Boite wrote them there before running this. Run
# it again to update — it overwrites what it owns and never touches the pools.
[CmdletBinding()]
param(
    [string]$ToolsDir = (Join-Path $HOME '.claude-tools'),
    # Point Claude Code's status line at the one shipped here. Off by default:
    # it is the only thing an install would change that the user can see.
    [switch]$StatusLine,
    [switch]$NoProfileEdit
)

$ErrorActionPreference = 'Stop'

$version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'VERSION') -Raw).Trim()
$source  = Join-Path $PSScriptRoot 'src'
$claude  = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }

function Say { param([string]$Text, [string]$Color) if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text } }

if (-not (Test-Path -LiteralPath $ToolsDir)) { New-Item -ItemType Directory -Path $ToolsDir -Force | Out-Null }

if (Test-Path -LiteralPath $source) {
    # Stale files from an older layout would still be dot-sourced, so what this
    # owns is cleared rather than merged.
    Get-ChildItem -LiteralPath $ToolsDir -Filter '*.ps1' -File | Remove-Item -Force
    Get-ChildItem -LiteralPath $ToolsDir -Filter '*.js' -File | Remove-Item -Force
    Copy-Item -Path (Join-Path $source '*') -Destination $ToolsDir -Recurse -Force -Exclude 'commands'
    Say "Installed the tools into $ToolsDir" Green
} else {
    Say "Using the files already in $ToolsDir" DarkGray
}

$entry = Join-Path $ToolsDir 'claude-cc.ps1'
if (-not (Test-Path -LiteralPath $entry)) {
    Say "claude-cc.ps1 is missing from $ToolsDir. Nothing was installed." Red
    exit 1
}

# The slash commands, which is how the switcher is used from inside Claude Code.
$commandSource = Join-Path $source 'commands'
$commandTarget = Join-Path $claude 'commands'
if (Test-Path -LiteralPath $commandSource) {
    if (-not (Test-Path -LiteralPath $commandTarget)) { New-Item -ItemType Directory -Path $commandTarget -Force | Out-Null }
    # Names from earlier versions, so an update does not leave two of each.
    Get-ChildItem -LiteralPath $commandTarget -Filter 'claude-account-*.md' -File -ErrorAction Ignore | Remove-Item -Force
    Get-ChildItem -LiteralPath $commandTarget -Filter 'account-*.md' -File -ErrorAction Ignore | Remove-Item -Force
    # Two commands from a version that had a thread relauncher. Nothing answers
    # them any more, and they still show up in the slash command list.
    foreach ($dead in @('refresh-a.md', 'refresh-t.md')) {
        Remove-Item -LiteralPath (Join-Path $commandTarget $dead) -Force -ErrorAction Ignore
    }
    Copy-Item -Path (Join-Path $commandSource '*.md') -Destination $commandTarget -Force
    Say "Installed the slash commands into $commandTarget" Green
}

Set-Content -LiteralPath (Join-Path $ToolsDir '.version') -Value $version -NoNewline -Encoding utf8

# The status line is a CommonJS script, and node decides that from the nearest
# package.json rather than from the file. A `type: module` one further up the
# home directory would otherwise break it.
[IO.File]::WriteAllText(
    (Join-Path $ToolsDir 'package.json'),
    '{ "type": "commonjs" }',
    [Text.UTF8Encoding]::new($false))

# `claude-cc` as a shell function rather than a file on the PATH: it is one line
# to add, it needs no directory of its own, and it works the same on all three
# platforms.
if (-not $NoProfileEdit) {
    $marker = '# claude-cc account switcher'
    $block  = @(
        $marker
        "function claude-cc { pwsh -NoProfile -File `"$entry`" @args }"
    ) -join [Environment]::NewLine

    $profilePath = $PROFILE.CurrentUserAllHosts
    $profileDir  = Split-Path -Parent $profilePath
    if (-not (Test-Path -LiteralPath $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
    $existing = if (Test-Path -LiteralPath $profilePath) { Get-Content -LiteralPath $profilePath -Raw } else { '' }
    if ($existing -notmatch [regex]::Escape($marker)) {
        Add-Content -LiteralPath $profilePath -Value ([Environment]::NewLine + $block)
        Say "Added claude-cc to $profilePath" Green
        Say 'Open a new shell for it to exist there.' DarkGray
    } else {
        Say 'claude-cc is already in the PowerShell profile.' DarkGray
    }
}

if ($StatusLine) {
    $node = Get-Command node -ErrorAction Ignore
    if (-not $node) {
        Say 'Skipped the status line: node is not on PATH.' Yellow
    } else {
        $settingsPath = Join-Path $claude 'settings.json'
        $settings = if (Test-Path -LiteralPath $settingsPath) {
            Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        } else {
            [pscustomobject]@{}
        }
        $line = [pscustomobject]@{
            type    = 'command'
            command = "node `"$(Join-Path $ToolsDir 'claude-cc-statusline.js')`""
        }
        $settings | Add-Member -NotePropertyName statusLine -NotePropertyValue $line -Force
        $json = $settings | ConvertTo-Json -Depth 20
        [IO.File]::WriteAllText($settingsPath, $json, [Text.UTF8Encoding]::new($false))
        Say "Pointed the Claude Code status line at the switcher ($settingsPath)" Green
    }
}

Say ''
Say "claude-cc $version is installed." Green
Say '  claude-cc add            save the login you are on' DarkGray
Say '  claude-cc list           what is saved, and its quota' DarkGray
Say '  claude-cc doctor -Provider all   check everything' DarkGray
exit 0
