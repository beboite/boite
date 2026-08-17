# Shared plumbing for the Claude Code account switcher.
#
# Everything in here used to be copy-pasted into claude-code-select.ps1,
# claude-code-auto.ps1, claude-code-list.ps1 and claude-code-add.ps1: the same
# path resolution, the same raw-JSON surgery, the same usage client. Four copies
# meant four places to fix a bug, and they had already drifted (one wrote its
# snapshots atomically, another did not).
#
# Dot-source it: . (Join-Path $PSScriptRoot 'claude-cc-common.ps1')
#
# It also owns the secret handling: on Windows a snapshot's credentials are
# stored DPAPI-protected for the current user, so the OAuth tokens are no longer
# readable text sitting in the profile. Snapshots written before that change are
# still read as they were, and are protected the next time they are written.

# -- Platform ------------------------------------------------------------------
# $IsMacOS and friends only exist on PowerShell Core/7+.
$CcPlatformMac = $false
$CcPlatformWin = $true
if (Test-Path variable:IsMacOS)   { $CcPlatformMac = $IsMacOS }
if (Test-Path variable:IsWindows) { $CcPlatformWin = $IsWindows }

$CcStore           = Join-Path $HOME '.claude-cc-accounts'
$CcBackupDir       = Join-Path $CcStore '.backups'
$CcRelaunchLog     = Join-Path $CcStore 'relaunch.log'
$CcRelaunchFailed  = Join-Path $CcStore '.last-relaunch-failed'
$CcKeychainService = 'Claude Code-credentials'

# -- Where Claude Code keeps its login -----------------------------------------
$CcConfigDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }

$__credCandidates = @(
    (Join-Path $CcConfigDir '.credentials.json'),
    (Join-Path (Join-Path $HOME '.claude') '.credentials.json')
) | Select-Object -Unique
$CcCredFile = ($__credCandidates | Where-Object { Test-Path $_ } | Get-Item -EA SilentlyContinue |
               Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
if (-not $CcCredFile) { $CcCredFile = $__credCandidates[0] }

# The .claude.json that actually carries oauthAccount - not just the first one
# that exists, since a stale copy in another location would name the wrong
# account in /status.
$__cfgCandidates = @(
    (Join-Path $HOME '.claude.json'),
    (Join-Path $CcConfigDir '.claude.json'),
    (Join-Path (Join-Path $HOME '.claude') '.claude.json')
) | Select-Object -Unique
$CcConfigFile = $null
foreach ($c in ($__cfgCandidates | Where-Object { Test-Path $_ } | Get-Item -EA SilentlyContinue | Sort-Object LastWriteTime -Descending)) {
    try { if ((Get-Content $c.FullName -Raw) -match '"oauthAccount"') { $CcConfigFile = $c.FullName; break } } catch {}
}
if (-not $CcConfigFile) { $CcConfigFile = $__cfgCandidates[0] }

$CcCredLabel = if ($CcPlatformMac) { 'the login Keychain' } else { $CcCredFile }

# -- Console output ------------------------------------------------------------
# Every tool printed through its own copy of this one-liner. PowerShell resolves
# an unassigned variable in the caller's scope, so $Quiet here is the -Quiet
# switch of whichever script called: the scripts that have no such parameter see
# $null and print, which is what they did before.
function Say($text, $color = 'Gray') {
    if ($Quiet) { return }
    Write-Host $text -ForegroundColor $color
}

# -- File permissions ----------------------------------------------------------
# These files hold OAuth tokens, so they are for this user only. icacls rather
# than Set-Acl: rewriting a whole descriptor from PowerShell wants
# SeSecurityPrivilege, which a normal session does not hold.
function Protect-CcFile($path) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    if (-not $CcPlatformWin) {
        try { & chmod 600 $path 2>$null | Out-Null } catch { }
        return
    }
    try {
        $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        & icacls $path /inheritance:r /grant:r "${me}:(F)" 2>&1 | Out-Null
    } catch { }   # worst case the file keeps the folder's permissions
}

function Protect-CcDirectory($path) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    if (-not $CcPlatformWin) {
        try { & chmod 700 $path 2>$null | Out-Null } catch { }
        return
    }
    try {
        $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        & icacls $path /inheritance:r /grant:r "${me}:(OI)(CI)(F)" 2>&1 | Out-Null
    } catch { }
}

# -- DPAPI ---------------------------------------------------------------------
# Windows only, and tied to this Windows user: a copy of the file taken to
# another account or another machine decrypts to nothing.
$script:CcDpapiChecked = $false
$script:CcDpapiOk      = $false
function Test-CcDpapi {
    if ($script:CcDpapiChecked) { return $script:CcDpapiOk }
    $script:CcDpapiChecked = $true
    $script:CcDpapiOk = $false
    if (-not $CcPlatformWin) { return $false }
    try {
        Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue
        $probe = [System.Text.Encoding]::UTF8.GetBytes('probe')
        $enc   = [System.Security.Cryptography.ProtectedData]::Protect($probe, $null, 'CurrentUser')
        [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser') | Out-Null
        $script:CcDpapiOk = $true
    } catch { $script:CcDpapiOk = $false }
    return $script:CcDpapiOk
}

# -- The same idea off Windows ---------------------------------------------------
# DPAPI has no counterpart on macOS or Linux, and until now that meant OAuth
# tokens sat in the profile as readable JSON with nothing but file permissions in
# front of them. The stand-in is AES-GCM under a 32-byte key held by the OS
# secret store - the login Keychain on macOS, libsecret (`secret-tool`) on Linux.
# When neither answers there is no key, Protect-CcText returns $null exactly as
# it did before, and the caller falls back to writing the snapshot in the clear.
$script:CcSecretKey        = $null
$script:CcSecretKeyChecked = $false
$CcSecretAccount           = 'claude-cc-switcher'
$CcSecretPrefix            = 'ccx1:'    # marks a blob this scheme wrote

function Get-CcSecretBackend {
    if ($CcPlatformWin) { return $(if (Test-CcDpapi) { 'dpapi' } else { 'none' }) }
    if ($CcPlatformMac) { return $(if (Get-Command security -ErrorAction SilentlyContinue) { 'keychain' } else { 'none' }) }
    if (Get-Command secret-tool -ErrorAction SilentlyContinue) { return 'libsecret' }
    return 'none'
}

# The key itself, from the OS store, made on first use. $null means the store is
# not there (a headless Linux box with no keyring daemon is the usual case).
function Get-CcSecretKey([switch]$Create) {
    if ($script:CcSecretKeyChecked -and $script:CcSecretKey) { return $script:CcSecretKey }
    $backend = Get-CcSecretBackend
    if ($backend -eq 'dpapi' -or $backend -eq 'none') { $script:CcSecretKeyChecked = $true; return $null }

    $b64 = $null
    try {
        if ($backend -eq 'keychain') {
            $b64 = (@(& security find-generic-password -s $CcSecretAccount -a $CcSecretAccount -w 2>$null)[0])
        } else {
            $b64 = (@(& secret-tool lookup service $CcSecretAccount key master 2>$null)[0])
        }
    } catch {}
    if ($b64) { $b64 = ([string]$b64).Trim() }

    if (-not $b64 -and $Create) {
        $key = New-Object byte[] 32
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($key) } finally { $rng.Dispose() }
        $b64 = [Convert]::ToBase64String($key)
        $stored = $false
        try {
            if ($backend -eq 'keychain') {
                & security add-generic-password -U -s $CcSecretAccount -a $CcSecretAccount -w $b64 2>$null | Out-Null
                $stored = ($LASTEXITCODE -eq 0)
            } else {
                # -label is what shows up in a keyring browser; the lookup is by
                # the service/key attributes underneath it.
                $b64 | & secret-tool store --label='Claude Code account switcher' service $CcSecretAccount key master 2>$null | Out-Null
                $stored = ($LASTEXITCODE -eq 0)
            }
        } catch { $stored = $false }
        # A key that could not be stored cannot be read back, so anything encrypted
        # with it would be lost on the next run: better no encryption at all.
        if (-not $stored) { $b64 = $null }
    }
    $script:CcSecretKeyChecked = $true
    if (-not $b64) { return $null }
    try { $script:CcSecretKey = [Convert]::FromBase64String($b64) } catch { $script:CcSecretKey = $null }
    return $script:CcSecretKey
}

