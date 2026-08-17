# Switch the Claude desktop account by swapping its Electron web session.
# The Claude desktop app keeps its login in the browser session (cookies +
# Local Storage + IndexedDB), so switching means closing the app, swapping
# those session folders for a saved account's, and restarting.
#
# IMPORTANT: run from a STANDALONE PowerShell window - THIS CLOSES the Claude
# app (and any session running inside it).

$store          = Join-Path $env:USERPROFILE '.claude-accounts'
$RawBase        = 'https://raw.githubusercontent.com/karthiknl0/claude-account-switcher/main'

# -- Update check (best-effort, cached once per day) ---------------------------
function Test-ForUpdate {
    try {
        $checkFile = Join-Path $env:USERPROFILE '.claude-tools\.update-check'
        if (Test-Path $checkFile) {
            if (((Get-Date) - (Get-Item $checkFile).LastWriteTime) -lt [TimeSpan]::FromDays(1)) { return }
        }
        New-Item -ItemType File -Force -Path $checkFile | Out-Null
        (Get-Date -Format o) | Set-Content -Path $checkFile -ErrorAction SilentlyContinue
        $remote  = (Invoke-RestMethod -Uri "$RawBase/VERSION" -TimeoutSec 4).ToString().Trim()
        $verFile = Join-Path $env:USERPROFILE '.claude-tools\.version'
        $local   = if (Test-Path $verFile) { (Get-Content $verFile -Raw).Trim() } else { '0.0.0' }
        if ([version]$remote -gt [version]$local) {
            Write-Host ""
            Write-Host "  * Update available: v$local -> v$remote   (run 'claude-switch-update')" -ForegroundColor Yellow
        }
    } catch {}
}

# -- Resolve the live session root (handles MSIX/Store + plain installs) --------
function Get-SessionRoot {
    $roots = @( Join-Path $env:APPDATA 'Claude' )
    $pkgRoot = Join-Path $env:LOCALAPPDATA 'Packages'
    if (Test-Path $pkgRoot) {
        Get-ChildItem $pkgRoot -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue | ForEach-Object {
            $roots += (Join-Path $_.FullName 'LocalCache\Roaming\Claude')
        }
    }
    $roots = $roots | Where-Object { Test-Path $_ } | Select-Object -Unique
    $live = $null; $newest = $null; $newestTime = [datetime]::MinValue
    foreach ($r in $roots) {
        $ck = Join-Path $r 'Network\Cookies'
        if (Test-Path $ck) {
            try { $fs = [IO.File]::Open($ck,'Open','Read','None'); $fs.Close() } catch { $live = $r }
            $t = (Get-Item $ck).LastWriteTime
            if ($t -gt $newestTime) { $newestTime = $t; $newest = $r }
        }
    }
    if ($live)   { return $live }
    if ($newest) { return $newest }
    return ($roots | Select-Object -First 1)
}

function Stop-Claude($root) {
    Get-Process -Name 'Claude' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like '*WindowsApps\Claude_*' -or $_.Path -like '*\Claude\Claude.exe' } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    $ck = Join-Path $root 'Network\Cookies'
    for ($i = 0; $i -lt 30; $i++) {
        if (-not (Test-Path $ck)) { return $true }
        try { $fs = [IO.File]::Open($ck,'Open','Read','None'); $fs.Close(); return $true } catch { Start-Sleep -Milliseconds 500 }
    }
    return $false
}

function Start-Claude {
    $a = Get-StartApps | Where-Object { $_.Name -match 'claude' } | Select-Object -First 1
    if ($a) { Start-Process "shell:AppsFolder\$($a.AppID)" ; return $true }
    return $false
}

function Copy-ClaudeProfile($source, $destination) {
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    robocopy $source $destination /MIR /COPY:DAT /DCOPY:DAT /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -gt 7) { return $false }

    Get-ChildItem $destination -Force -Filter 'Singleton*' -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
    return $true
}

