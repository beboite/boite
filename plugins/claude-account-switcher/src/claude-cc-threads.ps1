# Registry of the Claude Code sessions that are running right now.
#
# A switch is only half the job: the process that hit the limit read its
# credentials at startup and has to be restarted on its own conversation. That
# restart needs the session id and the pid of the process to end - both of which
# Claude Code only exports to what IT runs, through CLAUDE_CODE_SESSION_ID and
# CLAUDE_PID.
#
# A watcher started from a scheduled task, or from another terminal, has none of
# that in its environment. So every session records itself here when it starts,
# and the watcher reads the file instead of the environment.
#
# Dot-source this; it defines functions and no parameters (a param() block would
# leak its variables into the caller's scope).

if (-not $CcStore) { $CcStore = Join-Path $HOME '.claude-cc-accounts' }
$CcThreadRegistry = Join-Path $CcStore '.threads.state'

# Several sessions can start at the same moment - Boite opens threads in
# parallel - and each one rewrites the whole file. Without a lock the last
# writer wins and the others vanish from the registry.
function Invoke-CcThreadLocked([scriptblock]$body) {
    $mutex = New-Object System.Threading.Mutex($false, 'Global\ClaudeCcThreadRegistry')
    $held = $false
    try {
        try { $held = $mutex.WaitOne(5000) } catch [System.Threading.AbandonedMutexException] { $held = $true }
        return & $body
    } finally {
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Get-CcThreadRegistryRaw {
    if (-not (Test-Path $CcThreadRegistry)) { return @() }
    try {
        $j = Get-Content -LiteralPath $CcThreadRegistry -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($null -eq $j) { return @() }
        return @($j)
    } catch { return @() }
}

function Save-CcThreadRegistryRaw($entries) {
    New-Item -ItemType Directory -Force -Path $CcStore | Out-Null
    $json = @($entries) | ConvertTo-Json -Depth 6
    if (-not $json) { $json = '[]' }
    # A single entry serializes as an object, not an array, and would come back
    # as one on the next read.
    if ($json -notmatch '^\s*\[') { $json = "[$json]" }
    $tmp = "$CcThreadRegistry.tmp"
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $CcThreadRegistry -Force
    # This file decides which process the watcher ends and which conversation it
    # comes back on, so it is locked to this user like the snapshots are. An
    # entry someone else could append is a process kill of their choosing.
    if (Get-Command Protect-CcFile -ErrorAction SilentlyContinue) { Protect-CcFile $CcThreadRegistry }
}

# Pids are reused. An entry whose process started at a different moment than the
# one recorded is a different program wearing the same number, and ending it
# would kill something that has nothing to do with Claude Code.
function Test-CcThreadAlive($entry) {
    if (-not $entry.pid) { return $false }
    $p = Get-Process -Id ([int]$entry.pid) -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    if ($p.ProcessName -notmatch '^claude') { return $false }
    if ($entry.startedAt) {
        try {
            $recorded = [datetime]::Parse($entry.startedAt, [Globalization.CultureInfo]::InvariantCulture)
            if ([Math]::Abs(($p.StartTime - $recorded).TotalSeconds) -gt 2) { return $false }
        } catch {}
    }
    return $true
}

function Register-CcThread {
    param(
        [string]$SessionId = $env:CLAUDE_CODE_SESSION_ID,
        [int]$ThreadPid = 0,
        [string]$ThreadId = $env:BOITE_THREAD_ID,
        [string]$WorkDir  = $PWD.Path
    )
    if (-not $ThreadPid) {
        # The hook runs as a child of the session, so the pid it wants is the
        # one Claude Code exported - not this shell's.
        if ($env:CLAUDE_PID) { $ThreadPid = [int]$env:CLAUDE_PID }
    }
    if (-not $ThreadPid -or -not $SessionId) { return $false }
    $p = Get-Process -Id $ThreadPid -ErrorAction SilentlyContinue
    if (-not $p -or $p.ProcessName -notmatch '^claude') { return $false }

    $entry = [pscustomobject]@{
        sessionId    = $SessionId
        pid          = $ThreadPid
        threadId     = $ThreadId
        workDir      = $WorkDir
        startedAt    = $p.StartTime.ToString('o')
        registeredAt = (Get-Date).ToString('o')
    }
    Invoke-CcThreadLocked {
        $all = @(Get-CcThreadRegistryRaw | Where-Object { $_.pid -ne $ThreadPid } | Where-Object { Test-CcThreadAlive $_ })
        Save-CcThreadRegistryRaw ($all + $entry)
    } | Out-Null
    return $true
}

function Unregister-CcThread([int]$ThreadPid) {
    Invoke-CcThreadLocked {
        Save-CcThreadRegistryRaw @(Get-CcThreadRegistryRaw | Where-Object { $_.pid -ne $ThreadPid })
    } | Out-Null
}

# The registry as it is true right now: dead entries are dropped from the file
# on the way out, so it does not grow one line per session forever.
function Get-CcLiveThreads {
    Invoke-CcThreadLocked {
        $all  = @(Get-CcThreadRegistryRaw)
        $live = @($all | Where-Object { Test-CcThreadAlive $_ })
        if ($live.Count -ne $all.Count) { Save-CcThreadRegistryRaw $live }
        return $live
    }
}
