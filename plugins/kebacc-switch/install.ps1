# Puts the switcher on this machine.
#
# This step downloads nothing. The switcher is a binary, built from
# `crates/kebacc-switch` by the same `cargo build` that builds Boite, and this
# copies the one that came out of that build into place. Run it again to update —
# it overwrites what it owns and never touches the pools.
#
# Once installed, the switcher keeps itself up to date from its own GitHub
# releases: it checks once a day at session start and installs in the background.
# Pass -NoAutoUpdate to write KEBACC_SWITCH_UPDATE=off into the Claude Code
# settings instead.
[CmdletBinding()]
param(
    [string]$ToolsDir = (Join-Path $HOME '.claude-tools'),
    # The binary to install. Found in the workspace's target directory when this
    # is not given.
    [string]$Binary,
    # Point Claude Code's status line at the one shipped here. Off by default:
    # it is the only thing an install would change that the user can see.
    [switch]$StatusLine,
    # Run `auto` once as each session starts, for these pools. Off by default:
    # it changes which login the next session answers as.
    [ValidateSet('claude', 'codex', 'all')]
    [string]$AutoSwitch,
    [switch]$NoProfileEdit,
    # Turn the daily self-update off for this machine.
    [switch]$NoAutoUpdate
)

$ErrorActionPreference = 'Stop'

$version  = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'VERSION') -Raw).Trim()
$source   = Join-Path $PSScriptRoot 'src'
$claude   = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$exeName  = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'kebacc-switch.exe' } else { 'kebacc-switch' }

function Say { param([string]$Text, [string]$Color) if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text } }

# The workspace root is two directories up from the plugin, and cargo puts the
# binary under it. A release build is preferred over a debug one; between two of
# the same kind, the newer wins.
function Find-SwitcherBinary {
    if ($Binary) {
        if (-not (Test-Path -LiteralPath $Binary)) { throw "No binary at $Binary." }
        return (Resolve-Path -LiteralPath $Binary).Path
    }
    $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    foreach ($profileDir in @('release', 'debug')) {
        $candidate = Join-Path $root (Join-Path 'target' (Join-Path $profileDir $exeName))
        if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    return $null
}

$built = Find-SwitcherBinary
if (-not $built) {
    Say "No kebacc-switch binary found. Build it first: cargo build --release -p kebacc-switch" Red
    exit 1
}

if (-not (Test-Path -LiteralPath $ToolsDir)) { New-Item -ItemType Directory -Path $ToolsDir -Force | Out-Null }

# Versions before this one were a set of PowerShell scripts and a node status
# line, dot-sourced from this same directory. Left in place they would still be
# on the PATH of a hook or a status line written by an earlier install.
#
# Named one by one on purpose: $ToolsDir is a shared directory and a wildcard
# sweep here would delete files this installer never wrote.
$legacy = @(
    'claude-cc.ps1', 'claude-cc-core.ps1', 'claude-cc-usage.ps1',
    'claude-cc-pool.ps1', 'claude-cc-statusline.ps1', 'claude-cc-providers.ps1',
    'kebacc-switch.ps1', 'statusline.js', 'claude-cc.js', 'package.json'
)
foreach ($name in $legacy) {
    $stale = Join-Path $ToolsDir $name
    if (Test-Path -LiteralPath $stale -PathType Leaf) { Remove-Item -LiteralPath $stale -Force }
}

$entry = Join-Path $ToolsDir $exeName
# A running switcher cannot be overwritten on Windows, and a status line runs
# often enough that this is worth saying rather than throwing.
try {
    Copy-Item -LiteralPath $built -Destination $entry -Force
} catch {
    Say "Could not replace $entry — something is running it. Close it and try again." Red
    exit 1
}
if (-not ($IsWindows -or $env:OS -eq 'Windows_NT')) { chmod 700 $entry }
Say "Installed kebacc-switch into $ToolsDir" Green

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

# `kebacc-switch` as a shell function rather than a directory on the PATH: it is one
# line to add, and an earlier version of this toolkit put a `claude.exe` shim on
# the PATH that nobody wants back.
if (-not $NoProfileEdit) {
    $marker = '# kebacc-switch account switcher'
    $block  = @(
        $marker
        "function kebacc-switch { & `"$entry`" @args }"
    ) -join [Environment]::NewLine

    $profilePath = $PROFILE.CurrentUserAllHosts
    $profileDir  = Split-Path -Parent $profilePath
    if (-not (Test-Path -LiteralPath $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
    $existing = if (Test-Path -LiteralPath $profilePath) { Get-Content -LiteralPath $profilePath -Raw } else { '' }
    if ($existing -notmatch [regex]::Escape($marker)) {
        Add-Content -LiteralPath $profilePath -Value ([Environment]::NewLine + $block)
        Say "Added kebacc-switch to $profilePath" Green
        Say 'Open a new shell for it to exist there.' DarkGray
    } else {
        # The old line ran the script through pwsh. Same marker, different body.
        $updated = $existing -replace '(?m)^function kebacc-switch \{.*\}$', "function kebacc-switch { & `"$entry`" @args }"
        if ($updated -ne $existing) {
            [IO.File]::WriteAllText($profilePath, $updated, [Text.UTF8Encoding]::new($false))
            Say "Pointed kebacc-switch in $profilePath at the binary" Green
        } else {
            Say 'kebacc-switch is already in the PowerShell profile.' DarkGray
        }
    }
}

