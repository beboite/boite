# Stops the core of one Boite install, before its installer replaces or
# deletes boite-core.exe. hooks.nsh runs it with two environment variables:
#   BOITE_STOP_EXE  the install's boite-core.exe
#   BOITE_STOP_DIR  the install's data directory, which holds core.json
# Only a process running that exact file is touched: Boite Dev runs a
# boite-core.exe too, from another directory. The core is asked first, through
# its authenticated POST /shutdown, so it drains its agents and closes its
# journal; only a core still running after 15 s is ended.

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
