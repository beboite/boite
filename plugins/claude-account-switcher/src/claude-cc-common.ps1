# Everything the commands share: where a provider keeps its files, how a saved
# login is sealed on disk, and how usage is read back.
#
# Dot-sourced by each command after that command has declared its own
# `[string]$Provider` parameter. PowerShell scoping is dynamic, so the caller's
# `$Provider` is the one read below; that is the whole provider selection
# mechanism, and it is why every command declares the parameter even when it
# does nothing else with it.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'cc-providers.ps1')

$CcRequested = 'claude'
if ((Test-Path -LiteralPath 'Variable:Provider') -and "$Provider") { $CcRequested = "$Provider" }

$CcProvider   = Get-CcProviderSpec $CcRequested
$CcProviderId = $CcProvider.Id
$CcIsCodex    = $CcProviderId -eq 'codex'
$CcName       = $CcProvider.Label
$CcCli        = $CcProvider.Cli
$CcStore      = $CcProvider.Store
$CcCredLabel  = $CcProvider.CredLabel

$CcCredFile = Get-CcNewestPath $CcProvider.CredCandidates
if (-not $CcCredFile) { $CcCredFile = $CcProvider.CredCandidates[0] }
$CcConfigFile = Get-CcNewestPath $CcProvider.ConfigCandidates
if (-not $CcConfigFile) { $CcConfigFile = $CcProvider.ConfigCandidates[0] }

function Say {
    param([string]$Text = '', [string]$Color)
    if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text }
}

# Saved logins are bearer tokens. Everything this toolkit writes is readable by
# its owner and by nobody else, on every platform.
function Protect-CcFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
        if ($IsWindows) {
            & icacls $Path /inheritance:r /grant:r "${env:USERNAME}:(F)" *> $null
        } else {
            & chmod 600 $Path *> $null
        }
    } catch { }
}

function Protect-CcDirectory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
        if ($IsWindows) {
            & icacls $Path /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" *> $null
        } else {
            & chmod 700 $Path *> $null
        }
    } catch { }
}

function New-CcRandomBytes {
    param([int]$Count)
    $bytes = [byte[]]::new($Count)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return $bytes
}

$CcSecretAccount = 'claude-cc-switcher'
$CcSecretPrefix  = 'ccx1:'

function Test-CcDpapi {
    if (-not $IsWindows) { return $false }
    try {
        Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue
        return $null -ne ([System.Security.Cryptography.ProtectedData] -as [type])
    } catch { return $false }
}

# Windows seals with DPAPI and needs no key of its own. Elsewhere the AES key
# lives in the OS secret store, so a copied pool directory is not a copied login.
function Get-CcSecretBackend {
    if (Test-CcDpapi) { return 'dpapi' }
    if ($IsMacOS -and (Get-Command security -ErrorAction Ignore)) { return 'keychain' }
    if (Get-Command secret-tool -ErrorAction Ignore) { return 'libsecret' }
    return 'none'
}

function Get-CcSecretKey {
    param([switch]$Create)
    switch (Get-CcSecretBackend) {
        'keychain' {
            $b64 = & security find-generic-password -s $CcSecretAccount -a $CcSecretAccount -w 2>$null
            if (-not $b64) {
                if (-not $Create) { return $null }
                $b64 = [Convert]::ToBase64String((New-CcRandomBytes 32))
                & security add-generic-password -U -s $CcSecretAccount -a $CcSecretAccount -w $b64 2>$null | Out-Null
            }
            return [Convert]::FromBase64String("$b64".Trim())
        }
        'libsecret' {
            $b64 = & secret-tool lookup service $CcSecretAccount account $CcSecretAccount 2>$null
            if (-not $b64) {
                if (-not $Create) { return $null }
                $b64 = [Convert]::ToBase64String((New-CcRandomBytes 32))
                $b64 | & secret-tool store --label=claude-cc-switcher service $CcSecretAccount account $CcSecretAccount 2>$null
            }
            return [Convert]::FromBase64String("$b64".Trim())
        }
        default { return $null }
    }
}

