# Finds or ends the shell of one Boite install, by the full path of its
# executable. hooks.nsh supplies these environment variables:
#   BOITE_SHELL_DIR     the install directory
#   BOITE_SHELL_NAMES   the shell's file name, then the one the previous
#                       install registered, separated by '|'
#   BOITE_SHELL_ACTION  find: exit 0 when one runs, 1 when none does
#                       stop: end them, exit 0 once none is left
# Exit 2: the processes could not be listed, or one would not end.
#
# Boite and Boite Dev install side by side and a build can run from a cargo
# target directory: a shell of the same file name anywhere else is left alone.

$dir = [IO.Path]::GetFullPath($env:BOITE_SHELL_DIR)
# Bare file names only: a registry value cannot point the check outside the install.
$paths = @($env:BOITE_SHELL_NAMES -split '\|' | Where-Object { $_ -match '^[\w .-]+\.exe$' } |
  ForEach-Object { [IO.Path]::GetFullPath((Join-Path $dir $_)) } | Select-Object -Unique)
if ($paths.Count -eq 0) {
  if ($env:BOITE_SHELL_ACTION -eq 'find') { exit 1 }
  exit 0
}
$filter = @($paths | ForEach-Object { "Name='$([IO.Path]::GetFileName($_))'" }) -join ' OR '

function Get-Shells {
  @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop |
    Where-Object { $_.ExecutablePath -and ($paths -contains [IO.Path]::GetFullPath($_.ExecutablePath)) } |
    ForEach-Object { [int]$_.ProcessId })
}

try { $running = Get-Shells } catch {
  Write-Output "Boite could not list the processes running from $dir."
  exit 2
}
if ($env:BOITE_SHELL_ACTION -eq 'find') {
  if ($running.Count -gt 0) { exit 0 }
  exit 1
}

foreach ($id in $running) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
$deadline = (Get-Date).AddSeconds(5)
try {
  while ((Get-Shells).Count -gt 0) {
    if ((Get-Date) -ge $deadline) { exit 2 }
    Start-Sleep -Milliseconds 200
  }
} catch { exit 2 }
exit 0
