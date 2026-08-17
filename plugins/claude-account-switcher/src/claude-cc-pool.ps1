# Trust for the account pool: which snapshots in ~/.claude-cc-accounts were put
# there by this machine's owner, and which ones just appeared.
#
# The switcher restores whatever snapshot it finds, so a file dropped in that
# folder by anyone else would be written straight into the live credentials and
# the next session would run as a stranger's account. This keeps a manifest of
# the snapshots that were registered on purpose, each one stamped with an
# HMAC-SHA256 over `file|email|accountUuid|hash(login)`.
#
# The login itself is part of what is stamped: without it, swapping the tokens
# inside an already registered file kept the entry valid, and the seat went to
# whoever supplied the new tokens. Every legitimate rewrite of a snapshot (the
# sync-back after a switch) re-registers it, so the stamp follows the rotation.
#
# The HMAC key sits in `.pool.key`, encrypted with DPAPI for the current Windows
# user, so another account on this machine cannot compute a stamp of its own
# even after reading the manifest. The same key signs the relaunch markers the
# wrapper acts on. It is a guard against files arriving from somewhere else, not
# against this user's own session being compromised: anything running as this
# user can decrypt what this user can decrypt.
#
# Dot-source it for the functions. Run it directly for:
#   -Status    list every snapshot with its verdict
#   -Adopt     stamp the snapshots already in the pool (once, after an upgrade)
#   -Protect   encrypt every snapshot's login with DPAPI, then re-stamp
#   -Decrypt <path>   print a protected snapshot or backup as plain JSON
#
# Verdicts: trusted (stamp matches), unknown (no entry - a file that arrived on
# its own, or one saved before the manifest existed), changed (the entry is
# there but what is in the file is not what was registered), nokey (the key
# cannot be read here, so nothing can be verified either way).

# Dot-sourcing runs this param block in the caller's own scope, so $Status,
# $Adopt, $Protect and $Decrypt land there as typed variables: a caller that
# assigns a string to one of those names fails on the assignment, not here.
param(
    [switch]$Status,
    [switch]$Adopt,
    [switch]$Protect,
    [string]$Decrypt
)

$common = Join-Path $PSScriptRoot 'claude-cc-common.ps1'
if (Test-Path $common) { . $common }

$PoolDir      = Join-Path $HOME '.claude-cc-accounts'
$PoolKeyFile  = Join-Path $PoolDir '.pool.key'
$PoolManifest = Join-Path $PoolDir '.pool.json'

# Kept for callers that dot-source this file without the common library.
if (-not (Get-Command Protect-CcFile -ErrorAction SilentlyContinue)) {
    function Protect-CcFile($path) {
        if (-not (Test-Path -LiteralPath $path)) { return }
        if ($PSVersionTable.Platform -eq 'Unix') {
            try { & chmod 600 $path 2>$null | Out-Null } catch { }
            return
        }
        try {
            $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
            & icacls $path /inheritance:r /grant:r "${me}:(F)" 2>&1 | Out-Null
        } catch { }
    }
}
function Protect-PoolFile($path) { Protect-CcFile $path }   # old name, still used elsewhere

function Get-PoolKey([switch]$Create) {
    if (Test-Path $PoolKeyFile) {
        try {
            $blob = [System.IO.File]::ReadAllBytes($PoolKeyFile)
            return [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
        } catch {
            # Written by another user, or restored from another machine: it
            # cannot be used, and silently making a new one would turn every
            # stamped snapshot into "changed".
            if (-not $Create) { return $null }
        }
    }
    if (-not $Create) { return $null }
    $key = New-Object byte[] 32
    # RandomNumberGenerator::Fill does not exist on .NET Framework, which is what
    # Windows PowerShell 5.1 runs on - and a throw here means no key, so every
    # snapshot reads as unverifiable.
    try {
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($key)
    } catch {
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($key) } finally { $rng.Dispose() }
    }
    New-Item -ItemType Directory -Force -Path $PoolDir | Out-Null
    [System.IO.File]::WriteAllBytes($PoolKeyFile,
        [System.Security.Cryptography.ProtectedData]::Protect($key, $null, 'CurrentUser'))
    Protect-CcFile $PoolKeyFile
    return $key
}

# The identity Claude Code itself reported for that login - not the file name,
# which is only typed text.
function Get-PoolIdentity($oauthAccountRaw) {
    if (-not $oauthAccountRaw) { return $null }
    try {
        $o = $oauthAccountRaw | ConvertFrom-Json
        return [pscustomobject]@{ Uuid = $o.accountUuid; Email = $o.emailAddress }
    } catch { return $null }
}

# What binds the stamp to the login in the file. Only the three fields that make
# up the session are hashed: the rest of the snapshot (usage cache, savedAt)
# changes on its own and must not invalidate anything.
function Get-PoolCredHash($creds) {
    if (-not $creds) { return 'none' }
    $o = $creds.claudeAiOauth
    if (-not $o) { return 'none' }
    $material = "{0}|{1}|{2}" -f $o.accessToken, $o.refreshToken, $o.expiresAt
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($material))
        return [System.BitConverter]::ToString($bytes).Replace('-', '').ToLower()
    } finally { $sha.Dispose() }
}

