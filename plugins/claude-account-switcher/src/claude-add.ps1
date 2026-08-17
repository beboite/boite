# Snapshot the Claude desktop account that is CURRENTLY logged in, so it can be
# switched to later. Claude's desktop authentication spans its whole Electron
# profile, not just cookies. Snapshotting only selected folders creates a mixed
# profile after a restore and can trigger server-side reauthentication. Save and
# restore the complete closed profile instead.
#
# Run from a NORMAL PowerShell window. THIS CLOSES THE CLAUDE APP.

$store          = Join-Path $env:USERPROFILE '.claude-accounts'

Write-Host ""
Write-Host "=== Add Claude account (complete profile snapshot) ===" -ForegroundColor Cyan
Write-Host "1. Log into the account you want to save in the Claude desktop app." -ForegroundColor DarkGray
Write-Host "2. Then run this - it CLOSES Claude to copy its session, then reopens it." -ForegroundColor DarkGray
Write-Host ""

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
    if ($a) { Start-Process "shell:AppsFolder\$($a.AppID)" }
}

function Copy-ClaudeProfile($source, $destination) {
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    robocopy $source $destination /MIR /COPY:DAT /DCOPY:DAT /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -gt 7) { return $false }

    # These are process-instance artifacts, never account state. Leaving one in
    # a restored profile can prevent Electron from starting cleanly.
    Get-ChildItem $destination -Force -Filter 'Singleton*' -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
    return $true
}