# AesGcm(key) is obsolete on .NET 8; the tag size has to be named there, and the
# two-argument form does not exist on older runtimes. Both are tried.
function New-CcAesGcm([byte[]]$key) {
    try { return [System.Security.Cryptography.AesGcm]::new($key, 16) }
    catch { return [System.Security.Cryptography.AesGcm]::new($key) }
}

function Protect-CcText($text) {
    if ($null -eq $text) { return $null }
    if ($CcPlatformWin) {
        if (-not (Test-CcDpapi)) { return $null }
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$text)
            return [Convert]::ToBase64String(
                [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser'))
        } catch { return $null }
    }
    $key = Get-CcSecretKey -Create
    if (-not $key) { return $null }
    try {
        $plain  = [System.Text.Encoding]::UTF8.GetBytes([string]$text)
        $nonce  = New-Object byte[] 12
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($nonce) } finally { $rng.Dispose() }
        $cipher = New-Object byte[] $plain.Length
        $tag    = New-Object byte[] 16
        $gcm = New-CcAesGcm $key
        try { $gcm.Encrypt($nonce, $plain, $cipher, $tag) } finally { $gcm.Dispose() }
        # nonce | tag | ciphertext, so the reader can slice it without a header.
        $out = New-Object byte[] ($nonce.Length + $tag.Length + $cipher.Length)
        [Array]::Copy($nonce, 0, $out, 0, $nonce.Length)
        [Array]::Copy($tag, 0, $out, $nonce.Length, $tag.Length)
        [Array]::Copy($cipher, 0, $out, $nonce.Length + $tag.Length, $cipher.Length)
        return $CcSecretPrefix + [Convert]::ToBase64String($out)
    } catch { return $null }
}

function Unprotect-CcText($blob) {
    if (-not $blob) { return $null }
    $text = [string]$blob
    if ($text.StartsWith($CcSecretPrefix)) {
        $key = Get-CcSecretKey
        if (-not $key) { return $null }
        try {
            $all    = [Convert]::FromBase64String($text.Substring($CcSecretPrefix.Length))
            if ($all.Length -lt 28) { return $null }
            $nonce  = $all[0..11]
            $tag    = $all[12..27]
            $cipher = New-Object byte[] ($all.Length - 28)
            [Array]::Copy($all, 28, $cipher, 0, $cipher.Length)
            $plain  = New-Object byte[] $cipher.Length
            $gcm = New-CcAesGcm $key
            try { $gcm.Decrypt($nonce, $cipher, $tag, $plain) } finally { $gcm.Dispose() }
            return [System.Text.Encoding]::UTF8.GetString($plain)
        } catch { return $null }
    }
    if (-not (Test-CcDpapi)) { return $null }
    try {
        $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            [Convert]::FromBase64String($text), $null, 'CurrentUser')
        return [System.Text.Encoding]::UTF8.GetString($bytes)
    } catch { return $null }
}

# -- Snapshot shape ------------------------------------------------------------
# A snapshot is { email, savedAt, oauthAccountRaw, usageCache } plus the login
# itself, held either as `credentialsProtected` (DPAPI, current format) or as a
# plain `credentials` object (what every snapshot looked like before).

function Get-CcSnapshotCreds($json) {
    if (-not $json) { return $null }
    if ($json.credentialsProtected) {
        $text = Unprotect-CcText $json.credentialsProtected
        if (-not $text) { return $null }      # written by another user, or another machine
        try { return ($text | ConvertFrom-Json) } catch { return $null }
    }
    if ($json.credentials) { return $json.credentials }
    return $null
}

# True when the file carries a login at all - a snapshot whose protected blob
# cannot be decrypted here still counts as "has one", so it is reported as
# unreadable instead of silently vanishing from the pool.
function Test-CcSnapshotHasCreds($json) {
    if (-not $json) { return $false }
    return [bool]($json.credentialsProtected -or $json.credentials)
}

# Build the object that goes on disk, protecting the login when DPAPI is
# available and falling back to the old plain shape when it is not (Linux, and
# a Windows account where DPAPI is somehow unusable).
function New-CcSnapshotEntry($email, $creds, $oauthAccountRaw, $usageCache) {
    $entry = [ordered]@{ email = $email; savedAt = (Get-Date -Format o) }
    $blob = $null
    if ($creds) { $blob = Protect-CcText ($creds | ConvertTo-Json -Depth 20 -Compress) }
    if ($blob) { $entry.credentialsProtected = $blob } else { $entry.credentials = $creds }
    if ($oauthAccountRaw) { $entry.oauthAccountRaw = $oauthAccountRaw }
    if ($usageCache) { $entry.usageCache = $usageCache }
    return $entry
}