# -- Usage display -------------------------------------------------------------
# AES-256-GCM decrypt of the app's tokenCache via bcrypt.dll (Windows' native
# CNG crypto library) through a direct P/Invoke - no external process, no temp
# script files, no Node dependency. PowerShell 5.1's .NET Framework has no
# built-in AesGcm class (that only ships in .NET 5+), so this is the only
# in-process option that works on both 5.1 (the Desktop shortcut's shell) and
# pwsh 7. Deliberately not shelling out to node/cmd here: reading a browser-
# style credential store, decrypting it, and spawning a child process to do so
# is the exact behavioral pattern security software flags as credential
# theft - this keeps everything in-process and inspectable.
$BCryptSrc = @'
using System;
using System.Runtime.InteropServices;

public static class BCryptAesGcm
{
    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
    static extern uint BCryptOpenAlgorithmProvider(out IntPtr phAlgorithm, string pszAlgId, string pszImplementation, uint dwFlags);
    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
    static extern uint BCryptSetProperty(IntPtr hObject, string pszProperty, string pbInput, int cbInput, uint dwFlags);
    [DllImport("bcrypt.dll")]
    static extern uint BCryptGenerateSymmetricKey(IntPtr hAlgorithm, out IntPtr phKey, IntPtr pbKeyObject, uint cbKeyObject, byte[] pbSecret, uint cbSecret, uint dwFlags);
    [DllImport("bcrypt.dll")]
    static extern uint BCryptDestroyKey(IntPtr hKey);
    [DllImport("bcrypt.dll")]
    static extern uint BCryptCloseAlgorithmProvider(IntPtr hAlgorithm, uint dwFlags);

    [StructLayout(LayoutKind.Sequential)]
    struct BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO
    {
        public uint cbSize; public uint dwInfoVersion;
        public IntPtr pbNonce; public uint cbNonce;
        public IntPtr pbAuthData; public uint cbAuthData;
        public IntPtr pbTag; public uint cbTag;
        public IntPtr pbMacContext; public uint cbMacContext;
        public uint cbAAD; public ulong cbData; public uint dwFlags;
    }

    [DllImport("bcrypt.dll")]
    static extern uint BCryptDecrypt(IntPtr hKey, byte[] pbInput, uint cbInput, ref BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO pPaddingInfo, byte[] pbIV, uint cbIV, byte[] pbOutput, uint cbOutput, out uint pcbResult, uint dwFlags);

    public static byte[] Decrypt(byte[] key, byte[] nonce, byte[] cipherText, byte[] tag)
    {
        IntPtr hAlg = IntPtr.Zero, hKey = IntPtr.Zero;
        uint status = BCryptOpenAlgorithmProvider(out hAlg, "AES", null, 0);
        if (status != 0) throw new Exception("OpenAlgorithmProvider failed: 0x" + status.ToString("X"));
        string mode = "ChainingModeGCM";
        status = BCryptSetProperty(hAlg, "ChainingMode", mode, (mode.Length + 1) * 2, 0);
        if (status != 0) throw new Exception("SetProperty failed: 0x" + status.ToString("X"));
        status = BCryptGenerateSymmetricKey(hAlg, out hKey, IntPtr.Zero, 0, key, (uint)key.Length, 0);
        if (status != 0) throw new Exception("GenerateSymmetricKey failed: 0x" + status.ToString("X"));
        GCHandle nonceHandle = GCHandle.Alloc(nonce, GCHandleType.Pinned);
        GCHandle tagHandle = GCHandle.Alloc(tag, GCHandleType.Pinned);
        try
        {
            var info = new BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO));
            info.dwInfoVersion = 1;
            info.pbNonce = nonceHandle.AddrOfPinnedObject(); info.cbNonce = (uint)nonce.Length;
            info.pbTag = tagHandle.AddrOfPinnedObject(); info.cbTag = (uint)tag.Length;
            byte[] output = new byte[cipherText.Length];
            uint resultLen;
            status = BCryptDecrypt(hKey, cipherText, (uint)cipherText.Length, ref info, null, 0, output, (uint)output.Length, out resultLen, 0);
            if (status != 0) throw new Exception("BCryptDecrypt failed: 0x" + status.ToString("X"));
            byte[] result = new byte[resultLen];
            Array.Copy(output, result, resultLen);
            return result;
        }
        finally
        {
            nonceHandle.Free(); tagHandle.Free();
            if (hKey != IntPtr.Zero) BCryptDestroyKey(hKey);
            if (hAlg != IntPtr.Zero) BCryptCloseAlgorithmProvider(hAlg, 0);
        }
    }
}
'@
try { [BCryptAesGcm] | Out-Null } catch { Add-Type -TypeDefinition $BCryptSrc -Language CSharp -ErrorAction SilentlyContinue }
Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue

function Read-FileShared($path) {
    try {
        $fs     = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
        $reader = New-Object System.IO.StreamReader($fs)
        $text   = $reader.ReadToEnd()
        $reader.Close(); $fs.Close()
        return $text
    } catch { return $null }
}

function Get-TokenCacheBlob($root) {
    try {
        $cfg = Read-FileShared (Join-Path $root 'config.json') | ConvertFrom-Json
        # Claude Desktop's V1 entry can be an empty placeholder. Prefer V2 but
        # retain V1 compatibility for older desktop builds.
        $blob = $cfg.'oauth:tokenCacheV2'
        if (-not $blob) { $blob = $cfg.'oauth:tokenCache' }
        return $blob
    } catch { return $null }
}

function Get-AesKey($root) {
    try {
        $ls = Read-FileShared (Join-Path $root 'Local State')
        if (-not $ls) { return $null }
        $b64   = ($ls | ConvertFrom-Json).os_crypt.encrypted_key
        $bytes = [Convert]::FromBase64String($b64)
        return [System.Security.Cryptography.ProtectedData]::Unprotect(
                   $bytes[5..($bytes.Length - 1)], $null,
                   [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    } catch { return $null }
}

function Get-TokenFromBlob($blob, $key) {
    if (-not $blob -or -not $key) { return $null }
    try {
        $bytes        = [Convert]::FromBase64String($blob)
        $nonce        = $bytes[3..14]
        $cipherAndTag = $bytes[15..($bytes.Length - 1)]
        $cipherLen    = $cipherAndTag.Length - 16
        $cipherText   = $cipherAndTag[0..($cipherLen - 1)]
        $tag          = $cipherAndTag[$cipherLen..($cipherAndTag.Length - 1)]
        $plainBytes   = [BCryptAesGcm]::Decrypt($key, $nonce, $cipherText, $tag)
        $plainText    = [System.Text.Encoding]::UTF8.GetString($plainBytes)
        $entry        = ($plainText | ConvertFrom-Json).PSObject.Properties.Value | Select-Object -First 1
        return $entry.token
    } catch { return $null }
}

# HttpClient, not Invoke-RestMethod: under Windows PowerShell 5.1 (the Desktop
# shortcut's shell) Invoke-RestMethod hangs indefinitely reading a SUCCESSFUL
# response from this endpoint (-TimeoutSec doesn't cover the read stall);
# error responses return instantly. HttpClient with its own Timeout is immune.
$HttpClient = $null
function Get-ClaudeUsage($accessToken) {
    if (-not $accessToken) { return $null }
    try {
        if (-not $script:HttpClient) {
            $handler = New-Object System.Net.Http.HttpClientHandler
            $script:HttpClient = New-Object System.Net.Http.HttpClient($handler)
            $script:HttpClient.Timeout = [TimeSpan]::FromSeconds(6)
        }
        $req = New-Object System.Net.Http.HttpRequestMessage('GET', 'https://api.anthropic.com/api/oauth/usage')
        $req.Headers.Add('Authorization', "Bearer $accessToken")
        $req.Headers.Add('anthropic-version', '2023-06-01')
        $req.Headers.Add('anthropic-beta', 'oauth-2025-04-20')
        $resp = $script:HttpClient.SendAsync($req).GetAwaiter().GetResult()
        if (-not $resp.IsSuccessStatusCode) { return $null }
        $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        return ($body | ConvertFrom-Json)
    } catch { return $null }
}

function Get-UsageFromBlob($blob, $key) {
    $tok = Get-TokenFromBlob $blob $key
    if (-not $tok) { return $null }
    return Get-ClaudeUsage $tok
}

# Format the reset times into a short, human line (local time). The 5h limit is
# close so it's shown as a countdown; the weekly limit is shown as a date+time.
function Format-Resets($u) {
    if (-not $u) { return $null }
    $now   = Get-Date
    $parts = @()
    try {
        $r5 = [datetimeoffset]::Parse($u.five_hour.resets_at).LocalDateTime
        $d  = $r5 - $now
        if ($d.TotalSeconds -gt 0) {
            # Floor, not [int]: the cast rounds, so a wait of 2h39 printed as
            # "3h39m" - an hour off, on the one number the line exists to give.
            $rel = if ($d.TotalHours -ge 1) { "{0}h{1:00}m" -f [int][math]::Floor($d.TotalHours), $d.Minutes }
                   else { "{0}m" -f [int][math]::Floor($d.TotalMinutes) }
            $parts += "5h resets in $rel ($($r5.ToString('HH:mm')))"
        }
    } catch {}
    try {
        $r7 = [datetimeoffset]::Parse($u.seven_day.resets_at).LocalDateTime
        $parts += "7d resets $($r7.ToString('ddd MMM d, HH:mm'))"
    } catch {}
    if ($parts.Count) { return ($parts -join '   |   ') }
    return $null
}

# -- Load saved accounts -------------------------------------------------------
$accounts = Get-ChildItem $store -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'meta.json') }
if (-not $accounts) {
    Write-Host "No saved Claude accounts." -ForegroundColor Yellow
    Write-Host "Log into Claude, then run 'claude-add-account' to save each account." -ForegroundColor Yellow
    Start-Sleep -Seconds 3; return
}