function New-CcAesGcm {
    param([byte[]]$Key)
    # The one-argument constructor is gone from newer runtimes and the
    # two-argument one is absent from older ones.
    try { return [System.Security.Cryptography.AesGcm]::new($Key, 16) }
    catch { return [System.Security.Cryptography.AesGcm]::new($Key) }
}

# `ccx1:` then base64. On Windows that is a DPAPI blob; elsewhere it is
# nonce(12) | tag(16) | ciphertext.
function Protect-CcText {
    param([string]$Text)
    if (-not $Text) { return $null }
    $plain = [Text.Encoding]::UTF8.GetBytes($Text)
    if (Test-CcDpapi) {
        $blob = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, 'CurrentUser')
        return $CcSecretPrefix + [Convert]::ToBase64String($blob)
    }
    $key = Get-CcSecretKey -Create
    if (-not $key) { return $null }
    $nonce  = New-CcRandomBytes 12
    $tag    = [byte[]]::new(16)
    $cipher = [byte[]]::new($plain.Length)
    $gcm = New-CcAesGcm $key
    try { $gcm.Encrypt($nonce, $plain, $cipher, $tag) } finally { $gcm.Dispose() }
    $out = [byte[]]::new($nonce.Length + $tag.Length + $cipher.Length)
    [Array]::Copy($nonce, 0, $out, 0, 12)
    [Array]::Copy($tag, 0, $out, 12, 16)
    [Array]::Copy($cipher, 0, $out, 28, $cipher.Length)
    return $CcSecretPrefix + [Convert]::ToBase64String($out)
}

function Unprotect-CcText {
    param([string]$Sealed)
    if (-not $Sealed) { return $null }
    if (-not $Sealed.StartsWith($CcSecretPrefix)) {
        # Snapshots written before the prefix existed are bare base64 DPAPI.
        if (-not (Test-CcDpapi) -or $Sealed -notmatch '^[A-Za-z0-9+/=]+$') { return $Sealed }
        try {
            $legacy = [System.Security.Cryptography.ProtectedData]::Unprotect(
                [Convert]::FromBase64String($Sealed), $null, 'CurrentUser')
            return [Text.Encoding]::UTF8.GetString($legacy)
        } catch { return $Sealed }
    }
    $blob = [Convert]::FromBase64String($Sealed.Substring($CcSecretPrefix.Length))
    if (Test-CcDpapi) {
        try {
            $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
            return [Text.Encoding]::UTF8.GetString($plain)
        } catch { return $null }
    }
    $key = Get-CcSecretKey
    if (-not $key -or $blob.Length -le 28) { return $null }
    $nonce  = $blob[0..11]
    $tag    = $blob[12..27]
    $cipher = $blob[28..($blob.Length - 1)]
    $plain  = [byte[]]::new($cipher.Length)
    $gcm = New-CcAesGcm $key
    try { $gcm.Decrypt($nonce, $cipher, $tag, $plain) }
    catch { return $null }
    finally { $gcm.Dispose() }
    return [Text.Encoding]::UTF8.GetString($plain)
}

function Write-CcJsonFile {
    param([string]$Path, $Value)
    $json = $Value | ConvertTo-Json -Depth 20
    $tmp  = "$Path.tmp"
    [IO.File]::WriteAllText($tmp, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmp -Destination $Path -Force
    Protect-CcFile $Path
}

function Read-CcJsonFile {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}

function Test-CcHasProperty {
    param($Object, [string]$Name)
    return ($null -ne $Object) -and ($null -ne $Object.PSObject.Properties[$Name])
}

function ConvertFrom-CcJwtPayload {
    param([string]$Token)
    if (-not $Token) { return $null }
    $parts = $Token.Split('.')
    if ($parts.Count -lt 2) { return $null }
    $b64 = $parts[1].Replace('-', '+').Replace('_', '/')
    switch ($b64.Length % 4) { 2 { $b64 += '==' } 3 { $b64 += '=' } }
    try { return ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json) }
    catch { return $null }
}

# --- what the CLI has live on this machine -----------------------------------

