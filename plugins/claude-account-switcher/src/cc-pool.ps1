# Whether a saved login is one this machine put in the pool.
#
# A snapshot is a file in a directory, so anything that can write there can add
# one, and switching to it would hand the CLI credentials nobody here chose.
# Each entry is therefore stamped with an HMAC over what it claims to be, under
# a key only this user can read. A stamp that does not match is not refused
# outright — it is reported, and the commands say so before they act on it.
#
# Dot-sourced from `claude-cc-common.ps1`, after the helpers it uses are defined.

$CcPoolKeyFile  = Join-Path $CcStore '.pool.key'
$CcPoolManifest = Join-Path $CcStore '.pool.json'
$CcPoolVersion  = 2

function Get-CcPoolKey {
    param([switch]$Create)
    if (Test-Path -LiteralPath $CcPoolKeyFile) {
        try {
            $wrapped = [IO.File]::ReadAllBytes($CcPoolKeyFile)
            if (Test-CcDpapi) {
                return [System.Security.Cryptography.ProtectedData]::Unprotect($wrapped, $null, 'CurrentUser')
            }
            $sealed = [Text.Encoding]::UTF8.GetString($wrapped)
            $plain  = Unprotect-CcText $sealed
            if (-not $plain) { return $null }
            return [Convert]::FromBase64String($plain)
        } catch { return $null }
    }
    if (-not $Create) { return $null }
    if (-not (Test-Path -LiteralPath $CcStore)) { New-Item -ItemType Directory -Path $CcStore -Force | Out-Null }
    Protect-CcDirectory $CcStore
    $key = New-CcRandomBytes 32
    if (Test-CcDpapi) {
        $wrapped = [System.Security.Cryptography.ProtectedData]::Protect($key, $null, 'CurrentUser')
        [IO.File]::WriteAllBytes($CcPoolKeyFile, $wrapped)
    } else {
        $sealed = Protect-CcText ([Convert]::ToBase64String($key))
        if (-not $sealed) { return $null }
        [IO.File]::WriteAllText($CcPoolKeyFile, $sealed, [Text.UTF8Encoding]::new($false))
    }
    Protect-CcFile $CcPoolKeyFile
    return $key
}

function Get-CcPoolIdentity {
    param($Snapshot)
    $uuid  = $null
    $email = $null
    # `oauthAccountRaw` is the name snapshots have always used for this.
    if (Test-CcHasProperty $Snapshot 'oauthAccountRaw') {
        $account = ConvertTo-CcIdentity $Snapshot.oauthAccountRaw
        if (Test-CcHasProperty $account 'accountUuid')  { $uuid  = $account.accountUuid }
        if (Test-CcHasProperty $account 'emailAddress') { $email = $account.emailAddress }
    }
    if (-not $email -and (Test-CcHasProperty $Snapshot 'email')) { $email = $Snapshot.email }
    return @{ Uuid = $uuid; Email = $email }
}

function Get-CcSha256Hex {
    param([string]$Text)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $hash  = [System.Security.Cryptography.SHA256]::HashData($bytes)
    return -join ($hash | ForEach-Object { $_.ToString('x2') })
}

# The tokens themselves, hashed. It is what makes the stamp cover the thing that
# would actually be handed to the CLI, rather than only the name on it.
function Get-CcPoolCredHash {
    param([string]$CredsRaw)
    if (-not $CredsRaw) { return 'none' }
    try { $creds = $CredsRaw | ConvertFrom-Json } catch { return 'none' }
    if ((Test-CcHasProperty $creds 'claudeAiOauth') -and $creds.claudeAiOauth) {
        $oauth = $creds.claudeAiOauth
        return Get-CcSha256Hex ('{0}|{1}|{2}' -f $oauth.accessToken, $oauth.refreshToken, $oauth.expiresAt)
    }
    if ((Test-CcHasProperty $creds 'tokens') -and $creds.tokens) {
        $tokens = $creds.tokens
        return Get-CcSha256Hex ('{0}|{1}|{2}' -f $tokens.access_token, $tokens.refresh_token, $tokens.account_id)
    }
    if (Test-CcHasProperty $creds 'OPENAI_API_KEY') {
        return Get-CcSha256Hex "$($creds.OPENAI_API_KEY)"
    }
    return 'none'
}