$list = @()
$legacyCount = 0
foreach ($a in $accounts) {
    try { $m = Get-Content (Join-Path $a.FullName 'meta.json') -Raw | ConvertFrom-Json } catch { continue }
    $profile = Join-Path $a.FullName 'profile'
    if (-not (Test-Path $profile)) { $legacyCount++; continue }
    $tc = $null
    $tc = Get-TokenCacheBlob $profile
    $list += [pscustomobject]@{ Email = $m.email; Dir = $a.FullName; Profile = $profile; Token = $tc }
}
if (-not $list) {
    if ($legacyCount) {
        Write-Host "Your saved desktop accounts use the retired partial-session format." -ForegroundColor Yellow
        Write-Host "Sign in to each account once, then run claude-add-account to create complete-profile snapshots." -ForegroundColor Yellow
    } else {
        Write-Host "No usable Claude accounts were found. Run claude-add-account after signing in." -ForegroundColor Yellow
    }
    Start-Sleep -Seconds 4; return
}

# -- Display picker ------------------------------------------------------------
Write-Host ""
Write-Host "=== Switch Claude account ===" -ForegroundColor Cyan
Test-ForUpdate

# Identify the current account (live config token matches a saved one) + fetch usage.
$liveRoot   = Get-SessionRoot
$liveToken  = $null
if ($liveRoot) { $liveToken = Get-TokenCacheBlob $liveRoot }
# The app rotates its session tokens while it runs, so the live token may no
# longer match any saved snapshot. Fall back to the marker written on the last
# switch to still know which saved account the live session belongs to.
$currentFile = Join-Path $store '.current'
$currentAcct = $null
if ($liveToken) { $currentAcct = $list | Where-Object { $_.Token -eq $liveToken } | Select-Object -First 1 }
if (-not $currentAcct -and (Test-Path $currentFile)) {
    try {
        $curEmail    = (Get-Content $currentFile -Raw).Trim()
        $currentAcct = $list | Where-Object { $_.Email -eq $curEmail } | Select-Object -First 1
    } catch {}
}
if ($currentAcct) { $liveToken = $currentAcct.Token }
$aesKey = if ($liveRoot) { Get-AesKey $liveRoot } else { $null }
Write-Host "Fetching usage..." -ForegroundColor DarkGray

