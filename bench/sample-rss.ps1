param(
  [Parameter(Mandatory = $true)][int]$Root,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$IntervalMs = 200,
  [int]$RefreshEvery = 5
)

# Working sets are read with Get-Process (about 17 ms); the tree membership is
# refreshed with Win32_Process (about 110 ms) only every RefreshEvery samples,
# which is what keeps a 200 ms interval honest.
$ErrorActionPreference = 'SilentlyContinue'
$writer = [System.IO.StreamWriter]::new($Out, $false)
$writer.AutoFlush = $true

function Get-Descendants([int]$root) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name
  $children = @{}
  foreach ($process in $all) {
    $parent = [int]$process.ParentProcessId
    if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.ArrayList }
    [void]$children[$parent].Add([int]$process.ProcessId)
  }
  $names = @{}
  foreach ($process in $all) { $names[[int]$process.ProcessId] = [string]$process.Name }

  $found = @{}
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $current = $stack.Pop()
    if ($found.ContainsKey($current)) { continue }
    if (-not $names.ContainsKey($current)) { continue }
    $found[$current] = $names[$current]
    if ($children.ContainsKey($current)) {
      foreach ($child in $children[$current]) { $stack.Push($child) }
    }
  }
  return $found
}

$members = Get-Descendants $Root
$index = 0
while ($true) {
  if ($index -gt 0 -and ($index % $RefreshEvery) -eq 0) { $members = Get-Descendants $Root }
  $rows = New-Object System.Collections.ArrayList
  $ids = @($members.Keys)
  if ($ids.Count -gt 0) {
    foreach ($live in @(Get-Process -Id $ids)) {
      [void]$rows.Add([pscustomobject]@{ pid = [int]$live.Id; name = [string]$members[[int]$live.Id]; ws = [long]$live.WorkingSet64 })
    }
  }
  $line = [pscustomobject]@{
    t     = [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    procs = [object[]]$rows
  } | ConvertTo-Json -Compress -Depth 4
  $writer.WriteLine($line)
  $index += 1
  Start-Sleep -Milliseconds $IntervalMs
}
