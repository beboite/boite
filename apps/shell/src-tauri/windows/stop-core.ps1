# Stops the core of one Boite install, before its installer replaces or
# deletes boite-core.exe. hooks.nsh supplies these environment variables:
#   BOITE_STOP_EXE  the install's boite-core.exe
#   BOITE_STOP_DIR  the install's data directory, which holds core.json
#   BOITE_STOP_IDLE  1 for installation, 0 for explicit uninstall
# Only a process running that exact file is touched: Boite Dev runs a
# boite-core.exe too, from another directory. Installation requires idle
# admission and never kills a core. Explicit uninstall requests /shutdown,
# then ends a core that has not exited after 15 seconds.

$exe = [IO.Path]::GetFullPath($env:BOITE_STOP_EXE)

function Get-Cores {
  @(Get-CimInstance Win32_Process -Filter "Name='boite-core.exe'" |
    Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $exe) } |
    ForEach-Object { [int]$_.ProcessId })
}

function Wait-Cores([int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Cores).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
}

$running = Get-Cores
if ($running.Count -eq 0) { exit 0 }

if ($env:BOITE_STOP_IDLE -eq '1') {
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
exit 0