# settings.json belongs to the user, so it is read, amended and written back
# whole rather than rebuilt, and a copy is kept the first time this touches it.
$settingsPath = Join-Path $claude 'settings.json'

function Read-ClaudeSettings {
    if (-not (Test-Path -LiteralPath $settingsPath)) { return [pscustomobject]@{} }
    return Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
}

function Write-ClaudeSettings {
    param([psobject]$Settings)
    if (Test-Path -LiteralPath $settingsPath) {
        # `.cc-backup` is the file as it was before this installer ever ran and is
        # never overwritten; `.cc-backup.prev` is the state before this run.
        if (-not (Test-Path -LiteralPath "$settingsPath.cc-backup")) {
            Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.cc-backup" -Force
        }
        Copy-Item -LiteralPath $settingsPath -Destination "$settingsPath.cc-backup.prev" -Force
    }
    # Deep rather than 20: the default silently truncates anything nested deeper,
    # and settings.json is the user's file, not ours to shorten.
    $json = $Settings | ConvertTo-Json -Depth 100
    # A round trip that cannot be read back means the write would corrupt the
    # file, so nothing is written at all.
    try { $null = $json | ConvertFrom-Json } catch {
        Say "Refusing to rewrite $settingsPath — the result would not parse. Nothing changed." Red
        exit 1
    }
    [IO.File]::WriteAllText($settingsPath, $json, [Text.UTF8Encoding]::new($false))
}

# Forward slashes throughout: these strings end up in JSON, where a backslash is
# an escape.
$command = ($entry -replace '\\', '/')

if ($StatusLine) {
    $settings = Read-ClaudeSettings
    $line = [pscustomobject]@{
        type    = 'command'
        command = "`"$command`" statusline"
    }
    $settings | Add-Member -NotePropertyName statusLine -NotePropertyValue $line -Force
    Write-ClaudeSettings $settings
    Say "Pointed the Claude Code status line at the switcher ($settingsPath)" Green
}

if ($AutoSwitch) {
    $settings = Read-ClaudeSettings
    # `-Hook` is what makes this safe to run at every session start: it prints
    # nothing, where stdout would be fed to the model, and it exits 0, where a
    # non-zero exit would be shown to the user — which `auto` returns for a pool
    # too small to switch in, a normal state.
    $hookCommand = "`"$command`" auto -Provider $AutoSwitch -Hook"

    $hooks = if ($settings.PSObject.Properties['hooks']) { $settings.hooks } else { [pscustomobject]@{} }
    # Anything this installed before is replaced, not stacked: running the
    # installer twice must leave one hook, and switching scope must not keep the
    # old scope running beside the new one.
    $others = @()
    if ($hooks.PSObject.Properties['SessionStart']) {
        $others = @($hooks.SessionStart | Where-Object {
            -not (@($_.hooks) | Where-Object { ("$($_.command)" -like '*kebacc-switch*auto*' -or "$($_.command)" -like '*claude-c*auto*') })
        })
    }
    $group = [pscustomobject]@{
        hooks = @([pscustomobject]@{ type = 'command'; command = $hookCommand; timeout = 25 })
    }
    $hooks | Add-Member -NotePropertyName SessionStart -NotePropertyValue ($others + $group) -Force
    $settings | Add-Member -NotePropertyName hooks -NotePropertyValue $hooks -Force
    Write-ClaudeSettings $settings
    Say "Each session will now run: kebacc-switch auto -Provider $AutoSwitch" Green
}

if ($NoAutoUpdate) {
    $settings = Read-ClaudeSettings
    $envBlock = if ($settings.PSObject.Properties['env']) { $settings.env } else { [pscustomobject]@{} }
    $envBlock | Add-Member -NotePropertyName KEBACC_SWITCH_UPDATE -NotePropertyValue 'off' -Force
    $settings | Add-Member -NotePropertyName env -NotePropertyValue $envBlock -Force
    Write-ClaudeSettings $settings
    Say "The switcher will not update itself: KEBACC_SWITCH_UPDATE=off ($settingsPath)" Yellow
}

Say ''
Say "kebacc-switch $version is installed." Green
Say '  kebacc-switch add            save the login you are on' DarkGray
Say '  kebacc-switch list           what is saved, and its quota' DarkGray
Say '  kebacc-switch doctor -Provider all   check everything' DarkGray
exit 0
