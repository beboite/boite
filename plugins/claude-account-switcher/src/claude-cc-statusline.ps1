# claude-cc-statusline - put the switcher's segment in the status line, and
# nothing else.
#
#   claude-cc-statusline.ps1 -Status      what is installed right now
#   claude-cc-statusline.ps1 -Install     add the segment, keeping any existing line
#   claude-cc-statusline.ps1 -Uninstall   put the previous status line back
#   claude-cc-statusline.ps1 -Render      print the segment once (a preview)
#
# The status line belongs to whoever set it up. This toolkit has one thing worth
# showing there - which account is logged in and how many are still free - and
# no business rewriting the rest, so nothing here ever replaces someone's line:
#
#   no status line yet   the segment becomes the status line, alone
#   a status line exists it is moved into ~/.claude-cc-accounts/.statusline.json
#                        and run by claude-cc-statusline.js, whose output is
#                        appended after it, verbatim
#   already installed    nothing is written
#
# -Uninstall restores the stored command string exactly as it was, so a wrapped
# line comes back byte for byte - which is the only reason the original is kept
# in a file of ours instead of being spliced into settings.json.

[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$Status,
    [switch]$Render,
    # Between the wrapped line and our segment. The default matches the group
    # separator Claude Code's own examples use.
    [string]$Separator = '  |  '
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'claude-cc-common.ps1')

$SettingsFile = $CcSettingsFile
$WrapFile     = Join-Path $CcStore '.statusline.json'
$Script       = (Join-Path $PSScriptRoot 'claude-cc-statusline.js') -replace '\\', '/'
$OurCommand   = 'node "{0}"' -f $Script
$WrapCommand  = 'node "{0}" --wrap' -f $Script

# The command currently configured, or $null. Only the "command" shape is
# understood; a status line of another type is reported and left alone rather
# than guessed at.
function Get-CurrentLine($root) {
    $sl = $root['statusLine']
    if (-not $sl) { return $null }
    return [pscustomobject]@{
        Type    = if ($sl.type) { [string]$sl.type } else { 'command' }
        Command = if ($sl.command) { [string]$sl.command } else { '' }
        Raw     = $sl
    }
}

function Test-Ours($command) {
    return ($command -and $command -match 'claude-cc-statusline\.js')
}

function Get-Wrapped {
    if (-not (Test-Path $WrapFile)) { return $null }
    try { return Get-Content -LiteralPath $WrapFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Show-Status {
    $root = Read-CcSettings
    $cur  = Get-CurrentLine $root
    if (-not $cur) {
        Say 'status line   none configured' Yellow
        Say "              claude-cc statusline install adds the switcher segment" Gray
        return 0
    }
    if (Test-Ours $cur.Command) {
        $w = Get-Wrapped
        if ($w -and $w.command) {
            Say 'status line   switcher segment appended to your own line' Green
            Say ("              yours: {0}" -f $w.command) Gray
        } else {
            Say 'status line   switcher segment only' Green
        }
        return 0
    }
    Say 'status line   someone else''s, untouched' Yellow
    Say ("              {0}" -f $cur.Command) Gray
    Say '              claude-cc statusline install appends the switcher segment to it' Gray
    return 0
}

function Install-Segment {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Say 'node is not on PATH - the status line segment needs it.' Red
        return 30
    }
    $root = Read-CcSettings
    $cur  = Get-CurrentLine $root

    if ($cur -and (Test-Ours $cur.Command)) {
        Say 'The switcher segment is already in the status line.' Green
        return 0
    }

    if ($cur -and $cur.Type -ne 'command') {
        Say ("The status line is of type '{0}', which this installer cannot wrap - left alone." -f $cur.Type) Yellow
        Say ("Add the segment by hand: {0}" -f $OurCommand) Gray
        return 1
    }

    if ($cur -and $cur.Command) {
        # Someone else's line: it keeps rendering, we only add a group after it.
        New-Item -ItemType Directory -Force -Path $CcStore | Out-Null
        Write-CcJsonFile $WrapFile ([pscustomobject]@{
            command   = $cur.Command
            separator = $Separator
            savedAt   = (Get-Date).ToString('o')
        })
        $root['statusLine'] = [pscustomobject]@{ type = 'command'; command = $WrapCommand }
        Save-CcSettings $root
        Say 'Your status line is unchanged; the switcher segment now follows it.' Green
        Say ("  yours   {0}" -f $cur.Command) Gray
        Say ("  ours    {0}" -f $OurCommand) Gray
    } else {
        Remove-Item -LiteralPath $WrapFile -Force -ErrorAction SilentlyContinue
        $root['statusLine'] = [pscustomobject]@{ type = 'command'; command = $OurCommand }
        Save-CcSettings $root
        Say 'Status line set to the switcher segment (there was none).' Green
    }
    Say 'Open a new session, or /statusline, to see it.' Gray
    return 0
}

function Uninstall-Segment {
    $root = Read-CcSettings
    $cur  = Get-CurrentLine $root
    if (-not $cur -or -not (Test-Ours $cur.Command)) {
        Say 'The switcher segment is not in the status line - nothing to remove.' Yellow
        return 0
    }
    $w = Get-Wrapped
    if ($w -and $w.command) {
        # Back to the exact string that was there before, quoting included.
        $root['statusLine'] = [pscustomobject]@{ type = 'command'; command = [string]$w.command }
        Save-CcSettings $root
        Remove-Item -LiteralPath $WrapFile -Force -ErrorAction SilentlyContinue
        Say ("Restored your status line: {0}" -f $w.command) Green
    } else {
        $root.Remove('statusLine')
        Save-CcSettings $root
        Say 'Removed the status line (the switcher segment was the whole of it).' Green
    }
    return 0
}

# A preview with a payload shaped like the real one, so the segment can be seen
# without starting a session.
function Show-Render {
    $payload = [pscustomobject]@{
        workspace = [pscustomobject]@{ current_dir = (Get-Location).Path }
        model     = [pscustomobject]@{ display_name = 'preview' }
    } | ConvertTo-Json -Depth 5 -Compress
    $out = $payload | & node (Join-Path $PSScriptRoot 'claude-cc-statusline.js')
    Write-Host $out
    return 0
}

if ($Render)    { exit (Show-Render) }
if ($Install)   { exit (Install-Segment) }
if ($Uninstall) { exit (Uninstall-Segment) }
exit (Show-Status)
