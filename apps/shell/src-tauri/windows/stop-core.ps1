# Stops the core of one Boite install, before its installer replaces or
# deletes boite-core.exe. hooks.nsh supplies these environment variables:
#   BOITE_STOP_EXE  the install's boite-core.exe
#   BOITE_STOP_DIR  the install's data directory, which holds core.json
#   BOITE_STOP_IDLE  1 for installation, 0 for explicit uninstall
#   BOITE_STOP_EXPLICIT  1 only after accepting the interactive shell Kill prompt
# Only this install's executable or the Bun PID in core.json running its
# entry bundle is touched. Installation requires idle
# admission unless the user accepted Kill. Explicit stop requests /shutdown,
# then ends a core that has not exited after 15 seconds.

$exe = [IO.Path]::GetFullPath($env:BOITE_STOP_EXE)
$entry = Join-Path ([IO.Path]::GetDirectoryName($exe)) 'core\main.js'

# Use Windows' argument parser: paths may contain spaces and escaped slashes.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BoiteStopArgv {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Parse(string command) {
    int count;
    var memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      var args = new string[count];
      for (int i = 0; i < count; i++)
        args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
      return args;
    } finally { LocalFree(memory); }
  }
}
'@

function Test-BunCore($process, $core) {
  if (!$core -or [int]$process.ProcessId -ne [int]$core.pid -or !$process.CommandLine) { return $false }
  $arguments = [BoiteStopArgv]::Parse($process.CommandLine)
  $scriptIndex = 1
  if ($arguments.Length -gt 1 -and $arguments[1] -eq 'run') { $scriptIndex = 2 }
  if ($arguments.Length -le $scriptIndex -or ![IO.Path]::IsPathRooted($arguments[$scriptIndex])) { return $false }
  if ([IO.Path]::GetFullPath($arguments[$scriptIndex]) -ine $entry) { return $false }
  $dataIndex = [Array]::IndexOf($arguments, '--data-dir')
  return $dataIndex -ge 0 -and $arguments.Length -gt ($dataIndex + 1) -and
    [IO.Path]::GetFullPath($arguments[$dataIndex + 1]) -ieq [IO.Path]::GetFullPath($env:BOITE_STOP_DIR)
}

function Get-Cores {
  $core = $null
  try { $core = Get-Content -Raw -LiteralPath (Join-Path $env:BOITE_STOP_DIR 'core.json') -ErrorAction Stop | ConvertFrom-Json } catch {}
  @(Get-CimInstance Win32_Process -Filter "Name='boite-core.exe' OR Name='bun.exe'" -ErrorAction Stop |
    Where-Object { $_.ExecutablePath -and (([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $exe) -or
      ($_.Name -ieq 'bun.exe' -and (Test-BunCore $_ $core))) } |
    ForEach-Object { [int]$_.ProcessId })
}

function Wait-Cores([int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Cores).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
}

try { $running = Get-Cores } catch {
  Write-Output 'Boite could not identify its running core. No files were replaced.'
  exit 2
}
if ($running.Count -eq 0) { exit 0 }

if ($env:BOITE_STOP_IDLE -eq '1' -and $env:BOITE_STOP_EXPLICIT -ne '1') {
  try {
    $core = Get-Content -Raw -LiteralPath (Join-Path $env:BOITE_STOP_DIR 'core.json') -ErrorAction Stop | ConvertFrom-Json
    if ($running.Count -ne 1 -or $running[0] -ne [int]$core.pid) { throw 'core.json must identify the only running core of this install' }
    $headers = @{ Authorization = "Bearer $($core.token)" }
    $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$($core.port)/shutdown-if-idle?pid=$($core.pid)" -Headers $headers -TimeoutSec 5 -ErrorAction Stop
    $ack = $response.Content | ConvertFrom-Json
    if ($response.StatusCode -ne 202 -or $ack.ok -ne $true -or $ack.pid -ne $core.pid) { throw 'idle admission must acknowledge the expected core pid' }
    Wait-Cores 15
    if ((Get-Cores).Count -gt 0) { throw 'the admitted core did not exit' }
    exit 0
  } catch {
    # A busy, older or unreachable core is kept intact. The installer aborts.
    Write-Output 'Boite could not confirm an idle core. Let its work finish or stop it explicitly, then retry installation.'
    exit 2
  }
}

try {
  $core = Get-Content -Raw -LiteralPath (Join-Path $env:BOITE_STOP_DIR 'core.json') | ConvertFrom-Json
  if ($running -contains [int]$core.pid) {
    $headers = @{ Authorization = "Bearer $($core.token)" }
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$($core.port)/shutdown" -Headers $headers -TimeoutSec 5 | Out-Null
  }
} catch {
  # No core.json, a core that does not answer: it is ended below.
}

Wait-Cores 15
# Listed again: a pid that exited meanwhile may already name another process.
foreach ($id in (Get-Cores)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
Wait-Cores 5
if ((Get-Cores).Count -gt 0) { exit 2 }
exit 0