for ($i = 0; $i -lt $list.Count; $i++) {
    $mark = if ($liveToken -and $list[$i].Token -eq $liveToken) { '*' } else { ' ' }
    $u = Get-UsageFromBlob $list[$i].Token $aesKey
    $usageStr = if ($u) { "  5h {0,3}% / 7d {1,3}% used" -f [int]$u.five_hour.utilization, [int]$u.seven_day.utilization } else { "  usage n/a" }
    Write-Host ("  [{0}] {1} {2,-32}{3}" -f ($i + 1), $mark, $list[$i].Email, $usageStr)
    $resetStr = Format-Resets $u
    if ($resetStr) { Write-Host ("        $resetStr") -ForegroundColor DarkGray }
}
Write-Host "  (* = current   |   lower % = more headroom)" -ForegroundColor DarkGray
Write-Host ""
$pick = Read-Host "Pick an account number (or Enter to cancel)"
if ([string]::IsNullOrWhiteSpace($pick)) { Write-Host "Cancelled." -ForegroundColor Yellow; return }
if ($pick -notmatch '^\d+$' -or [int]$pick -lt 1 -or [int]$pick -gt $list.Count) {
    Write-Host "Invalid choice." -ForegroundColor Red; Start-Sleep -Seconds 2; return
}
$chosen      = $list[[int]$pick - 1]
# -- Perform the swap ----------------------------------------------------------
$root = Get-SessionRoot
if (-not $root) { Write-Host "Claude app data not found." -ForegroundColor Red; Start-Sleep -Seconds 2; return }

Write-Host ""
Write-Host "Closing Claude..." -ForegroundColor Cyan
if (-not (Stop-Claude $root)) {
    Write-Host "Could not fully close Claude (session locked). Close all windows and retry." -ForegroundColor Red
    Start-Sleep -Seconds 3; return
}

# Back up the complete live profile so a bad swap is recoverable.
$backup = Join-Path $store ('.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Host "Backing up current profile..." -ForegroundColor DarkGray
if (-not (Copy-ClaudeProfile $root (Join-Path $backup 'profile'))) {
    Write-Host "Could not back up the current profile. Refusing to switch." -ForegroundColor Red
    Start-Claude
    Start-Sleep -Seconds 3; return
}

# Keep only the most recent backup (complete profiles are large).
Get-ChildItem $store -Directory -Filter '.backup-*' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -Skip 1 |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# Sync the entire live profile back before loading another account. This keeps
# every authentication component consistent as Claude changes its storage.
if ($currentAcct) {
    Write-Host "Refreshing saved profile for $($currentAcct.Email)..." -ForegroundColor DarkGray
    if (-not (Copy-ClaudeProfile $root $currentAcct.Profile)) {
        Write-Host "Could not refresh the current profile. Refusing to switch." -ForegroundColor Red
        Start-Claude
        Start-Sleep -Seconds 3; return
    }
}

Write-Host "Loading complete profile for $($chosen.Email)..." -ForegroundColor Cyan
if (-not (Copy-ClaudeProfile $chosen.Profile $root)) {
    Write-Host "Could not load the selected profile. Restore the backup at $backup if needed." -ForegroundColor Red
    Start-Sleep -Seconds 3; return
}

# Remember which saved account the live session now belongs to, so the next
# sync-back can identify it even after the app rotates its tokens.
try {
    [System.IO.File]::WriteAllText((Join-Path $store '.current'), $chosen.Email,
        (New-Object System.Text.UTF8Encoding($false)))
} catch {}

Write-Host "Reopening Claude..." -ForegroundColor Cyan
if (Start-Claude) {
    Write-Host ""
    Write-Host "Done - Claude is reopening as $($chosen.Email)." -ForegroundColor Green
    Write-Host "If it still shows the old account, fully quit Claude from the tray and reopen." -ForegroundColor DarkGray
} else {
    Write-Host "Session swapped, but the Claude app wasn't found to relaunch - open it manually." -ForegroundColor Yellow
}
Start-Sleep -Seconds 2
