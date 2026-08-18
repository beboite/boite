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
    # Run `auto` once as each session starts, for these pools. Off by default:
    # it changes which login the next session answers as.
    [ValidateSet('claude', 'codex', 'all')]
    [string]$AutoSwitch,
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

# settings.json belongs to the user, so it is read, amended and written back
# whole rather than rebuilt, and a copy is kept the first time this touches it.
$settingsPath = Join-Path $claude 'settings.json'

function Read-CcSettings {
    if (-not (Test-Path -LiteralPath $settingsPath)) { return [pscustomobject]@{} }
    return Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
}

function Write-CcSettings {
    param([psobject]$Settings)
    if ((Test-Path -LiteralPath $settingsPath) -and -not (Test-Path -LiteralPath "$settingsPath.cc-backup")) {
        Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.cc-backup" -Force
    }
    [IO.File]::WriteAllText($settingsPath, ($Settings | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
}

if ($StatusLine) {
    $node = Get-Command node -ErrorAction Ignore
    if (-not $node) {
        Say 'Skipped the status line: node is not on PATH.' Yellow
    } else {
        $settings = Read-CcSettings
        $line = [pscustomobject]@{
            type    = 'command'
            command = "node `"$(Join-Path $ToolsDir 'claude-cc-statusline.js')`""
        }
        $settings | Add-Member -NotePropertyName statusLine -NotePropertyValue $line -Force
        Write-CcSettings $settings
        Say "Pointed the Claude Code status line at the switcher ($settingsPath)" Green
    }
}

if ($AutoSwitch) {
    $settings = Read-CcSettings
    $entry = (Join-Path $ToolsDir 'claude-cc.ps1') -replace '\\', '/'
    # Silent, and always successful. What a SessionStart hook writes to stdout is
    # fed to the model, and a non-zero exit is shown to the user at every start —
    # which `auto` returns for a pool too small to switch in, a normal state.
    $command = "pwsh -NoProfile -Command `"& '$entry' auto -Provider $AutoSwitch -Quiet *> `$null; exit 0`""

    $hooks = if ($settings.PSObject.Properties['hooks']) { $settings.hooks } else { [pscustomobject]@{} }
    # Anything this installed before is replaced, not stacked: running the
    # installer twice must leave one hook, and switching scope must not keep the
    # old scope running beside the new one.
    $others = @()
    if ($hooks.PSObject.Properties['SessionStart']) {
        $others = @($hooks.SessionStart | Where-Object {
            -not (@($_.hooks) | Where-Object { "$($_.command)" -like '*claude-c*auto*' })
        })
    }
    $group = [pscustomobject]@{
        hooks = @([pscustomobject]@{ type = 'command'; command = $command; timeout = 25 })
    }
    $hooks | Add-Member -NotePropertyName SessionStart -NotePropertyValue ($others + $group) -Force
    $settings | Add-Member -NotePropertyName hooks -NotePropertyValue $hooks -Force
    Write-CcSettings $settings
    Say "Each session will now run: claude-cc auto -Provider $AutoSwitch" Green
}

Say ''
Say "claude-cc $version is installed." Green
Say '  claude-cc add            save the login you are on' DarkGray
Say '  claude-cc list           what is saved, and its quota' DarkGray
Say '  claude-cc doctor -Provider all   check everything' DarkGray
exit 0