function Get-PoolStamp($key, $fileName, $email, $uuid, $credHash) {
    if (-not $key) { return $null }
    $h = [System.Security.Cryptography.HMACSHA256]::new($key)
    try {
        # The parentheses matter: inside a method call, a bare comma would split
        # the format arguments into arguments of GetBytes.
        $text = if ($credHash) { "{0}|{1}|{2}|{3}" -f $fileName, $email, $uuid, $credHash }
                else           { "{0}|{1}|{2}"     -f $fileName, $email, $uuid }   # v1, still verified
        $data = [System.Text.Encoding]::UTF8.GetBytes($text)
        return [System.BitConverter]::ToString($h.ComputeHash($data)).Replace('-', '').ToLower()
    } finally { $h.Dispose() }
}

function Get-PoolManifest {
    if (-not (Test-Path $PoolManifest)) { return $null }
    try { return (Get-Content $PoolManifest -Raw | ConvertFrom-Json) } catch { return $null }
}

function Register-PoolEntry($fileName, $email, $oauthAccountRaw, $creds) {
    $id = Get-PoolIdentity $oauthAccountRaw
    if (-not $id -or -not $id.Uuid) { return $false }   # nothing to bind the file to
    $key = Get-PoolKey -Create
    if (-not $key) { return $false }

    $entries = @{}
    $m = Get-PoolManifest
    if ($m -and $m.accounts) {
        foreach ($p in $m.accounts.PSObject.Properties) { $entries[$p.Name] = $p.Value }
    }
    $credHash = Get-PoolCredHash $creds
    $entries[$fileName] = [pscustomobject]@{
        email       = $email
        accountUuid = $id.Uuid
        credHash    = $credHash
        stamp       = Get-PoolStamp $key $fileName $email $id.Uuid $credHash
        registered  = (Get-Date -Format o)
    }
    [pscustomobject]@{ version = 2; accounts = [pscustomobject]$entries } |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $PoolManifest -Encoding UTF8
    Protect-CcFile $PoolManifest
    return $true
}

# Drop a snapshot's entry from the manifest. Called when the snapshot itself is
# deleted: an entry left behind would keep stamping a file that no longer
# exists, and the name would silently re-validate a new file dropped in its
# place by someone else.
function Unregister-PoolEntry($fileName) {
    $m = Get-PoolManifest
    if (-not $m -or -not $m.accounts) { return $false }
    $entries = @{}
    $found = $false
    foreach ($p in $m.accounts.PSObject.Properties) {
        if ($p.Name -eq $fileName) { $found = $true; continue }
        $entries[$p.Name] = $p.Value
    }
    if (-not $found) { return $false }
    [pscustomobject]@{ version = 2; accounts = [pscustomobject]$entries } |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $PoolManifest -Encoding UTF8
    Protect-CcFile $PoolManifest
    return $true
}

# Verdict for one snapshot. $creds is the login as it is in the file right now
# (already decrypted by the caller), so a swapped token shows up as 'changed'.
function Test-PoolEntry($fileName, $email, $oauthAccountRaw, $creds) {
    $m = Get-PoolManifest
    if (-not $m -or -not $m.accounts) { return 'unknown' }
    $entry = $m.accounts.PSObject.Properties | Where-Object { $_.Name -eq $fileName } | Select-Object -First 1
    if (-not $entry) { return 'unknown' }
    $key = Get-PoolKey
    # No usable key is not the same as an unregistered file, and saying "it was
    # never registered here" about a whole pool sends the user to re-add every
    # account instead of to the real problem.
    if (-not $key) { return 'nokey' }
    $id = Get-PoolIdentity $oauthAccountRaw
    $uuid = if ($id) { $id.Uuid } else { $null }

    $v2 = Get-PoolStamp $key $fileName $email $uuid (Get-PoolCredHash $creds)
    if ($v2 -and $v2 -eq $entry.Value.stamp) { return 'trusted' }

    # Entries written before the login was part of the stamp: accept the old
    # form once, then upgrade it in place so the next check is the strict one.
    if (-not $entry.Value.credHash) {
        $v1 = Get-PoolStamp $key $fileName $email $uuid $null
        if ($v1 -and $v1 -eq $entry.Value.stamp) {
            Register-PoolEntry $fileName $email $oauthAccountRaw $creds | Out-Null
            return 'trusted'
        }
    }
    return 'changed'
}

function Get-PoolVerdictText($verdict) {
    switch ($verdict) {
        'changed' { 'what is inside it is not what was registered (its login was replaced?)' }
        'nokey'   { 'the pool key cannot be read here, so nothing can be verified' }
        default   { 'it was never registered here' }
    }
}