function Get-CcLiveCredsRaw {
    if ($CcProvider.UsesKeychain -and -not (Test-Path -LiteralPath $CcCredFile)) {
        $raw = & security find-generic-password -s $CcProvider.KeychainService -w 2>$null
        if ($raw) { return "$raw".Trim() }
        return $null
    }
    if (-not (Test-Path -LiteralPath $CcCredFile)) { return $null }
    return (Get-Content -LiteralPath $CcCredFile -Raw).Trim()
}

function Set-CcLiveCredsRaw {
    param([string]$Raw)
    $dir = Split-Path -Parent $CcCredFile
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($CcCredFile, $Raw, [Text.UTF8Encoding]::new($false))
    Protect-CcFile $CcCredFile
    if ($CcProvider.UsesKeychain) {
        & security add-generic-password -U -s $CcProvider.KeychainService -a $env:USER -w $Raw 2>$null | Out-Null
    }
}

function Get-CodexIdentity {
    param($Creds)
    if (-not (Test-CcHasProperty $Creds 'tokens') -or -not $Creds.tokens) { return $null }
    $tokens = $Creds.tokens
    $email  = $null
    $uuid   = $null
    if (Test-CcHasProperty $tokens 'account_id') { $uuid = $tokens.account_id }
    $claims = $null
    if (Test-CcHasProperty $tokens 'id_token') { $claims = ConvertFrom-CcJwtPayload $tokens.id_token }
    if ($claims) {
        if (Test-CcHasProperty $claims 'email') { $email = $claims.email }
        $auth = $claims.PSObject.Properties['https://api.openai.com/auth']
        if (-not $uuid -and $auth -and (Test-CcHasProperty $auth.Value 'chatgpt_account_id')) {
            $uuid = $auth.Value.chatgpt_account_id
        }
    }
    if (-not $email -and -not $uuid) { return $null }
    return [pscustomobject]@{ emailAddress = $email; accountUuid = $uuid }
}

# The account that owns the live credentials: an email and a stable id.
function Get-CcLiveIdentity {
    if ($CcIsCodex) {
        $raw = Get-CcLiveCredsRaw
        if (-not $raw) { return $null }
        try { return Get-CodexIdentity ($raw | ConvertFrom-Json) } catch { return $null }
    }
    $cfg = Read-CcJsonFile $CcConfigFile
    if (Test-CcHasProperty $cfg 'oauthAccount') { return $cfg.oauthAccount }
    return $null
}