function Clear-ClaudeProfile($root) {
    # The root is the exact app-data directory resolved above, never a parent.
    Get-ChildItem $root -Force -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# AES-256-GCM decrypt of the app's tokenCache via bcrypt.dll (Windows' native
# CNG crypto library) through a direct P/Invoke - no external process, no temp
# script files, no Node dependency. PowerShell 5.1's .NET Framework has no
# built-in AesGcm class (that only ships in .NET 5+), so this is the only
# in-process option that works on both 5.1 and pwsh 7. Deliberately not
# shelling out to node/cmd here: reading a browser-style credential store,
# decrypting it, and spawning a child process to do so is the exact
# behavioral pattern security software flags as credential theft - this
# keeps everything in-process and inspectable.
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

# Detect the email of the account ACTUALLY logged in, by decrypting the app's
# oauth:tokenCache and asking the OAuth profile endpoint. Guards against
# snapshotting under a mistyped email or while the app is logged out (same
# guard claude-code-add has). Returns:
#   a string email  - positively identified
#   'EMPTY'         - token cache decrypted fine but holds no token at all
#                      (definitely logged out - never overridable)
#   $null           - undetermined (dead/expired token, decrypt failure, etc.)
function Get-LoggedInEmail($root) {
    try {
        $ls  = $null
        try { $fs=[IO.File]::Open((Join-Path $root 'Local State'),'Open','Read','ReadWrite'); $r=New-Object IO.StreamReader($fs); $ls=$r.ReadToEnd(); $r.Close(); $fs.Close() } catch { return $null }
        $b   = [Convert]::FromBase64String(($ls | ConvertFrom-Json).os_crypt.encrypted_key)
        $key = [System.Security.Cryptography.ProtectedData]::Unprotect($b[5..($b.Length-1)], $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $cfgRaw = $null
        try { $fs=[IO.File]::Open((Join-Path $root 'config.json'),'Open','Read','ReadWrite'); $r=New-Object IO.StreamReader($fs); $cfgRaw=$r.ReadToEnd(); $r.Close(); $fs.Close() } catch { return $null }
        $cfg = $cfgRaw | ConvertFrom-Json
        # Claude Desktop moved live credentials to V2. Prefer it, but retain
        # V1 for older desktop builds.
        $blob = $cfg.'oauth:tokenCacheV2'
        if (-not $blob) { $blob = $cfg.'oauth:tokenCache' }
        if (-not $blob) { return 'EMPTY' }
        $bytes        = [Convert]::FromBase64String($blob)
        $nonce        = $bytes[3..14]
        $cipherAndTag = $bytes[15..($bytes.Length - 1)]
        $cipherLen    = $cipherAndTag.Length - 16
        $cipherText   = $cipherAndTag[0..($cipherLen - 1)]
        $tag          = $cipherAndTag[$cipherLen..($cipherAndTag.Length - 1)]
        $plainBytes   = [BCryptAesGcm]::Decrypt($key, $nonce, $cipherText, $tag)
        $plainText    = [System.Text.Encoding]::UTF8.GetString($plainBytes)
        $entry        = ($plainText | ConvertFrom-Json).PSObject.Properties.Value | Select-Object -First 1
        $tok = $entry.token
        if (-not $tok) { return 'EMPTY' }

        $handler = New-Object System.Net.Http.HttpClientHandler
        $client  = New-Object System.Net.Http.HttpClient($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(6)
        $req = New-Object System.Net.Http.HttpRequestMessage('GET', 'https://api.anthropic.com/api/oauth/profile')
        $req.Headers.Add('Authorization', "Bearer $tok")
        $req.Headers.Add('anthropic-version', '2023-06-01')
        $req.Headers.Add('anthropic-beta', 'oauth-2025-04-20')
        $resp = $client.SendAsync($req).GetAwaiter().GetResult()
        if (-not $resp.IsSuccessStatusCode) { return $null }
        $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $j = $body | ConvertFrom-Json
        if ($j.account.email) { return $j.account.email }
    } catch {}
    return $null
}

$root = Get-SessionRoot
if (-not $root) {
    Write-Host "Claude app data not found. Open Claude, log in, then retry." -ForegroundColor Red
    Start-Sleep -Seconds 3; return
}

$detected = Get-LoggedInEmail $root
if ($detected -eq 'EMPTY') {
    Write-Host "Claude isn't logged into any account right now (token cache is empty)." -ForegroundColor Red
    Write-Host "Log in first, then run 'claude-add-account' again - saving now would snapshot a logged-out session that fails on restore." -ForegroundColor Red
    Start-Sleep -Seconds 4; return
}
$email = $null
if ($detected) {
    $ans = Read-Host "Detected logged-in account: $detected - save this one? [Y/n]"
    if ($ans -notmatch '^(n|no)$') { $email = $detected }
} else {
    Write-Host "Could not verify which account is logged in (token dead or network unreachable)." -ForegroundColor Yellow
    Write-Host "If the app shows a sign-in screen, log in first - saving now would snapshot a logged-out session." -ForegroundColor Yellow
}
if (-not $email) {
    $email = Read-Host "Email of the account currently logged into Claude"
    if ([string]::IsNullOrWhiteSpace($email)) { Write-Host "Cancelled." -ForegroundColor Yellow; return }
    if ($detected -and $email -ne $detected) {
        Write-Host "You typed '$email' but the live session belongs to '$detected' - not saving a mislabeled snapshot." -ForegroundColor Red
        Start-Sleep -Seconds 4; return
    }
}

Write-Host "Closing Claude..." -ForegroundColor Cyan
if (-not (Stop-Claude $root)) {
    Write-Host "Could not fully close Claude (session still locked)." -ForegroundColor Red
    Write-Host "Close every Claude window manually, then retry." -ForegroundColor Red
    Start-Sleep -Seconds 3; return
}

$safe        = ($email -replace '[^\w.@+-]', '_')
$dest        = Join-Path $store $safe
$profileDest = Join-Path $dest 'profile'

Write-Host "Saving complete profile for $email ..." -ForegroundColor Cyan
if (-not (Copy-ClaudeProfile $root $profileDest)) {
    Write-Host "Could not save the complete Claude profile. No account was changed." -ForegroundColor Red
    Start-Claude
    Start-Sleep -Seconds 3; return
}

[ordered]@{ email = $email; savedAt = (Get-Date -Format o); sourceRoot = $root; profileFormat = 2 } |
    ConvertTo-Json | Set-Content -Path (Join-Path $dest 'meta.json') -Encoding UTF8

# Mark this account as the one the live session belongs to, so claude-switch
# can sync the live session back into this snapshot even after the app rotates
# its tokens (a rotated token no longer matches the saved tokenCache).
try {
    [System.IO.File]::WriteAllText((Join-Path $store '.current'), $email,
        (New-Object System.Text.UTF8Encoding($false)))
} catch {}

Write-Host ""
Write-Host "Saved account: $email" -ForegroundColor Green
Write-Host ""

# Offer to set up the NEXT account. We clear the LOCAL profile instead of using
# the app's "Log out"
# - logging out revokes the session server-side, which would kill the snapshot
# we just saved. Clearing locally leaves the saved account valid to switch to.
$more = Read-Host "Add ANOTHER account now? (clears local login WITHOUT logging out, shows sign-in) [y/N]"
if ($more -match '^(y|yes)$') {
    Write-Host "Clearing local profile (not logging out $email)..." -ForegroundColor Cyan
    # The live session is about to belong to a different (not yet saved)
    # account - drop the marker so claude-switch doesn't sync the new login
    # back into this account's snapshot.
    Remove-Item (Join-Path $store '.current') -Force -ErrorAction SilentlyContinue
    Clear-ClaudeProfile $root
    Start-Claude
    Write-Host ""
    Write-Host "Claude is reopening at a SIGN-IN screen." -ForegroundColor Green
    Write-Host "Log in as the NEXT account, then run 'claude-add-account' again." -ForegroundColor Green
} else {
    Write-Host "Reopening Claude..." -ForegroundColor DarkGray
    Start-Claude
}
Start-Sleep -Seconds 2