# One move, never a half-written file: a truncated snapshot costs that account
# its login.
function Write-CcJsonFile($path, $object) {
    $tmp = "$path.tmp"
    [System.IO.File]::WriteAllText($tmp, ($object | ConvertTo-Json -Depth 20),
        (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $path -Force
    Protect-CcFile $path
}

# -- Raw-JSON surgery on .claude.json ------------------------------------------
# oauthAccount is copied and replaced as raw text so the rest of the file, and
# the object's own nested fields and dates, survive byte-for-byte; a
# ConvertTo-Json round-trip would rewrite them.
function Get-JsonObjRaw($text, $key) {
    $m = [regex]::Match($text, '"' + [regex]::Escape($key) + '"\s*:\s*')
    if (-not $m.Success) { return $null }
    $i = $m.Index + $m.Length
    if ($i -ge $text.Length -or $text[$i] -ne '{') { return $null }
    $depth = 0; $inStr = $false; $esc = $false
    for ($j = $i; $j -lt $text.Length; $j++) {
        $ch = $text[$j]
        if ($esc) { $esc = $false; continue }
        if ($ch -eq '\') { $esc = $true; continue }
        if ($ch -eq '"') { $inStr = -not $inStr; continue }
        if ($inStr) { continue }
        if ($ch -eq '{') { $depth++ }
        elseif ($ch -eq '}') { $depth--; if ($depth -eq 0) { return $text.Substring($i, $j - $i + 1) } }
    }
    return $null
}

function Set-JsonObjRaw($text, $key, $newRaw) {
    $m = [regex]::Match($text, '"' + [regex]::Escape($key) + '"\s*:\s*')
    if (-not $m.Success) { return $null }
    $i = $m.Index + $m.Length
    if ($i -ge $text.Length -or $text[$i] -ne '{') { return $null }
    $depth = 0; $inStr = $false; $esc = $false
    for ($j = $i; $j -lt $text.Length; $j++) {
        $ch = $text[$j]
        if ($esc) { $esc = $false; continue }
        if ($ch -eq '\') { $esc = $true; continue }
        if ($ch -eq '"') { $inStr = -not $inStr; continue }
        if ($inStr) { continue }
        if ($ch -eq '{') { $depth++ }
        elseif ($ch -eq '}') { $depth--; if ($depth -eq 0) { return $text.Substring(0, $i) + $newRaw + $text.Substring($j + 1) } }
    }
    return $null
}

# -- The live login ------------------------------------------------------------
function Get-CcLiveCredsRaw {
    if ($CcPlatformMac) {
        try {
            $out = & security find-generic-password -s $CcKeychainService -w 2>$null
            if ($LASTEXITCODE -eq 0 -and $out) { return ($out -join "`n") }
        } catch {}
        return $null
    }
    if (Test-Path $CcCredFile) { try { return (Get-Content $CcCredFile -Raw) } catch {} }
    return $null
}

function Set-CcLiveCredsRaw($json) {
    if ($CcPlatformMac) {
        $acct = $env:USER; if (-not $acct) { try { $acct = (& id -un) } catch {} }
        # Through stdin when the shell allows it: an argument to -w is visible in
        # `ps` to every other user on the machine for as long as the call runs.
        $viaStdin = $false
        try {
            $json | & security add-generic-password -U -s $CcKeychainService -a $acct -w 2>$null | Out-Null
            $viaStdin = ($LASTEXITCODE -eq 0)
        } catch { $viaStdin = $false }
        if (-not $viaStdin) {
            & security add-generic-password -U -s $CcKeychainService -a $acct -w $json 2>$null | Out-Null
        }
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $CcCredFile) | Out-Null
    [System.IO.File]::WriteAllText($CcCredFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    Protect-CcFile $CcCredFile
}

function Remove-CcLiveCreds {
    if ($CcPlatformMac) {
        & security delete-generic-password -s $CcKeychainService 2>$null | Out-Null
        return
    }
    Remove-Item $CcCredFile -Force -ErrorAction SilentlyContinue
}

# The identity Claude Code shows in /status, read from .claude.json - the token
# itself says nothing about which account it belongs to.
function Get-CcLiveOAuthRaw {
    if (-not (Test-Path $CcConfigFile)) { return $null }
    try { return (Get-JsonObjRaw (Get-Content $CcConfigFile -Raw) 'oauthAccount') } catch { return $null }
}

function Set-CcLiveOAuthRaw($oauthAccountRaw) {
    if (-not $oauthAccountRaw -or -not (Test-Path $CcConfigFile)) { return $false }
    try {
        $raw     = Get-Content $CcConfigFile -Raw
        $updated = Set-JsonObjRaw $raw 'oauthAccount' $oauthAccountRaw
        if ($updated -and $updated -ne $raw) {
            Copy-Item $CcConfigFile "$CcConfigFile.bak" -Force -ErrorAction SilentlyContinue
            [System.IO.File]::WriteAllText($CcConfigFile, $updated, (New-Object System.Text.UTF8Encoding($false)))
            return $true
        }
    } catch {}
    return $false
}

# The live credentials, copied aside before they are overwritten - the only
# recovery path when the account being left was never saved. Protected like the
# snapshots: it is the same token in the same profile.
function Backup-CcLiveCreds($liveRaw) {
    if (-not $liveRaw) { return }
    New-Item -ItemType Directory -Force -Path $CcBackupDir | Out-Null
    Protect-CcDirectory $CcBackupDir
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $blob  = Protect-CcText $liveRaw
    if ($blob) {
        $path = Join-Path $CcBackupDir ("backup-{0}.credentials.dpapi" -f $stamp)
        [System.IO.File]::WriteAllText($path, $blob, (New-Object System.Text.UTF8Encoding($false)))
    } else {
        $path = Join-Path $CcBackupDir ("backup-{0}.credentials.json" -f $stamp)
        [System.IO.File]::WriteAllText($path, $liveRaw, (New-Object System.Text.UTF8Encoding($false)))
    }
    Protect-CcFile $path
    Get-ChildItem $CcBackupDir -Filter 'backup-*.credentials.*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction SilentlyContinue
}

# -- Keeping the snapshot of the live account current ---------------------------
# Claude Code rotates its refresh token every time it renews the access token,
# and the server drops the previous one the moment it does. A snapshot therefore
# goes stale on its own, while nobody touches it: the session refreshes, the
# saved copy still points at the retired token, and coming back to that account
# needs a browser /login.
#
# claude-code-select syncs the account it is leaving, which covers the switch
# itself. It does not cover the rotation that happens minutes later - a thread
# still running on the old account, the desktop app, another window. So the same
# sync runs on a timer (the watcher) and at session start (the hook).
#
# Cheap by design: it compares the access token the snapshot holds against the
# live one and writes nothing when they are the same, which is every tick but
# the few that follow a rotation.
function Sync-CcLiveSnapshot {
    [CmdletBinding()]
    param([switch]$Force)

    if (-not $CcCredFile -and -not $CcPlatformMac) { return $null }

    $liveRaw = Get-CcLiveCredsRaw
    if (-not $liveRaw) { return $null }
    $liveCreds = $null
    try { $liveCreds = $liveRaw | ConvertFrom-Json } catch { return $null }
    $liveToken = $liveCreds.claudeAiOauth.accessToken
    if (-not $liveToken) { return $null }

    $liveOAuthRaw = Get-CcLiveOAuthRaw
    $liveEmail    = $null
    if ($liveOAuthRaw) { try { $liveEmail = ($liveOAuthRaw | ConvertFrom-Json).emailAddress } catch {} }

    # Only a snapshot that already exists is written. Saving a login nobody
    # asked to save is claude-code-add's job, and doing it here would quietly
    # add every account that ever logged in on this machine.
    $target = $null
    foreach ($f in (Get-ChildItem $CcStore -Filter '*.json' -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -notlike 'backup-*' -and -not $_.Name.StartsWith('.') })) {
        $j = $null
        try { $j = Get-Content $f.FullName -Raw | ConvertFrom-Json } catch { continue }
        if (-not (Test-CcSnapshotHasCreds $j)) { continue }
        $creds = Get-CcSnapshotCreds $j
        $tok   = if ($creds) { $creds.claudeAiOauth.accessToken } else { $null }
        $mail  = $null
        if ($j.oauthAccountRaw) { try { $mail = ($j.oauthAccountRaw | ConvertFrom-Json).emailAddress } catch {} }
        # Same token means same snapshot beyond doubt. The email is the fallback
        # for the tick that runs after a rotation, when the tokens no longer
        # match - which is exactly the case this function exists for.
        $hit = ($tok -and $tok -eq $liveToken) -or
               ($liveEmail -and (($mail -and $mail -eq $liveEmail) -or (-not $mail -and $j.email -eq $liveEmail)))
        if (-not $hit) { continue }
        $target = [pscustomobject]@{ File = $f.FullName; Name = $f.Name; Json = $j; Token = $tok }
        break
    }
    if (-not $target) { return $null }

    if (-not $Force -and $target.Token -and $target.Token -eq $liveToken) { return $null }

    $email    = if ($target.Json.email) { $target.Json.email } else { $liveEmail }
    # The identity is taken from the live login when it names this account: a
    # snapshot saved under the wrong address heals itself here, same as it does
    # on a switch.
    $keepRaw  = if ($liveEmail -and $liveEmail -eq $email -and $liveOAuthRaw) { $liveOAuthRaw } else { $target.Json.oauthAccountRaw }
    try {
        Write-CcJsonFile $target.File (New-CcSnapshotEntry $email $liveCreds $keepRaw $target.Json.usageCache)
    } catch { return $null }
    # The pool stamp covers the login, so a rotation the switcher recorded itself
    # must not read as tampering the next time the pool is verified.
    if (Get-Command Register-PoolEntry -ErrorAction SilentlyContinue) {
        try { Register-PoolEntry $target.Name $email $keepRaw $liveCreds | Out-Null } catch {}
    }
    return [pscustomobject]@{ Email = $email; File = $target.File; Name = $target.Name }
}

# -- Reading the pool ----------------------------------------------------------
# Every script that does anything with the saved accounts starts the same way:
# list the snapshot files, parse each one, ask the pool manifest whether it is
# vouched for, and pull the real identity out of oauthAccountRaw. That was five
# copies of the same twenty lines, drifting one fix at a time; it is one copy
# here, and the callers differ only in what they do with a refused entry.

# The files that are account snapshots. `backup-*` and dotted names are the
# switcher's own bookkeeping, not accounts.
function Get-CcSnapshotFiles {
    Get-ChildItem $CcStore -Filter '*.json' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike 'backup-*' -and -not $_.Name.StartsWith('.') } |
        Sort-Object Name
}

# Whose login a snapshot really holds, as Claude Code reported it when the
# snapshot was taken. The file name and the email field are only typed text.
function Get-CcIdentity($oauthAccountRaw) {
    if (-not $oauthAccountRaw) { return $null }
    try { return ($oauthAccountRaw | ConvertFrom-Json).emailAddress } catch { return $null }
}

# Why a snapshot is refused, in one sentence. 'sealed' is ours (the login is
# encrypted for another user or machine, so there is nothing to verify); the
# rest are the pool manifest's verdicts, worded by claude-cc-pool.ps1 when it is
# loaded.
function Get-CcRefusalText($verdict) {
    if ($verdict -eq 'sealed') { return 'its login is encrypted for another Windows user or another machine' }
    if (Get-Command Get-PoolVerdictText -ErrorAction SilentlyContinue) { return (Get-PoolVerdictText $verdict) }
    return 'the pool does not vouch for it'
}

# The pool, one object per readable snapshot, in file-name order. Unreadable and
# credential-less files are dropped; a snapshot the manifest refuses is kept,
# with Trust set and Refused holding the reason, because the numbering behind
# -Index has to mean the same thing from one run to the next.
#
# -AllowUntrusted clears Refused without hiding Trust, so a caller can force a
# switch and still say what it forced.
function Get-CcPool {
    param([switch]$AllowUntrusted)
    # Verification needs both the manifest and the code that reads it; without
    # either there is nothing to check against and the pool is read as before.
    $canVerify = $false
    if (Get-Command Test-PoolEntry -ErrorAction SilentlyContinue) {
        $mv = Get-Variable PoolManifest -ErrorAction SilentlyContinue
        $canVerify = [bool]($mv -and $mv.Value -and (Test-Path $mv.Value))
    }
    foreach ($f in (Get-CcSnapshotFiles)) {
        $j = $null
        try { $j = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json } catch { continue }
        if (-not $j.email -or -not (Test-CcSnapshotHasCreds $j)) { continue }
        $creds = Get-CcSnapshotCreds $j
        $trust = 'trusted'
        if (-not $creds) { $trust = 'sealed' }
        elseif ($canVerify) { $trust = Test-PoolEntry $f.Name $j.email $j.oauthAccountRaw $creds }
        $refused = $null
        if ($trust -ne 'trusted' -and -not ($AllowUntrusted -and $creds)) { $refused = Get-CcRefusalText $trust }
        [pscustomobject]@{
            Email     = $j.email
            File      = $f.FullName
            Name      = $f.Name
            Json      = $j
            Creds     = $creds
            Token     = if ($creds) { $creds.claudeAiOauth.accessToken } else { $null }
            OAuthRaw  = $j.oauthAccountRaw
            Identity  = Get-CcIdentity $j.oauthAccountRaw
            Cache     = $j.usageCache
            Trust     = $trust
            Refused   = $refused
            Protected = [bool]$j.credentialsProtected
        }
    }
}

# The account Claude Code is logged in as right now, whether or not it was ever
# saved: the raw credentials, the access token that identifies a snapshot, and
# the address from ~/.claude.json. Every field is $null when there is no login.
function Get-CcLiveIdentity {
    $raw = Get-CcLiveCredsRaw
    $token = $null
    if ($raw) { try { $token = ($raw | ConvertFrom-Json).claudeAiOauth.accessToken } catch {} }
    $oauthRaw = Get-CcLiveOAuthRaw
    [pscustomobject]@{
        Raw      = $raw
        Token    = $token
        OAuthRaw = $oauthRaw
        Email    = Get-CcIdentity $oauthRaw
    }
}

# The pool entry that holds the live login: by token first, since that is the
# credential itself, and by address only as a fallback for a snapshot whose
# tokens were rotated elsewhere.
function Find-CcCurrent($pool, $live) {
    if (-not $pool -or -not $live) { return $null }
    $hit = $null
    if ($live.Token) { $hit = $pool | Where-Object { $_.Token -eq $live.Token } | Select-Object -First 1 }
    if (-not $hit -and $live.Email) { $hit = $pool | Where-Object { $_.Email -eq $live.Email } | Select-Object -First 1 }
    return $hit
}

# -- settings.json -------------------------------------------------------------
# Claude Code's settings file belongs to the user, so it is read whole, merged
# into, and written back through a temp file with the previous version kept as
# .bak - never rewritten from what this toolkit happens to know about.

$CcSettingsFile = Join-Path $CcConfigDir 'settings.json'

# Throws when the file exists and is not JSON: overwriting a settings file we
# could not read would lose whatever is in it.
function Read-CcSettings($path = $CcSettingsFile) {
    $root = [ordered]@{}
    if (Test-Path -LiteralPath $path) {
        $existing = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        foreach ($p in $existing.PSObject.Properties) { $root[$p.Name] = $p.Value }
    }
    return $root
}

# Is the SessionStart hook configured? Grepped rather than parsed on purpose:
# this answers "would a session register itself", and a settings file that is
# half-written or of an unexpected shape must not throw on the way to a status
# line.
function Test-CcSessionHook($path = $CcSettingsFile) {
    return (Test-Path -LiteralPath $path) -and
           (Select-String -Path $path -Pattern 'claude-code-hook\.ps1' -Quiet -ErrorAction SilentlyContinue)
}

function Save-CcSettings($root, $path = $CcSettingsFile) {
    New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
    if (Test-Path -LiteralPath $path) {
        Copy-Item -LiteralPath $path -Destination "$path.bak" -Force -ErrorAction SilentlyContinue
    }
    $tmp = "$path.tmp"
    [System.IO.File]::WriteAllText($tmp, ([pscustomobject]$root | ConvertTo-Json -Depth 12),
        (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $path -Force
}

# -- Pid files -----------------------------------------------------------------
# `.watch.pid` and friends are plain text written by another process, so they can
# be empty, half written or left behind by a crash. A bare [int] cast on that is
# a terminating error, and under $ErrorActionPreference = 'Stop' it takes the
# whole script down - the watcher used to die on a file it wrote itself.
function Read-CcPidFile($path) {
    if (-not (Test-Path -LiteralPath $path)) { return 0 }
    $raw = $null
    try { $raw = (Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue) } catch { return 0 }
    if (-not $raw) { return 0 }
    $raw = $raw.Trim()
    if ($raw -notmatch '^\d+$') { return 0 }
    try { return [int]$raw } catch { return 0 }
}

# The process a pid file names, only if it is still the kind of process that
# wrote it: a pid is reused within minutes on a busy machine, and stopping one
# on trust means stopping whatever inherited the number.
function Get-CcPidFileProcess($path, $namePattern) {
    $procId = Read-CcPidFile $path
    if (-not $procId) { return $null }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    if ($namePattern -and $p.ProcessName -notmatch $namePattern) { return $null }
    return $p
}

# -- Looking at another process --------------------------------------------------
# Win32_Process is a Windows notion. Off Windows the same three facts - name,
# parent, command line - come from ps(1), and on Linux the argv comes from /proc,
# which keeps the arguments as they were passed instead of flattening them into
# one string the way ps does.
function Get-CcProcessInfo([int]$procId) {
    if ($procId -le 0) { return $null }
    if ($CcPlatformWin) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
        if (-not $p) { return $null }
        return [pscustomobject]@{
            Id          = [int]$p.ProcessId
            Name        = $p.Name
            Parent      = [int]$p.ParentProcessId
            Path        = $p.ExecutablePath
            CommandLine = $p.CommandLine
        }
    }
    $name = $null
    $parent = 0
    try {
        $line = @(& ps -p $procId -o ppid=,comm= 2>$null)[0]
        if ($line) {
            $parts = $line.Trim() -split '\s+', 2
            $parent = [int]$parts[0]
            # comm is a path on macOS and a bare name on Linux.
            if ($parts.Count -gt 1) { $name = Split-Path $parts[1].Trim() -Leaf }
        }
    } catch {}
    if (-not $name) { return $null }
    $cmd = $null
    $argvFile = "/proc/$procId/cmdline"
    if (Test-Path -LiteralPath $argvFile) {
        try {
            $argv = @(([System.IO.File]::ReadAllText($argvFile) -split "`0") | Where-Object { $_ -ne '' })
            # Requoted, because the caller hands this back to a shell.
            if ($argv.Count) {
                $cmd = ($argv | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
            }
        } catch {}
    }
    if (-not $cmd) { try { $cmd = @(& ps -p $procId -o args= 2>$null)[0] } catch {} }
    $exe = $null
    try { $exe = (Get-Process -Id $procId -ErrorAction SilentlyContinue).Path } catch {}
    return [pscustomobject]@{ Id = $procId; Name = $name; Parent = $parent; Path = $exe; CommandLine = $cmd }
}

# What a Claude Code process looks like. On Windows it is claude.exe and the name
# settles it; elsewhere the CLI is often started through node, where the process
# name says nothing and the command line is the only evidence.
function Test-CcClaudeProcess($info) {
    if (-not $info) { return $false }
    if ($info.Name -match '^claude') { return $true }
    if ($CcPlatformWin) { return $false }
    if ($info.Name -match '^(node|bun|deno)' -and
        $info.CommandLine -match '(^|[/\s"])claude(\s|"|$|\.[jm]?js|/cli)') { return $true }
    return $false
}

# The same question for a pid, with the name check applied the same way
# everywhere. $true only when that pid is a live Claude Code session.
function Test-CcClaudePid([int]$procId) {
    if ($procId -le 0) { return $false }
    if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { return $false }
    return (Test-CcClaudeProcess (Get-CcProcessInfo $procId))
}

# -- Log files -----------------------------------------------------------------
# The watcher writes a line every probe and the relaunch watchdog a handful per
# refresh; neither ever removed one. Kept to the last $Keep lines, checked only
# when the file is big enough to matter.
function Limit-CcLog($path, $Keep = 500) {
    try {
        if (-not (Test-Path -LiteralPath $path)) { return }
        $f = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
        if (-not $f -or $f.Length -lt 128KB) { return }
        $tail = Get-Content -LiteralPath $path -Tail $Keep -ErrorAction SilentlyContinue
        if ($null -eq $tail) { return }
        $tmp = "$path.tmp"
        [System.IO.File]::WriteAllLines($tmp, [string[]]@($tail), (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination $path -Force
    } catch {}
}

# -- The credential swap -------------------------------------------------------
# Two switchers writing the live credentials at the same moment - the watcher on
# a tick and the user running /claude-account-auto-switch - can interleave a
# backup, a write and a .claude.json rewrite into a login that belongs to no
# account. Everything that touches the live credentials takes this first.
function Invoke-CcCredSwapLocked([scriptblock]$body, [int]$TimeoutMs = 15000) {
    $mutex = New-Object System.Threading.Mutex($false, 'Global\ClaudeCcCredentialSwap')
    $held = $false
    try {
        try { $held = $mutex.WaitOne($TimeoutMs) } catch [System.Threading.AbandonedMutexException] { $held = $true }
        return & $body
    } finally {
        if ($held) { try { $mutex.ReleaseMutex() } catch {} }
        $mutex.Dispose()
    }
}

# -- Usage ---------------------------------------------------------------------
# HttpClient rather than Invoke-RestMethod: under Windows PowerShell 5.1 the
# latter can hang reading a successful response from this endpoint.
Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
$script:CcHttpClient = $null
function Get-ClaudeUsage($accessToken) {
    if (-not $accessToken) { return $null }
    try {
        if (-not $script:CcHttpClient) {
            $handler = New-Object System.Net.Http.HttpClientHandler
            $script:CcHttpClient = New-Object System.Net.Http.HttpClient($handler)
            $script:CcHttpClient.Timeout = [TimeSpan]::FromSeconds(8)
        }
        $req = New-Object System.Net.Http.HttpRequestMessage('GET', 'https://api.anthropic.com/api/oauth/usage')
        $req.Headers.Add('Authorization', "Bearer $accessToken")
        $req.Headers.Add('anthropic-version', '2023-06-01')
        $req.Headers.Add('anthropic-beta', 'oauth-2025-04-20')
        $resp = $script:CcHttpClient.SendAsync($req).GetAwaiter().GetResult()
        if (-not $resp.IsSuccessStatusCode) { return $null }
        return ($resp.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json)
    } catch { return $null }
}

# -- Where "rate limited" starts -----------------------------------------------
# One definition for the whole toolkit: the switcher, the watcher, the listing
# and the status block all read these, so a row that says "usable" is usable by
# exactly the rule that will be applied when the switch happens.
#
# The two windows are not set to the same number on purpose. The 5-hour window
# refills a few hours later, so the last point left on it costs a short wait at
# worst. The weekly window does not come back for
# days, so every tenth of a percent left on it is real work that would be thrown
# away: it is spent down to 99.8% before the account is called full.
$CcThreshold       = 99
$CcWeeklyThreshold = 99.8

# A missing utilization must stay unknown: [int]$null is 0, which would read as
# "this account is completely free" and send a switch straight to it.
#
# The value is kept fractional. Rounding to a whole percent would make the 99.8%
# weekly cap unusable: an account really at 99.4% would round to 99 (under) or,
# at 99.6%, to 100 (over), so the switch would fire early or late by up to half a
# percent of a weekly quota. One decimal is as fine as the API reports.
function Get-Util($u, $window) {
    if (-not $u) { return $null }
    try {
        $v = $u.$window.utilization
        if ($null -eq $v) { return $null }
        return [math]::Round([double]$v, 1)
    } catch { return $null }
}

# Percentages print at whole numbers, except in the last point before 100 where
# the decimal is the whole point: "99.8%" and "100%" are the difference between
# a usable account and a full one, and " 99%" would hide it.
function Format-CcPct($v, $width = 4) {
    if ($null -eq $v) { return '?'.PadLeft($width + 1) }
    # Invariant culture: a decimal comma next to a percent sign reads badly in a
    # table whose other columns are ASCII, and the same string is grepped by the
    # tests.
    $inv = [cultureinfo]::InvariantCulture
    $s = if ($v -gt 99 -and $v -lt 100) { ([double]$v).ToString('0.0', $inv) + '%' }
         else { ([double]$v).ToString('0', $inv) + '%' }
    return $s.PadLeft($width + 1)
}

# Is this reading at or over its cap?
#
# The API reports whole percents, so a reading of 99 covers everything from
# 99.0 to 99.9 - the 99.8% cap sits inside it. Comparing 99 -ge 99.8 would say
# "room left" and only ever call the account full at 100, which is the moment
# the quota is already gone. A reading with no decimals is therefore measured
# against the floor of the cap: 99 counts as the weekly cap reached, while the
# 5-hour cap (a whole number) is unaffected.
function Test-CcOverCap($value, $cap) {
    if ($null -eq $value) { return $false }
    $v = [double]$value
    $c = if ($v -eq [math]::Floor($v)) { [math]::Floor([double]$cap) } else { [double]$cap }
    return ($v -ge $c)
}

# Whether the switcher would accept this account as a destination. An unread
# window is not a full one: the switcher can still go there, and it will read the
# real number when it arrives.
function Test-CcUsable($five, $seven) {
    if (Test-CcOverCap $five  $CcThreshold)       { return $false }
    if (Test-CcOverCap $seven $CcWeeklyThreshold) { return $false }
    return $true
}

# When a blocked account becomes a switch target again.
#
# An account is refused while ANY window sits at its cap, so it comes back only
# once the last of those windows has rolled over: its own moment is the latest
# of the resets that block it, not the first one. A window whose reset time has
# already passed is ignored - the percentage recorded against it describes a
# window that no longer exists.
#
# Returns $null when nothing blocks the account (it is usable now), otherwise an
# object whose .At is the moment it comes back, or $null when a blocking window
# reported no reset time at all: the wait is real but its length is unknown, and
# guessing one would put a countdown on screen that nothing backs.
function Get-CcReadyAt($u) {
    if (-not $u) { return $null }
    $now     = Get-Date
    $at      = $null
    $unknown = $false
    foreach ($window in @(
        @{ Name = 'five_hour'; Data = $u.five_hour; Cap = $CcThreshold },
        @{ Name = 'seven_day'; Data = $u.seven_day; Cap = $CcWeeklyThreshold }
    )) {
        $w = $window.Data
        if (-not $w) { continue }
        # Get-Util, not $w.utilization: it rounds to the one decimal the rest of
        # the toolkit compares against, so this countdown and the "usable" verdict
        # next to it are never computed from two different numbers.
        $pct = Get-Util $u $window.Name
        if ($null -eq $pct) { continue }
        $reset = ConvertTo-LocalTime $w.resets_at
        if ($reset -and $reset -le $now) { continue }          # already renewed
        if (-not (Test-CcOverCap $pct $window.Cap)) { continue }
        if (-not $reset) { $unknown = $true; continue }
        if (-not $at -or $reset -gt $at) { $at = $reset }
    }
    if ($unknown) { return [pscustomobject]@{ At = $null } }
    if (-not $at) { return $null }
    return [pscustomobject]@{ At = $at }
}

# A "come back later" duration, not a stopwatch: rounded to the minute, and
# never below 1m, so a reset that is seconds away still reads as a wait rather
# than as "0m". Same shape as the status-line segment (4h20m, 35m, 1d02h).
function Format-CcWait($span) {
    if ($null -eq $span) { return '' }
    $mins = [math]::Max(1, [int][math]::Round(([timespan]$span).TotalMinutes))
    if ($mins -lt 60) { return "{0}m" -f $mins }
    $hours = [int][math]::Floor($mins / 60)
    if ($hours -lt 24) { return "{0}h{1:00}m" -f $hours, ($mins % 60) }
    return "{0}d{1:00}h" -f [int][math]::Floor($hours / 24), ($hours % 24)
}

# `resets_at` does not arrive as a string: ConvertFrom-Json recognises the ISO
# timestamp and hands back a [datetime] already, so parsing it as text throws.
# Both shapes are handled, and a stamp with no zone is read as UTC, which is
# what the API sends.
function ConvertTo-LocalTime($value) {
    if ($null -eq $value) { return $null }
    if ($value -is [datetime]) {
        $dt = [datetime]$value
        if ($dt.Kind -eq [System.DateTimeKind]::Local) { return $dt }
        if ($dt.Kind -eq [System.DateTimeKind]::Unspecified) {
            return [datetime]::SpecifyKind($dt, [System.DateTimeKind]::Utc).ToLocalTime()
        }
        return $dt.ToLocalTime()
    }
    if ($value -is [datetimeoffset]) { return ([datetimeoffset]$value).LocalDateTime }
    try { return [datetimeoffset]::Parse([string]$value, [cultureinfo]::InvariantCulture).LocalDateTime }
    catch { return $null }
}

# The cached block is shaped like the API's own answer so the readers work on
# either without a second code path.
function ConvertFrom-UsageCache($c) {
    if (-not $c) { return $null }
    [pscustomobject]@{
        five_hour = [pscustomobject]@{ utilization = $c.five_hour.utilization; resets_at = $c.five_hour.resets_at }
        seven_day = [pscustomobject]@{ utilization = $c.seven_day.utilization; resets_at = $c.seven_day.resets_at }
    }
}

# A reading younger than this is reused instead of asking the API again: a
# -List right after a switch used to make one HTTP call per account for numbers
# that had not moved.
$CcUsageCacheSeconds = 60
function Test-CcUsageCacheFresh($cache, $seconds = $CcUsageCacheSeconds) {
    if (-not $cache -or -not $cache.checkedAt) { return $false }
    $t = ConvertTo-LocalTime $cache.checkedAt
    if (-not $t) { return $false }
    return (((Get-Date) - $t).TotalSeconds -lt $seconds)
}

# Every reading is written back into the account's own snapshot, so the 5h/7d
# figures stay available (with their age) once that snapshot's access token
# expires and the API stops answering for it. The login inside the file is left
# exactly as it was, so a snapshot's stamp in the pool manifest still matches.
function Save-UsageCache($file, $usage) {
    if (-not $usage -or -not $file) { return }
    if ($null -eq $usage.five_hour -and $null -eq $usage.seven_day) { return }
    try {
        $j = Get-Content $file -Raw | ConvertFrom-Json
        $cache = [ordered]@{
            checkedAt = (Get-Date -Format o)
            # Rounded to one decimal, not to a whole percent: the cache is what
            # the 99.8% weekly cap is compared against once the token expires.
            five_hour = [ordered]@{ utilization = (Get-Util $usage 'five_hour'); resets_at = $usage.five_hour.resets_at }
            seven_day = [ordered]@{ utilization = (Get-Util $usage 'seven_day'); resets_at = $usage.seven_day.resets_at }
        }
        $j | Add-Member -NotePropertyName usageCache -NotePropertyValue $cache -Force
        Write-CcJsonFile $file $j
    } catch {}
}

function Format-Until($t) {
    if (-not $t) { return '' }
    $d = $t - (Get-Date)
    if ($d.TotalSeconds -le 0) { return 'now' }
    # [int] on TotalHours rounds rather than truncates, which printed 2h39 as
    # "3h39m"; Format-CcWait carries the whole wait, so every clock in the
    # toolkit reads the same.
    $rel = Format-CcWait $d
    # A bare HH:mm on something two days out reads as tonight.
    $stamp = if ($t.Date -eq (Get-Date).Date) { $t.ToString('HH:mm') } else { $t.ToString('ddd MMM d, HH:mm') }
    return "$rel (at $stamp)"
}

function Format-UsagePair($u) {
    $u5 = Get-Util $u 'five_hour'
    $u7 = Get-Util $u 'seven_day'
    if ($null -eq $u5 -and $null -eq $u7) { return 'usage n/a' }
    return "5h {0} / 7d {1} used" -f (Format-CcPct $u5), (Format-CcPct $u7)
}

# -- The session that is running this ------------------------------------------
# Claude Code exports its own pid to everything it runs; the parent chain is only
# the fallback for shells that were not started by it.
function Get-HostSessionPid {
    if ($env:CLAUDE_PID) {
        $info = Get-CcProcessInfo ([int]$env:CLAUDE_PID)
        if (Test-CcClaudeProcess $info) { return [int]$env:CLAUDE_PID }
    }
    $walk = $PID
    for ($i = 0; $i -lt 8 -and $walk -gt 0; $i++) {
        $info = Get-CcProcessInfo $walk
        if (-not $info) { return $null }
        if (Test-CcClaudeProcess $info) { return [int]$info.Id }
        $walk = $info.Parent
    }
    return $null
}

# A refresh that never came back is only recorded in relaunch.log, which nobody
# reads. The watchdog leaves this flag instead, and the next switch says so.
function Show-CcRelaunchFailure {
    if (-not (Test-Path $CcRelaunchFailed)) { return }
    $msg = ''
    try { $msg = (Get-Content $CcRelaunchFailed -Raw).Trim() } catch {}
    Remove-Item -LiteralPath $CcRelaunchFailed -Force -ErrorAction SilentlyContinue
    if (-not $msg) { $msg = 'a previous refresh did not come back' }
    Write-Host "! Last refresh failed: $msg" -ForegroundColor Yellow
    Write-Host "  Check the wrapper: pwsh -NoProfile -File `"$HOME\.claude-tools\claude-code-shim.ps1`" -Status" -ForegroundColor Yellow
}

# -- Starting something that has to outlive this process -----------------------
# Two problems in one function. A process started the ordinary way joins the job
# object the terminal is in and is killed with the thread that spawned it, so
# the watcher and the relaunch watchdog are created through WMI instead. But WMI
# creates a console process *visible*: -WindowStyle Hidden only hides the window
# once PowerShell is already up, which is a terminal flashing on screen at every
# session start and every refresh. ShowWindow = SW_HIDE (0) in the startup
# information is what makes that window never appear in the first place.
# Returns the pid, or 0 when nothing could be started.
function Start-CcDetached([string]$FilePath, [string]$Arguments) {
    if ($CcPlatformWin) {
        try {
            $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly `
                       -Property @{ ShowWindow = [uint16]0 }
            $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
                     CommandLine               = ('"{0}" {1}' -f $FilePath, $Arguments)
                     ProcessStartupInformation = [CimInstance]$startup
                 } -ErrorAction Stop
            if ($r.ReturnValue -eq 0) { return [int]$r.ProcessId }
        } catch {}
    }
    else {
        # No job objects here, but a process left in the terminal's process group
        # takes the SIGHUP that closing it sends. setsid puts it in a session of
        # its own; nohup only blocks the signal, which is second best.
        foreach ($wrap in @('setsid', 'nohup')) {
            $tool = Get-Command $wrap -ErrorAction SilentlyContinue
            if (-not $tool) { continue }
            try {
                $p = Start-Process -FilePath $tool.Source -ArgumentList "`"$FilePath`" $Arguments" `
                                   -PassThru -ErrorAction Stop
                return [int]$p.Id
            } catch {}
        }
    }
    # Win32_Process.Create is refused outright on some locked-down machines, and
    # setsid is missing from a bare container. This last resort stays attached to
    # whatever started it - it dies with this terminal - but a watchdog that runs
    # is better than one that never started, and the log says which one it was.
    try {
        $splat = @{ FilePath = $FilePath; ArgumentList = $Arguments; PassThru = $true; ErrorAction = 'Stop' }
        if ($CcPlatformWin) { $splat['WindowStyle'] = 'Hidden' }
        $p = Start-Process @splat
        Write-CcDetachedFallbackLog $FilePath
        return [int]$p.Id
    } catch { return 0 }
}

# Worth a line in the log: a watcher that vanishes minutes after the session that
# started it is exactly this fallback, and nothing else records that it was used.
function Write-CcDetachedFallbackLog([string]$what) {
    try {
        New-Item -ItemType Directory -Force -Path $CcStore | Out-Null
        Add-Content -LiteralPath $CcRelaunchLog -Value ("{0:s} detached fallback: {1} started attached to this process (it dies with it)" -f (Get-Date), $what)
    } catch {}
}

# Where the wrapper looks for "start the child again" markers.
function Get-CcMarkerDir {
    if ($env:LOCALAPPDATA) { return (Join-Path $env:LOCALAPPDATA 'claude-cc-relaunch') }
    return (Join-Path ([System.IO.Path]::GetTempPath()) 'claude-cc-relaunch')
}

# A signature whose marker is gone describes nothing: the wrapper consumed the
# marker, or the process holding it died between the two deletes. Swept rather
# than left to pile up one file per refresh. Returns how many went.
function Clear-CcOrphanMarkerSigs([int]$OlderThanMinutes = 5) {
    $dir = Get-CcMarkerDir
    if (-not (Test-Path $dir)) { return 0 }
    $cutoff = (Get-Date).AddMinutes(-$OlderThanMinutes)
    $gone = 0
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter 'relaunch-*.sig' -ErrorAction SilentlyContinue)) {
        if ($f.LastWriteTime -ge $cutoff) { continue }
        $marker = $f.FullName.Substring(0, $f.FullName.Length - 4)
        if (Test-Path -LiteralPath $marker) { continue }
        Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $f.FullName)) { $gone++ }
    }
    return $gone
}
