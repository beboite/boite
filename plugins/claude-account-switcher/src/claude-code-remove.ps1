# claude-code-remove - take a saved account out of the pool.
#
#   claude-code-remove.ps1 bob@example.com     by address
#   claude-code-remove.ps1 bob                 by any unambiguous part of it
#   claude-code-remove.ps1 -Index 2            by the number shown in the list
#   claude-code-remove.ps1 bob -Purge          delete instead of archiving
#
# The snapshot is moved to ~/.claude-cc-accounts/.backups by default rather than
# deleted: the file is the only copy of that account's login outside Claude Code
# itself, and a wrong argument would otherwise cost a /login. -Purge is the
# explicit way to say the copy is not wanted either.
#
# Removing an account changes nothing about the session that is running: the
# credentials in use live in Claude Code's own config, and the pool is a set of
# copies. Removing the account currently logged in only means the switcher can
# no longer come back to it, so it is refused without -AllowCurrent.
#
# Exit codes: 0 removed, 1 nothing matched, 30 the pool is empty, 64 the
# argument matches several accounts (or none was given), 65 a confirmation is
# needed and the console cannot ask for one.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Email,
    [int]$Index = 0,
    [switch]$Purge,        # delete outright instead of moving to .backups
    [switch]$Force,        # no confirmation prompt
    [switch]$AllowCurrent, # allow removing the account this session is logged in as
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')
$poolLib = Join-Path $PSScriptRoot 'claude-cc-pool.ps1'
if (Test-Path $poolLib) { . $poolLib }

# The same set the list tool walks, in the same order, so "-Index 2" means the
# second row the user was just shown.
$files = @(Get-CcSnapshotFiles)
if (-not $files.Count) {
    Say "No saved accounts in $CcStore - nothing to remove." Yellow
    exit 30
}

# What each file says about itself. The email field is what the list prints, so
# it is what a selection is matched against.
$rows = @()
foreach ($f in $files) {
    $mail = $null
    try { $mail = (Get-Content $f.FullName -Raw | ConvertFrom-Json).email } catch {}
    $rows += [pscustomobject]@{ File = $f; Email = $mail; Name = $f.Name }
}

$liveEmail = (Get-CcLiveIdentity).Email

function Show-Rows {
    Say ""
    for ($i = 0; $i -lt $rows.Count; $i++) {
        $r = $rows[$i]
        $mark = if ($r.Email -and $liveEmail -and $r.Email -eq $liveEmail) { '*' } else { ' ' }
        Say ("  {0} {1}. {2}" -f $mark, ($i + 1), $(if ($r.Email) { $r.Email } else { $r.Name }))
    }
    Say ""
}

# -- pick one ------------------------------------------------------------------

$target = $null
if ($Index -gt 0) {
    if ($Index -gt $rows.Count) {
        Say "There is no account $Index - the pool holds $($rows.Count)." Yellow
        Show-Rows
        exit 64
    }
    $target = $rows[$Index - 1]
} elseif ($Email) {
    # A bare number as the positional argument is the row number, not an address:
    # it is what the list shows and what people type.
    if ($Email -match '^\d+$') {
        $n = [int]$Email
        if ($n -lt 1 -or $n -gt $rows.Count) {
            Say "There is no account $n - the pool holds $($rows.Count)." Yellow
            Show-Rows
            exit 64
        }
        $target = $rows[$n - 1]
    } else {
        $exact = @($rows | Where-Object { $_.Email -and $_.Email -eq $Email })
        $part  = @($rows | Where-Object { ($_.Email -and $_.Email -like "*$Email*") -or $_.Name -like "*$Email*" })
        # An exact address wins over a substring: "bob@x.com" must not be
        # ambiguous just because "bob@x.com.old.json" is also in the folder.
        $hits = if ($exact.Count) { $exact } else { $part }
        if (-not $hits.Count) {
            Say "No saved account matches '$Email'." Yellow
            Show-Rows
            exit 1
        }
        if ($hits.Count -gt 1) {
            Say "'$Email' matches $($hits.Count) accounts - be more specific:" Yellow
            foreach ($h in $hits) { Say ("    {0}" -f $(if ($h.Email) { $h.Email } else { $h.Name })) }
            exit 64
        }
        $target = $hits[0]
    }
} else {
    Say "Which account? Pass an address, a part of one, or a row number." Yellow
    Show-Rows
    exit 64
}

$label = if ($target.Email) { $target.Email } else { $target.Name }
$isLive = $target.Email -and $liveEmail -and $target.Email -eq $liveEmail

# Its own flag rather than -Force: an agent passes -Force for every removal
# because it cannot answer a prompt, and that must not quietly also mean "yes,
# drop the one I am logged in as".
if ($isLive -and -not $AllowCurrent) {
    Say "'$label' is the account this session is logged in as." Yellow
    Say "Removing it leaves the login in place but the switcher can never come back to it." DarkYellow
    Say "Pass -AllowCurrent if that is what you want." Yellow
    exit 64
}

# -- confirm -------------------------------------------------------------------

if (-not $Force) {
    $what = if ($Purge) { "Delete" } else { "Remove" }
    # A prompt that cannot be answered would hang a hook or a scheduled run
    # forever, so a non-interactive caller is told to say -Force instead.
    if (-not [Environment]::UserInteractive) {
        Say "$what '$label'? Re-run with -Force - there is no console here to confirm on." Yellow
        exit 65
    }
    $answer = Read-Host "$what '$label' from the pool? [y/N]"
    if ($answer -notmatch '^(y|yes|o|oui)$') {
        Say "Left alone." Gray
        exit 0
    }
}

# -- remove --------------------------------------------------------------------

if ($Purge) {
    Remove-Item -LiteralPath $target.File.FullName -Force
    Say "Deleted $label." Green
} else {
    New-Item -ItemType Directory -Force -Path $CcBackupDir | Out-Null
    Protect-CcDirectory $CcBackupDir
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    # Kept out of *.json on purpose: the pool walks that extension, and an
    # archive that reads as an account would come back as a row in the list.
    $dest = Join-Path $CcBackupDir ("removed-{0}-{1}.json.bak" -f $stamp, ($target.Name -replace '\.json$', ''))
    Move-Item -LiteralPath $target.File.FullName -Destination $dest -Force
    Protect-CcFile $dest
    Say "Removed $label." Green
    Say "  archived to $dest" DarkGray
}

if (Get-Command Unregister-PoolEntry -ErrorAction SilentlyContinue) {
    if (Unregister-PoolEntry $target.Name) { Say "  dropped its entry from the pool manifest" DarkGray }
}

$left = @(Get-CcSnapshotFiles)
Say ("  {0} account(s) left in the pool" -f $left.Count) DarkGray
if ($left.Count -lt 2) {
    Say "Only one account left: a switch has nowhere to go." Yellow
}
exit 0