function Get-CcPoolStamp {
    param([byte[]]$Key, [string]$FileName, [string]$Email, [string]$Uuid, [string]$CredHash)
    $payload = if ($CredHash) {
        '{0}|{1}|{2}|{3}' -f $FileName, $Email, $Uuid, $CredHash
    } else {
        '{0}|{1}|{2}' -f $FileName, $Email, $Uuid
    }
    $hmac = [System.Security.Cryptography.HMACSHA256]::new($Key)
    try { $bytes = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($payload)) } finally { $hmac.Dispose() }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Read-CcPoolManifest {
    $manifest = Read-CcJsonFile $CcPoolManifest
    if (-not $manifest) { return $null }
    return $manifest
}

function Write-CcPoolManifest {
    param($Manifest)
    Write-CcJsonFile $CcPoolManifest $Manifest
}

function Register-CcPoolEntry {
    param([string]$FileName, $Snapshot)
    $key = Get-CcPoolKey -Create
    if (-not $key) { return $false }
    $identity = Get-CcPoolIdentity $Snapshot
    if (-not $identity.Uuid) { return $false }
    $credHash = Get-CcPoolCredHash (Get-CcSnapshotCreds $Snapshot)
    $stamp = Get-CcPoolStamp -Key $key -FileName $FileName -Email $identity.Email -Uuid $identity.Uuid -CredHash $credHash

    $manifest = Read-CcPoolManifest
    if (-not $manifest) { $manifest = [pscustomobject]@{ version = $CcPoolVersion; accounts = [pscustomobject]@{} } }
    $manifest.version = $CcPoolVersion
    $entry = [pscustomobject]@{
        email       = $identity.Email
        accountUuid = $identity.Uuid
        credHash    = $credHash
        stamp       = $stamp
        registered  = (Get-Date -Format o)
    }
    $manifest.accounts | Add-Member -NotePropertyName $FileName -NotePropertyValue $entry -Force
    Write-CcPoolManifest $manifest
    return $true
}

function Unregister-CcPoolEntry {
    param([string]$FileName)
    $manifest = Read-CcPoolManifest
    if (-not (Test-CcHasProperty $manifest 'accounts')) { return }
    if (-not (Test-CcHasProperty $manifest.accounts $FileName)) { return }
    $manifest.accounts.PSObject.Properties.Remove($FileName)
    Write-CcPoolManifest $manifest
}

# trusted: this machine registered it and nothing about it has changed since.
# changed: it is registered, but the name or the tokens are not the ones stamped.
# unknown: nothing ever registered it.
# nokey:   the key is unreadable, so nothing here can be judged either way.
function Test-CcPoolEntry {
    param([byte[]]$Key, [string]$FileName, $Snapshot)
    if (-not $Key) { return 'nokey' }
    $manifest = Read-CcPoolManifest
    if (-not (Test-CcHasProperty $manifest 'accounts')) { return 'unknown' }
    if (-not (Test-CcHasProperty $manifest.accounts $FileName)) { return 'unknown' }
    $entry    = $manifest.accounts.$FileName
    $identity = Get-CcPoolIdentity $Snapshot
    $credHash = Get-CcPoolCredHash (Get-CcSnapshotCreds $Snapshot)

    $expected = Get-CcPoolStamp -Key $Key -FileName $FileName -Email $entry.email -Uuid $entry.accountUuid -CredHash $credHash
    if ($entry.stamp -eq $expected -and "$($identity.Uuid)" -eq "$($entry.accountUuid)") { return 'trusted' }

    # Entries written before the tokens were part of the stamp, and entries whose
    # tokens were refreshed by the CLI rather than by anything here, are upgraded
    # in place rather than reported as tampering.
    foreach ($legacy in @($null, 'none')) {
        $old = Get-CcPoolStamp -Key $Key -FileName $FileName -Email $entry.email -Uuid $entry.accountUuid -CredHash $legacy
        if ($entry.stamp -ne $old) { continue }
        if ("$($identity.Uuid)" -ne "$($entry.accountUuid)") { continue }
        Register-CcPoolEntry -FileName $FileName -Snapshot $Snapshot | Out-Null
        return 'trusted'
    }
    return 'changed'
}

function Format-CcPoolVerdict {
    param([string]$Verdict)
    switch ($Verdict) {
        'trusted' { return @{ Text = 'trusted'; Color = 'DarkGray' } }
        'changed' { return @{ Text = 'CHANGED'; Color = 'Red' } }
        'nokey'   { return @{ Text = 'unverified'; Color = 'Yellow' } }
        default   { return @{ Text = 'unknown'; Color = 'Yellow' } }
    }
}
