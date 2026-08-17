<#
    Claude Account Switcher - installer

    One-line install:
      Windows (PowerShell):
        irm https://raw.githubusercontent.com/karthiknl0/claude-account-switcher/main/install.ps1 | iex
      macOS / Linux (needs PowerShell - https://aka.ms/powershell):
        pwsh -c "irm https://raw.githubusercontent.com/karthiknl0/claude-account-switcher/main/install.ps1 | iex"

    Installs (Windows):
      - ~/.claude-tools/*.ps1 - the Claude Code account pool: save, list, switch,
        auto-switch on a rate limit, and refresh a running session in place
      - ~/.claude-tools/shim/claude-shim.cs - source of the wrapper that lets a
        thread restart itself (built on demand by claude-code-shim.ps1 -Install)
      - the desktop-app switcher (claude.ai chats)
      - claude-code-* commands in your PowerShell profiles (5.1 and 7)
      - Desktop shortcuts

    Installs (macOS / Linux):
      - the same Claude Code scripts in ~/.claude-tools
      - claude-code-* functions in your shell (~/.bashrc and ~/.zshrc), each
        invoking `pwsh`
      (The desktop-app switcher and the refresh wrapper are Windows-only.)

    Every file is checked against SHA256SUMS before it is installed, so a
    truncated or tampered download cannot land in ~/.claude-tools.

    No npm required - it works directly on Claude's credentials.
#>

$RawBase     = 'https://raw.githubusercontent.com/karthiknl0/claude-account-switcher/main'
$ToolsDir    = Join-Path $HOME '.claude-tools'
$VersionPath = Join-Path $ToolsDir '.version'

# -- Platform detection ($IsWindows etc. only exist on PowerShell Core/7+) -----
$PlatformWin = $true; $PlatformMac = $false
if (Test-Path variable:IsWindows) { $PlatformWin = $IsWindows }
if (Test-Path variable:IsMacOS)   { $PlatformMac = $IsMacOS }

# The Claude Code stack, in dependency order. The common library and the pool
# are dot-sourced by everything else, so a partial install is not a working one.
$CoreFiles = @(
    'claude-cc.ps1',
    'claude-cc-common.ps1',
    'claude-cc-pool.ps1',
    'claude-cc-threads.ps1',
    'claude-code-add.ps1',
    'claude-code-select.ps1',
    'claude-code-auto.ps1',
    'claude-code-list.ps1',
    'claude-code-remove.ps1',
    'claude-code-renew.ps1',
    'claude-code-relaunch.ps1',
    'claude-code-refresh.ps1',
    'claude-code-run.ps1',
    'claude-code-watch.ps1',
    'claude-code-hook.ps1',
    'claude-code-doctor.ps1',
    # The status-line segment and its installer. Copied in, never turned on:
    # the status line belongs to whoever configured it, and
    # `claude-cc statusline install` is the opt-in.
    'claude-cc-statusline.ps1',
    'claude-cc-statusline.js'
)
# Slash commands for Claude Code itself, installed into ~/.claude/commands.
$CommandFiles = @('refresh-t.md', 'refresh-a.md',
                   'claude-account-list.md', 'claude-account-switch.md',
                   'claude-account-auto-switch.md', 'claude-account-add.md',
                   'claude-account-remove.md')
# Windows-only: the in-place refresh wrapper and the desktop-app switcher.
$WinFiles = @('claude-code-shim.ps1', 'shim/claude-shim.cs', 'claude-switch.ps1', 'claude-add.ps1')

Write-Host ""
Write-Host "=== Claude Account Switcher - installer ===" -ForegroundColor Cyan

# 1. Fetch the scripts, checked against the published hashes.
Write-Host "[1/3] Installing scripts to $ToolsDir ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

# SHA256SUMS is `<hex>  src/<name>` per line, the sha256sum format.
$sums = @{}
try {
    $sumText = (Invoke-WebRequest -Uri "$RawBase/SHA256SUMS" -UseBasicParsing -TimeoutSec 20).Content
    foreach ($line in ($sumText -split "`n")) {
        $m = [regex]::Match($line.Trim(), '^([0-9a-fA-F]{64})\s+\*?(.+)$')
        if ($m.Success) { $sums[$m.Groups[2].Value.Trim()] = $m.Groups[1].Value.ToLower() }
    }
} catch {
    Write-Host "ERROR: SHA256SUMS could not be downloaded, so nothing can be verified." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    return
}
if ($sums.Count -eq 0) {
    Write-Host "ERROR: SHA256SUMS was empty or malformed - refusing to install unverified files." -ForegroundColor Red
    return
}

# Hashed with line endings normalised to LF and no BOM: git may hand out CRLF
# on one machine and LF on another for the very same commit, and a checksum that
# fails on a checkout setting would only teach people to skip the check. It
# still catches a truncated download and a changed line.
function Get-TextSha256($text) {
    $norm = ($text -replace "`r`n", "`n").TrimStart([char]0xFEFF)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($norm))
        return [System.BitConverter]::ToString($bytes).Replace('-', '').ToLower()
    } finally { $sha.Dispose() }
}

# Downloaded into memory, verified, and only then written: a file that fails the
# check must never exist on disk, or the next run would load it.
function Install-VerifiedFile($relPath, $targetDir) {
    if (-not $targetDir) { $targetDir = $ToolsDir }
    $url  = "$RawBase/src/$relPath"
    $want = $sums["src/$relPath"]
    if (-not $want) { throw "src/$relPath is not listed in SHA256SUMS" }
    $body = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30).Content
    if ($body -is [byte[]]) { $body = [System.Text.Encoding]::UTF8.GetString($body) }
    # GitHub serves the file as it is stored (LF); normalise nothing, hash what
    # the repository hashed.
    $got = Get-TextSha256 $body
    if ($got -ne $want) { throw "src/$relPath does not match its published hash (got $got)" }
    $dest = Join-Path $targetDir (($relPath -split '/')[-1])
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    [System.IO.File]::WriteAllText($dest, $body, (New-Object System.Text.UTF8Encoding($false)))
    return $dest
}

# The shim source keeps its subfolder; everything else lands flat.
function Install-VerifiedTool($relPath) {
    $dest = Join-Path $ToolsDir ($relPath -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    $url  = "$RawBase/src/$relPath"
    $want = $sums["src/$relPath"]
    if (-not $want) { throw "src/$relPath is not listed in SHA256SUMS" }
    $body = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30).Content
    if ($body -is [byte[]]) { $body = [System.Text.Encoding]::UTF8.GetString($body) }
    $got = Get-TextSha256 $body
    if ($got -ne $want) { throw "src/$relPath does not match its published hash (got $got)" }
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    [System.IO.File]::WriteAllText($dest, $body, (New-Object System.Text.UTF8Encoding($false)))
    return $dest
}

$wanted = @($CoreFiles)
if ($PlatformWin) { $wanted += $WinFiles }
try {
    foreach ($f in $wanted) { Install-VerifiedTool $f | Out-Null }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Nothing was changed beyond the files already verified. Try again, or install from a clone." -ForegroundColor Red
    return
}
Write-Host ("      {0} file(s) installed and verified" -f $wanted.Count) -ForegroundColor DarkGray

# Slash commands: /refresh-t and /refresh-a, next to whatever the user already
# has. They are only useful with Claude Code installed, so a missing folder is
# created rather than treated as an error.
$commandsDir = Join-Path (Join-Path $HOME '.claude') 'commands'
try {
    foreach ($c in $CommandFiles) { Install-VerifiedFile "commands/$c" $commandsDir | Out-Null }
    Write-Host ("      slash commands installed in {0}" -f $commandsDir) -ForegroundColor DarkGray
} catch {
    Write-Host ("      (slash commands skipped: {0})" -f $_.Exception.Message) -ForegroundColor DarkGray
}

$SelectPath = Join-Path $ToolsDir 'claude-code-select.ps1'
$AutoPath   = Join-Path $ToolsDir 'claude-code-auto.ps1'
$ListPath   = Join-Path $ToolsDir 'claude-code-list.ps1'
$RemovePath = Join-Path $ToolsDir 'claude-code-remove.ps1'
$RenewPath  = Join-Path $ToolsDir 'claude-code-renew.ps1'
$CcAddPath  = Join-Path $ToolsDir 'claude-code-add.ps1'
$DoctorPath = Join-Path $ToolsDir 'claude-code-doctor.ps1'
$PoolPath   = Join-Path $ToolsDir 'claude-cc-pool.ps1'
$WatchPath  = Join-Path $ToolsDir 'claude-code-watch.ps1'
$HookPath   = Join-Path $ToolsDir 'claude-code-hook.ps1'
$RefreshPath = Join-Path $ToolsDir 'claude-code-refresh.ps1'
$CcPath      = Join-Path $ToolsDir 'claude-cc.ps1'
$ShimPath   = Join-Path $ToolsDir 'claude-code-shim.ps1'
$SwitchPath = Join-Path $ToolsDir 'claude-switch.ps1'
$AddPath    = Join-Path $ToolsDir 'claude-add.ps1'

# Record the installed version (used by the daily update check).
try {
    $ver = (Invoke-RestMethod -Uri "$RawBase/VERSION" -TimeoutSec 8).ToString().Trim()
    Set-Content -Path $VersionPath -Value $ver -Encoding ASCII
    Write-Host "      Installed version $ver" -ForegroundColor DarkGray
} catch {}

if ($PlatformWin) {
    # ---------------------------------------------------------------- Windows --
    # 2. Add commands to PowerShell profiles (5.1 + 7)
    Write-Host "[2/3] Adding the switch commands to your PowerShell profiles..." -ForegroundColor Cyan
    $docs = [Environment]::GetFolderPath('MyDocuments')   # honours OneDrive redirection
    $profiles = @(
        (Join-Path $docs 'WindowsPowerShell\Microsoft.PowerShell_profile.ps1'),
        (Join-Path $docs 'PowerShell\Microsoft.PowerShell_profile.ps1')
    )
    # Marker-delimited block so re-running the installer cleanly REPLACES the old
    # definitions (lets us add/rename commands on update without leaving dupes).
    $beginMark = '# >>> claude-account-switcher >>>'
    $endMark   = '# <<< claude-account-switcher <<<'
    $func = @"
$beginMark
# Claude account switcher (managed by claude-account-switcher installer)
# Desktop app (claude.ai chats):
function claude-switch-account { & "$SwitchPath" }
function claude-add-account    { & "$AddPath" }
# Claude Code CLI (coding work / usage):
function claude-code-add       { & "$CcAddPath" @args }
function claude-code-list      { & "$ListPath" @args }
function claude-code-remove    { & "$RemovePath" @args }
function claude-code-renew     { & "$RenewPath" @args }
function claude-code-select    { & "$SelectPath" @args }
function claude-code-auto      { & "$AutoPath" @args }
function claude-code-pool      { & "$PoolPath" @args }
function claude-code-watch     { & "$WatchPath" @args }
function claude-code-refresh   { & "$RefreshPath" @args }
function claude-cc             { & "$CcPath" @args }
function claude-code-shim      { & "$ShimPath" @args }
function claude-code-doctor    { & "$DoctorPath" @args }
# Kept for muscle memory: the interactive picker is now -List plus a choice.
function claude-code-switch    { & "$SelectPath" @args }
function claude-switch-update {
    Write-Host "Updating Claude Account Switcher..." -ForegroundColor Cyan
    irm $RawBase/install.ps1 | iex
    Write-Host "Done. Open a new PowerShell window to load the updated commands." -ForegroundColor Green
}
$endMark
"@
    foreach ($pf in $profiles) {
        $dir = Split-Path $pf
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        if (-not (Test-Path $pf))  { New-Item -ItemType File -Force -Path $pf | Out-Null }
        $c = Get-Content $pf -Raw -ErrorAction SilentlyContinue
        if ($null -eq $c) { $c = '' }
        # Remove any previous managed block (and legacy un-marked block), then append fresh.
        $pattern = [Regex]::Escape($beginMark) + '.*?' + [Regex]::Escape($endMark)
        $c = [Regex]::Replace($c, $pattern, '', 'Singleline')
        # Legacy cleanup: drop any old un-delimited block from earlier versions.
        $c = $c -replace '(?s)\r?\n#\s*Claude desktop account switcher[^\r\n]*.*?function\s+claude-add-account\s*\{[^}]*\}', ''
        $c = $c.TrimEnd() + "`r`n`r`n" + $func + "`r`n"
        Set-Content -Path $pf -Value $c -Encoding UTF8
    }

    # 3. Desktop shortcuts (one per switcher)
    Write-Host "[3/3] Creating Desktop shortcuts..." -ForegroundColor Cyan
    $desktop = [Environment]::GetFolderPath('Desktop')
    $psExe   = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

    $icon = $null
    $pkg  = Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq 'Claude_pzs8sxrjxfjjc' } | Select-Object -First 1
    if ($pkg) {
        $cand = Join-Path $pkg.InstallLocation 'app\Claude.exe'
        if (Test-Path $cand) { $icon = "$cand,0" }
    }

    $ws = New-Object -ComObject WScript.Shell
    function New-SwitchShortcut($name, $scriptPath, $switchArgs, $desc) {
        $sc = $ws.CreateShortcut((Join-Path $desktop $name))
        $sc.TargetPath       = $psExe
        $sc.Arguments        = "-ExecutionPolicy Bypass -NoProfile -File `"$scriptPath`" $switchArgs"
        $sc.WorkingDirectory = $HOME
        if ($icon) { $sc.IconLocation = $icon }
        $sc.Description      = $desc
        $sc.WindowStyle      = 1
        $sc.Save()
    }
    New-SwitchShortcut 'Claude Switch Account.lnk' $SwitchPath '' 'Switch the Claude desktop app account'
    # The CLI switcher takes its choice as an argument, so the shortcut shows the
    # pool and leaves the choice to the window it opens.
    New-SwitchShortcut 'Claude Code Accounts.lnk'  $ListPath   '' 'List the saved Claude Code accounts and their usage'

    # Launch shortcuts for the Claude Code CLI (open a console running the command).
    function New-ClaudeLaunchShortcut($name, $cliArgs, $desc) {
        $sc = $ws.CreateShortcut((Join-Path $desktop $name))
        $sc.TargetPath       = $psExe
        $sc.Arguments        = "-NoExit -Command `"claude $cliArgs`""
        $sc.WorkingDirectory = $HOME
        if ($icon) { $sc.IconLocation = $icon }
        $sc.Description      = $desc
        $sc.WindowStyle      = 1
        $sc.Save()
    }
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        New-ClaudeLaunchShortcut 'Claude Code.lnk'          ''           'Launch Claude Code (claude)'
        New-ClaudeLaunchShortcut 'Claude Code Resume.lnk'   '--resume'   'Resume a Claude Code session (claude --resume)'
        New-ClaudeLaunchShortcut 'Claude Code Continue.lnk' '--continue' 'Continue the last Claude Code session (claude --continue)'
    } else {
        Write-Host "      (claude CLI not on PATH - skipped Claude Code launch shortcuts)" -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "Done! Claude Account Switcher is installed." -ForegroundColor Green
    Write-Host ""
    Write-Host "Open a NEW PowerShell window so the commands load." -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  DESKTOP APP (claude.ai chats):" -ForegroundColor Gray
    Write-Host "    claude-add-account      save each account (don't use the app's Log out)" -ForegroundColor Gray
    Write-Host "    claude-switch-account   switch (also on the Desktop shortcut)" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  CLAUDE CODE CLI (coding work + usage):" -ForegroundColor Gray
    Write-Host "    claude-code-add         save the account you are logged into" -ForegroundColor Gray
    Write-Host "    claude-code-list        every saved account with its 5h / 7d usage" -ForegroundColor Gray
    Write-Host "    claude-code-remove      take a saved account back out of the pool" -ForegroundColor Gray
    Write-Host "    claude-code-select -Email you@example.com -Relaunch" -ForegroundColor Gray
    Write-Host "    claude-code-auto        switch only when the current account is out of quota" -ForegroundColor Gray
    Write-Host "    claude-code-doctor      check the whole setup" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  To refresh a running session in place (Boite threads), once:" -ForegroundColor Gray
    Write-Host "    claude-code-shim -Install   then restart Boite" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  To switch by itself the moment a rate limit expires:" -ForegroundColor Gray
    Write-Host "    claude-code-watch -Install  runs at logon, checks every 10 s," -ForegroundColor Gray
    Write-Host "                                and adds the SessionStart hook for you" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  claude-cc status          accounts, quota, watcher and sessions in one block" -ForegroundColor Gray
    Write-Host "  claude-cc fix             repair whatever doctor would complain about" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Optional, off unless you ask for it - show which account is logged in" -ForegroundColor Gray
    Write-Host "  and how many are still free in the Claude Code status line:" -ForegroundColor Gray
    Write-Host "    claude-cc statusline install   your own status line, if you have one," -ForegroundColor Gray
    Write-Host "                                  keeps rendering; the segment is appended" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Inside Claude Code: /claude-account-list, /refresh-t (this thread)," -ForegroundColor Gray
    Write-Host "  /refresh-a (every thread), /claude-account-switch, /claude-account-auto-switch." -ForegroundColor Gray
    Write-Host ""
    Write-Host "  claude-switch-update      update to the latest version" -ForegroundColor Gray
}
else {
    # ----------------------------------------------------------- macOS / Linux --
    # 2. Add shell functions to the user's shell rc files. Each one invokes the
    #    .ps1 with `pwsh` so the user gets plain `claude-code-*` commands in
    #    their normal bash/zsh shell.
    Write-Host "[2/2] Adding Claude Code switch commands to your shell (bash/zsh)..." -ForegroundColor Cyan

    if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
        Write-Host "WARNING: 'pwsh' was not found on PATH." -ForegroundColor Yellow
        Write-Host "Install PowerShell (https://aka.ms/powershell) so the commands can run." -ForegroundColor Yellow
    }

    $beginMark = '# >>> claude-account-switcher >>>'
    $endMark   = '# <<< claude-account-switcher <<<'
    $block = @"
$beginMark
# Claude Code account switcher (managed by claude-account-switcher installer)
claude-code-add()    { pwsh -NoProfile -File "$CcAddPath" "\$@"; }
claude-code-list()   { pwsh -NoProfile -File "$ListPath" "\$@"; }
claude-code-remove() { pwsh -NoProfile -File "$RemovePath" "\$@"; }
claude-code-renew()  { pwsh -NoProfile -File "$RenewPath" "\$@"; }
claude-code-select() { pwsh -NoProfile -File "$SelectPath" "\$@"; }
claude-code-auto()   { pwsh -NoProfile -File "$AutoPath" "\$@"; }
claude-code-pool()   { pwsh -NoProfile -File "$PoolPath" "\$@"; }
claude-code-watch()  { pwsh -NoProfile -File "$WatchPath" "\$@"; }
claude-code-refresh(){ pwsh -NoProfile -File "$RefreshPath" "\$@"; }
claude-cc()          { pwsh -NoProfile -File "$CcPath" "\$@"; }
claude-code-doctor() { pwsh -NoProfile -File "$DoctorPath" "\$@"; }
claude-code-switch() { pwsh -NoProfile -File "$SelectPath" "\$@"; }
claude-switch-update() { pwsh -NoProfile -Command "irm $RawBase/install.ps1 | iex"; }
$endMark
"@

    $rcFiles = @(
        (Join-Path $HOME '.bashrc'),
        (Join-Path $HOME '.zshrc')
    )
    $touched = @()
    foreach ($rc in $rcFiles) {
        # Only update an rc file that already exists, plus always ensure ~/.bashrc
        # exists on Linux and ~/.zshrc on macOS (the common default shells).
        $isDefault = ($PlatformMac -and $rc.EndsWith('.zshrc')) -or ((-not $PlatformMac) -and $rc.EndsWith('.bashrc'))
        if (-not (Test-Path $rc) -and -not $isDefault) { continue }
        if (-not (Test-Path $rc)) { New-Item -ItemType File -Force -Path $rc | Out-Null }
        $c = Get-Content $rc -Raw -ErrorAction SilentlyContinue
        if ($null -eq $c) { $c = '' }
        $pattern = [Regex]::Escape($beginMark) + '.*?' + [Regex]::Escape($endMark)
        $c = [Regex]::Replace($c, $pattern, '', 'Singleline')
        $c = $c.TrimEnd() + "`n`n" + $block + "`n"
        # Write LF-only, no BOM (shells choke on BOM/CRLF).
        [System.IO.File]::WriteAllText($rc, ($c -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
        $touched += $rc
    }

    Write-Host ""
    Write-Host "Done! Claude Code account switcher is installed." -ForegroundColor Green
    if ($PlatformMac) {
        Write-Host "Note: macOS stores the Claude Code login in the Keychain. The first time" -ForegroundColor DarkGray
        Write-Host "the switcher reads/writes it, macOS may ask you to Allow access." -ForegroundColor DarkGray
        Write-Host "Snapshots are not DPAPI-encrypted there - they are files with 600 permissions." -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host ("Updated: " + ($touched -join ', ')) -ForegroundColor DarkGray
    Write-Host "Run 'source ~/.bashrc' (or ~/.zshrc), or open a new terminal, then:" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  claude-code-add         save the account you are logged into" -ForegroundColor Gray
    Write-Host "  claude-code-list        every saved account with its 5h / 7d usage" -ForegroundColor Gray
    Write-Host "  claude-code-remove      take a saved account back out of the pool" -ForegroundColor Gray
    Write-Host "  claude-code-select -Email you@example.com -Relaunch" -ForegroundColor Gray
    Write-Host "  claude-code-auto        switch only when the current account is out of quota" -ForegroundColor Gray
    Write-Host "  claude-code-doctor      check the whole setup" -ForegroundColor Gray
    Write-Host "  claude-switch-update    update to the latest version" -ForegroundColor Gray
}