# Claude keeps the email in `~/.claude.json`, a file that also holds the whole
# conversation history. It is edited in place — the `oauthAccount` object is
# located and exactly those bytes are replaced — rather than parsed and
# rewritten: a round trip through ConvertTo-Json on a file that size is slow and
# drops things nobody here owns.
function Set-CcLiveIdentity {
    param($Identity)
    if ($CcIsCodex -or -not $Identity) { return }
    if (-not (Test-Path -LiteralPath $CcConfigFile)) {
        Write-CcJsonFile $CcConfigFile ([pscustomobject]@{ oauthAccount = $Identity })
        return
    }
    $text  = [IO.File]::ReadAllText($CcConfigFile)
    $block = ($Identity | ConvertTo-Json -Depth 10 -Compress)
    $match = [regex]::Match($text, '"oauthAccount"\s*:\s*\{')
    if (-not $match.Success) {
        $head = [regex]::Match($text, '^\s*\{')
        if (-not $head.Success) { return }
        # No comma after the only member of an otherwise empty object.
        $comma = if ($text.Substring($head.Length) -match '^\s*\}') { '' } else { ',' }
        $text = $text.Insert($head.Length, '"oauthAccount":' + $block + $comma)
    } else {
        $start = $match.Index + $match.Length - 1
        $depth = 0
        $end   = -1
        for ($i = $start; $i -lt $text.Length; $i++) {
            $ch = $text[$i]
            if ($ch -eq '"') {
                # Skip the string, so a brace inside one does not count.
                $i++
                while ($i -lt $text.Length -and $text[$i] -ne '"') {
                    if ($text[$i] -eq '\') { $i++ }
                    $i++
                }
                continue
            }
            if ($ch -eq '{') { $depth++ }
            elseif ($ch -eq '}') {
                $depth--
                if ($depth -eq 0) { $end = $i; break }
            }
        }
        if ($end -lt 0) { return }
        $text = $text.Remove($start, $end - $start + 1).Insert($start, $block)
    }
    $tmp = "$CcConfigFile.tmp"
    [IO.File]::WriteAllText($tmp, $text, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmp -Destination $CcConfigFile -Force
}

$CcBackupDir = Join-Path $CcStore '.backups'

# The credentials that are about to be replaced, kept for the three most recent
# switches. Sealed the same way a snapshot is, so a pool that is encrypted does
# not keep plain-text copies of the same tokens beside it.
function Backup-CcLiveCreds {
    $raw = Get-CcLiveCredsRaw
    if (-not $raw) { return }
    if (-not (Test-Path -LiteralPath $CcBackupDir)) { New-Item -ItemType Directory -Path $CcBackupDir -Force | Out-Null }
    Protect-CcDirectory $CcBackupDir
    $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
    $sealed = Protect-CcText $raw
    if ($sealed) {
        $file = Join-Path $CcBackupDir "creds-$stamp.ccx"
        [IO.File]::WriteAllText($file, $sealed, [Text.UTF8Encoding]::new($false))
    } else {
        $file = Join-Path $CcBackupDir "creds-$stamp.json"
        [IO.File]::WriteAllText($file, $raw, [Text.UTF8Encoding]::new($false))
    }
    Protect-CcFile $file
    Get-CcBackupFiles | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction Ignore
}

# Newest first. `backup-*` is what earlier versions wrote, and those are still
# worth rolling back to.
function Get-CcBackupFiles {
    if (-not (Test-Path -LiteralPath $CcBackupDir)) { return @() }
    return @(Get-ChildItem -LiteralPath $CcBackupDir -File -ErrorAction Ignore |
        Where-Object { $_.Name -like 'creds-*' -or $_.Name -like 'backup-*' } |
        Sort-Object LastWriteTime -Descending)
}

# The newest backup, as the raw credentials text, or null when there is none.
function Get-CcNewestBackup {
    $file = Get-CcBackupFiles | Select-Object -First 1
    if (-not $file) { return $null }
    $text = (Get-Content -LiteralPath $file.FullName -Raw).Trim()
    # Sealed or not is decided by what is in the file, so a backup written by an
    # earlier version reads back the same way.
    if (-not $text.StartsWith('{')) { $text = Unprotect-CcText $text }
    if (-not $text -or -not $text.StartsWith('{')) { return $null }
    return [pscustomobject]@{ Raw = $text; File = $file.FullName; At = $file.LastWriteTime }
}

# Work that must not interleave with the same work in another process.
function Invoke-CcLocked {
    param([string]$Name, [scriptblock]$Body)
    $mutex = [System.Threading.Mutex]::new($false, $Name)
    $held  = $false
    try {
        try { $held = $mutex.WaitOne(15000) }
        catch [System.Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'Another account switch is in progress. Try again in a moment.' }
        return & $Body
    } finally {
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

# A credential swap is several writes that must not interleave with another one.
function Invoke-CcCredSwapLocked {
    param([scriptblock]$Body)
    return Invoke-CcLocked -Name 'Global\ClaudeCcCredentialSwap' -Body $Body
}

# --- the pool ----------------------------------------------------------------

function New-CcSnapshotEntry {
    param([string]$Email, [string]$CredsRaw, $Identity, $UsageCache, $SavedAt)
    # Rewriting a snapshot — re-sealing it, or saving fresh tokens for an account
    # already in the pool — does not make it a new saved login, so the caller's
    # date is carried through. ConvertFrom-Json hands back a DateTime rather than
    # the text that was read, and only 'o' writes that back as it came in.
    $saved = if ($SavedAt -is [datetime]) { $SavedAt.ToString('o') }
             elseif ("$SavedAt") { "$SavedAt" }
             else { (Get-Date -Format o) }
    $entry = [ordered]@{
        email   = $Email
        savedAt = $saved
    }
    $sealed = Protect-CcText $CredsRaw
    if ($sealed) { $entry['credentialsProtected'] = $sealed }
    else { $entry['credentials'] = ($CredsRaw | ConvertFrom-Json) }
    if ($Identity)   { $entry['oauthAccountRaw'] = $Identity }
    if ($UsageCache) { $entry['usageCache'] = $UsageCache }
    return [pscustomobject]$entry
}

function Get-CcSnapshotCreds {
    param($Snapshot)
    if (Test-CcHasProperty $Snapshot 'credentialsProtected') {
        return Unprotect-CcText $Snapshot.credentialsProtected
    }
    if (Test-CcHasProperty $Snapshot 'credentials') {
        return ($Snapshot.credentials | ConvertTo-Json -Depth 20 -Compress)
    }
    return $null
}

# Older snapshots kept the identity as the raw JSON text rather than as an
# object, which is what the `Raw` in the field name was about.
function ConvertTo-CcIdentity {
    param($Value)
    if (-not $Value) { return $null }
    if ($Value -is [string]) {
        try { return ($Value | ConvertFrom-Json) } catch { return $null }
    }
    return $Value
}

function Get-CcSnapshotFiles {
    if (-not (Test-Path -LiteralPath $CcStore)) { return @() }
    return @(Get-ChildItem -LiteralPath $CcStore -Filter '*.json' -File |
        Where-Object { -not $_.Name.StartsWith('.') } |
        Sort-Object Name)
}

function Get-CcSnapshotPath {
    param([string]$Email)
    $safe = ($Email -replace '[^A-Za-z0-9._@-]', '_')
    return Join-Path $CcStore "$safe.json"
}

. (Join-Path $PSScriptRoot 'cc-pool.ps1')

# One object per saved login, with everything a command needs to show it or
# switch to it.
function Get-CcPool {
    $key = Get-CcPoolKey
    foreach ($file in Get-CcSnapshotFiles) {
        $snap = Read-CcJsonFile $file.FullName
        if (-not $snap) { continue }
        [pscustomobject]@{
            Email     = $snap.email
            File      = $file.FullName
            Name      = $file.BaseName
            Snapshot  = $snap
            Creds     = (Get-CcSnapshotCreds $snap)
            Identity  = (ConvertTo-CcIdentity $(if (Test-CcHasProperty $snap 'oauthAccountRaw') { $snap.oauthAccountRaw } else { $null }))
            Cache     = $(if (Test-CcHasProperty $snap 'usageCache') { $snap.usageCache } else { $null })
            Protected = (Test-CcHasProperty $snap 'credentialsProtected')
            Trust     = (Test-CcPoolEntry -Key $key -FileName $file.Name -Snapshot $snap)
        }
    }
}

function Find-CcCurrent {
    param($Pool)
    $live = Get-CcLiveIdentity
    if (-not $live) { return $null }
    $email = "$($live.emailAddress)".ToLowerInvariant()
    if (-not $email) { return $null }
    return ($Pool | Where-Object { "$($_.Email)".ToLowerInvariant() -eq $email } | Select-Object -First 1)
}

function Get-CcAccessToken {
    param([string]$CredsRaw)
    if (-not $CredsRaw) { return $null }
    try { $creds = $CredsRaw | ConvertFrom-Json } catch { return $null }
    if ($CcIsCodex) {
        if ((Test-CcHasProperty $creds 'tokens') -and $creds.tokens) { return $creds.tokens.access_token }
        if (Test-CcHasProperty $creds 'OPENAI_API_KEY') { return $creds.OPENAI_API_KEY }
        return $null
    }
    if ((Test-CcHasProperty $creds 'claudeAiOauth') -and $creds.claudeAiOauth) {
        return $creds.claudeAiOauth.accessToken
    }
    return $null
}

# --- usage -------------------------------------------------------------------

$CcThreshold         = 99
$CcWeeklyThreshold   = 99.8
$CcUsageCacheSeconds = 60
$script:CcHttp       = $null

function Get-CcHttpClient {
    if (-not $script:CcHttp) {
        $script:CcHttp = [System.Net.Http.HttpClient]::new()
        $script:CcHttp.Timeout = [TimeSpan]::FromSeconds(8)
    }
    return $script:CcHttp
}

function Invoke-CcJsonGet {
    param([string]$Url, [hashtable]$Headers)
    try {
        $request = [System.Net.Http.HttpRequestMessage]::new('GET', $Url)
        foreach ($name in $Headers.Keys) {
            $request.Headers.TryAddWithoutValidation($name, $Headers[$name]) | Out-Null
        }
        $response = (Get-CcHttpClient).SendAsync($request).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { return $null }
        return ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json)
    } catch { return $null }
}

function ConvertTo-CcUsageWindow {
    param($Window)
    if (-not $Window) { return $null }
    $pct = 0.0
    if (Test-CcHasProperty $Window 'used_percent') { $pct = [double]$Window.used_percent }
    elseif (Test-CcHasProperty $Window 'utilization') { $pct = [double]$Window.utilization }
    $resets = $null
    if ((Test-CcHasProperty $Window 'resets_at') -and $Window.resets_at) {
        $resets = $Window.resets_at
    } elseif ((Test-CcHasProperty $Window 'resets_in_seconds') -and $Window.resets_in_seconds) {
        $resets = (Get-Date).ToUniversalTime().AddSeconds([double]$Window.resets_in_seconds).ToString('o')
    }
    return [pscustomobject]@{ utilization = [math]::Round($pct, 1); resets_at = $resets }
}

function Get-CcUsage {
    param([string]$AccessToken)
    if (-not $AccessToken) { return $null }
    if ($CcIsCodex) {
        # An `sk-` key is not a ChatGPT session, and the usage endpoint has
        # nothing to say about one.
        if ($AccessToken.StartsWith('sk-')) { return $null }
        $raw = Invoke-CcJsonGet 'https://chatgpt.com/backend-api/codex/usage' @{
            Authorization = "Bearer $AccessToken"
        }
        if (-not (Test-CcHasProperty $raw 'rate_limits')) { return $null }
        return [pscustomobject]@{
            five_hour = (ConvertTo-CcUsageWindow $raw.rate_limits.primary)
            seven_day = (ConvertTo-CcUsageWindow $raw.rate_limits.secondary)
        }
    }
    $raw = Invoke-CcJsonGet 'https://api.anthropic.com/api/oauth/usage' @{
        Authorization       = "Bearer $AccessToken"
        'anthropic-version' = '2023-06-01'
        'anthropic-beta'    = 'oauth-2025-04-20'
    }
    if (-not $raw) { return $null }
    return [pscustomobject]@{
        five_hour = (ConvertTo-CcUsageWindow $raw.five_hour)
        seven_day = (ConvertTo-CcUsageWindow $raw.seven_day)
    }
}

function Get-CcWindowPct {
    param($Usage, [string]$Window)
    if (-not (Test-CcHasProperty $Usage $Window)) { return $null }
    $value = $Usage.$Window
    if (-not $value) { return $null }
    return [double]$value.utilization
}

function Test-CcUsable {
    param($Usage)
    if (-not $Usage) { return $true }
    $five  = Get-CcWindowPct $Usage 'five_hour'
    $seven = Get-CcWindowPct $Usage 'seven_day'
    if ($null -ne $five -and $five -ge $CcThreshold) { return $false }
    if ($null -ne $seven -and $seven -ge $CcWeeklyThreshold) { return $false }
    return $true
}

# When the account comes back, or null when nothing says.
function Get-CcReadyAt {
    param($Usage)
    $at = $null
    $caps = @(@('five_hour', $CcThreshold), @('seven_day', $CcWeeklyThreshold))
    foreach ($pair in $caps) {
        $window = $pair[0]
        $cap    = $pair[1]
        $pct    = Get-CcWindowPct $Usage $window
        if ($null -eq $pct -or $pct -lt $cap) { continue }
        $resets = $Usage.$window.resets_at
        if (-not $resets) { return $null }
        try { $when = [datetime]::Parse($resets).ToUniversalTime() } catch { return $null }
        if (-not $at -or $when -gt $at) { $at = $when }
    }
    return $at
}

function Format-CcWait {
    param([datetime]$At)
    $span = $At - (Get-Date).ToUniversalTime()
    if ($span.TotalSeconds -le 0) { return 'now' }
    if ($span.TotalHours -lt 1) { return ('{0}m' -f [int][math]::Ceiling($span.TotalMinutes)) }
    if ($span.TotalDays -lt 1) { return ('{0}h{1:d2}m' -f [int]$span.TotalHours, $span.Minutes) }
    return ('{0}d{1:d2}h' -f [int]$span.TotalDays, $span.Hours)
}

# A hair under the cap still has to read as under the cap, so 99.8 stays 99.8.
function Format-CcPct {
    param($Value)
    if ($null -eq $Value) { return '   ?' }
    $text = if ($Value -gt 99 -and $Value -lt 100) { '{0:0.0}%' -f $Value } else { '{0:0}%' -f $Value }
    return $text.PadLeft(4)
}

function Format-CcUsagePair {
    param($Usage)
    $five  = Get-CcWindowPct $Usage 'five_hour'
    $seven = Get-CcWindowPct $Usage 'seven_day'
    if ($null -eq $five -and $null -eq $seven) { return 'usage n/a' }
    return ('5h {0} / 7d {1} used' -f (Format-CcPct $five), (Format-CcPct $seven))
}

function ConvertFrom-CcUsageCache {
    param($Cache)
    if (-not $Cache) { return $null }
    return [pscustomobject]@{
        five_hour = $(if (Test-CcHasProperty $Cache 'five_hour') { $Cache.five_hour } else { $null })
        seven_day = $(if (Test-CcHasProperty $Cache 'seven_day') { $Cache.seven_day } else { $null })
    }
}

function Test-CcUsageCacheFresh {
    param($Cache)
    if (-not (Test-CcHasProperty $Cache 'checkedAt')) { return $false }
    try { $at = [datetime]::Parse($Cache.checkedAt).ToUniversalTime() } catch { return $false }
    return ((Get-Date).ToUniversalTime() - $at).TotalSeconds -lt $CcUsageCacheSeconds
}

# Written back into the snapshot, so the statusline and the next `auto` can read
# a number without asking the API again.
function Save-CcUsageCache {
    param([string]$File, $Usage)
    # Read, change, write: under a lock, or two commands refreshing at once lose
    # one of the two answers.
    Invoke-CcLocked -Name 'Global\ClaudeCcUsageCache' -Body {
        $snap = Read-CcJsonFile $File
        if (-not $snap) { return }
        $cache = [ordered]@{ checkedAt = (Get-Date).ToUniversalTime().ToString('o') }
        foreach ($name in @('five_hour', 'seven_day')) {
            $window = if ($Usage) { $Usage.$name } else { $null }
            if ($window) {
                $cache[$name] = [ordered]@{ utilization = $window.utilization; resets_at = $window.resets_at }
            }
        }
        $snap | Add-Member -NotePropertyName usageCache -NotePropertyValue ([pscustomobject]$cache) -Force
        Write-CcJsonFile $File $snap
    }
}

# The usage for one pool entry, from cache while the cache is fresh enough.
function Get-CcPoolUsage {
    param($Entry, [switch]$Force)
    if (-not $Force -and (Test-CcUsageCacheFresh $Entry.Cache)) {
        return ConvertFrom-CcUsageCache $Entry.Cache
    }
    $usage = Get-CcUsage (Get-CcAccessToken $Entry.Creds)
    if ($usage) {
        Save-CcUsageCache $Entry.File $usage
        return $usage
    }
    return ConvertFrom-CcUsageCache $Entry.Cache
}

# --- switching ---------------------------------------------------------------

# Puts a saved login back in front of the CLI: the tokens, and for Claude the
# email the CLI shows, which lives in a different file from the tokens.
function Set-CcActiveAccount {
    param($Entry)
    if (-not $Entry.Creds) { throw "The credentials for $($Entry.Email) could not be read back." }
    Invoke-CcCredSwapLocked {
        Backup-CcLiveCreds
        Set-CcLiveCredsRaw $Entry.Creds
        if ($Entry.Identity) { Set-CcLiveIdentity $Entry.Identity }
    }
}