# -- Relaunch markers ----------------------------------------------------------
# The wrapper runs whatever command line the marker holds, so a marker is as
# powerful as a `claude` invocation - `--mcp-config` alone is arbitrary code.
# It is signed with the pool key, and the wrapper ignores anything unsigned.
function Write-SignedMarker($markerPath, $content) {
    [System.IO.File]::WriteAllText($markerPath, $content, (New-Object System.Text.UTF8Encoding($false)))
    $key = Get-PoolKey -Create
    if (-not $key) { return $false }
    $h = [System.Security.Cryptography.HMACSHA256]::new($key)
    try {
        $sig = [System.BitConverter]::ToString(
            $h.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($content))).Replace('-', '').ToLower()
    } finally { $h.Dispose() }
    [System.IO.File]::WriteAllText("$markerPath.sig", $sig, (New-Object System.Text.UTF8Encoding($false)))
    return $true
}

function Remove-SignedMarker($markerPath) {
    Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$markerPath.sig" -Force -ErrorAction SilentlyContinue
}

# -- Run directly ---------------------------------------------------------------
if ($Decrypt) {
    if (-not (Test-Path -LiteralPath $Decrypt)) { Write-Host "No such file: $Decrypt" -ForegroundColor Red; return }
    $text = Get-Content -LiteralPath $Decrypt -Raw
    $out = $null
    try { $j = $text | ConvertFrom-Json; if ($j.credentialsProtected) { $out = Unprotect-CcText $j.credentialsProtected } } catch {}
    if (-not $out) { $out = Unprotect-CcText $text.Trim() }   # a raw backup blob
    if ($out) { $out } else { Write-Host "Nothing protected in that file, or it was protected by another user." -ForegroundColor Yellow }
    return
}

if (-not ($Status -or $Adopt -or $Protect)) { return }

$files = Get-ChildItem $PoolDir -Filter '*.json' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike 'backup-*' -and -not $_.Name.StartsWith('.') } | Sort-Object Name
if (-not $files) { Write-Host "No snapshots in $PoolDir." -ForegroundColor Yellow; return }

Protect-CcDirectory $PoolDir

foreach ($f in $files) {
    try { $j = Get-Content $f.FullName -Raw | ConvertFrom-Json } catch { continue }
    $id    = Get-PoolIdentity $j.oauthAccountRaw
    $who   = if ($id) { $id.Email } else { '(no identity in the file)' }
    $creds = Get-CcSnapshotCreds $j

    if ($Protect) {
        # Re-write the snapshot with its login encrypted, keeping everything
        # else, then stamp what is now in the file.
        if (-not $creds) {
            Write-Host ("{0,-34} {1,-30} {2}" -f $f.Name, $who, 'no readable login - left alone') -ForegroundColor Yellow
            continue
        }
        $entry = New-CcSnapshotEntry $j.email $creds $j.oauthAccountRaw $j.usageCache
        Write-CcJsonFile $f.FullName $entry
        $ok = Register-PoolEntry $f.Name $j.email $j.oauthAccountRaw $creds
        $how = if ($entry.credentialsProtected) { 'encrypted' } else { 'plain (DPAPI unavailable)' }
        $tag = if ($ok) { "$how + registered" } else { "$how, but not registered (no accountUuid)" }
        Write-Host ("{0,-34} {1,-30} {2}" -f $f.Name, $who, $tag)
        continue
    }

    if ($Adopt) {
        $ok = Register-PoolEntry $f.Name $j.email $j.oauthAccountRaw $creds
        $verdict = if ($ok) { 'registered' } else { 'cannot be registered - no accountUuid in the snapshot' }
        Write-Host ("{0,-34} {1,-30} {2}" -f $f.Name, $who, $verdict)
        continue
    }

    $verdict = Test-PoolEntry $f.Name $j.email $j.oauthAccountRaw $creds
    $extra = if ($j.credentialsProtected) { 'encrypted' } elseif ($creds) { 'PLAIN TEXT' } else { 'unreadable' }
    $color = switch ($verdict) { 'trusted' { 'Green' } 'unknown' { 'Yellow' } 'nokey' { 'Yellow' } default { 'Red' } }
    Write-Host ("{0,-34} {1,-30} {2,-10} {3}" -f $f.Name, $who, $verdict, $extra) -ForegroundColor $color
}

if ($Adopt -or $Protect) {
    Write-Host ""
    Write-Host "Registered. A snapshot that appears on its own, or whose login was replaced, is refused." -ForegroundColor Cyan
}
if ($Status) {
    $plain = @($files | Where-Object {
        try { -not ((Get-Content $_.FullName -Raw | ConvertFrom-Json).credentialsProtected) } catch { $false }
    })
    if ($plain.Count) {
        Write-Host ""
        Write-Host "$($plain.Count) snapshot(s) still hold their login in plain text. Encrypt them with -Protect." -ForegroundColor Yellow
    }
}
