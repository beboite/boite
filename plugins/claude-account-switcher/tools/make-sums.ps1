# Regenerate SHA256SUMS for everything under src/. Run it after touching any
# installed script: the installer refuses a file whose hash is not listed, so an
# unlisted or stale entry breaks the install rather than passing silently.
#
#   pwsh -NoProfile -File tools/make-sums.ps1
#
# The hash is taken over the text with line endings normalised to LF and no BOM,
# the same way install.ps1 hashes what it downloads - git can hand out CRLF on
# one checkout and LF on another for the same commit.

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$src  = Join-Path $repo 'src'

function Get-TextSha256($path) {
    $text = [System.IO.File]::ReadAllText($path)
    $norm = ($text -replace "`r`n", "`n").TrimStart([char]0xFEFF)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($norm))
        return [System.BitConverter]::ToString($bytes).Replace('-', '').ToLower()
    } finally { $sha.Dispose() }
}

$lines = @()
foreach ($f in (Get-ChildItem $src -Recurse -File | Sort-Object FullName)) {
    $rel = $f.FullName.Substring($repo.Length + 1) -replace '\\', '/'
    $lines += "{0}  {1}" -f (Get-TextSha256 $f.FullName), $rel
}
$out = Join-Path $repo 'SHA256SUMS'
[System.IO.File]::WriteAllText($out, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("Wrote {0} ({1} files)." -f $out, $lines.Count) -ForegroundColor Green
