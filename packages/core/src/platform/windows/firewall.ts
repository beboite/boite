/*
 * The two PowerShell commands behind `firewall.status` and `firewall.allow`.
 *
 * On Windows the core is Bun's own signed runtime under the name
 * `boite-core.exe`, so the first time it listens outside loopback Windows asks
 * whether to let "Bun", published by "Oven", through, and creates block rules
 * before anybody answers. Dismissed, they stay. Allowed, the rule covers the
 * category of the network the machine was on then, public or private, and a
 * network classified the other way later blocks the core again.
 *
 * Reading needs no rights. Fixing does: one administrator prompt runs a
 * script that deletes every inbound rule naming this executable, the prompt's
 * block rules included, since a block wins over an allow, and adds one rule
 * named Boite that allows its TCP connections on every profile. Both scripts
 * are passed encoded, so a path holding a quote cannot break out of them.
 */

import { FIREWALL_PROMPT_REFUSED } from '../types.ts';

const POWERSHELL = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/** ERROR_CANCELLED, the Win32 error Start-Process -Verb RunAs fails with when the prompt is refused. */
const ELEVATION_CANCELLED = 1223;

function quote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function encoded(script: string): string[] {
  return [POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/**
 * Prints one JSON line: the inbound rules naming `program` (action 0 blocks,
 * 1 allows; profiles as the firewall's bit mask, 1 domain, 2 private,
 * 4 public), the connected networks with their adapter and category, and the
 * profiles where the firewall is off.
 */
export function firewallQuery(program: string): string[] {
  return encoded(`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$program = ${quote(program)}
$fw = New-Object -ComObject HNetCfg.FwPolicy2
$rules = @($fw.Rules | Where-Object { $_.Direction -eq 1 -and $_.Enabled -and $_.ApplicationName -and [Environment]::ExpandEnvironmentVariables($_.ApplicationName) -ieq $program } | ForEach-Object { @{ action = [int]$_.Action; profiles = [int]$_.Profiles } })
$networks = @(Get-NetConnectionProfile | ForEach-Object { @{ adapter = [string]$_.InterfaceAlias; category = [string]$_.NetworkCategory } })
$off = 0
foreach ($bit in 1, 2, 4) { if (-not $fw.FirewallEnabled($bit)) { $off = $off -bor $bit } }
[Console]::Out.Write((@{ rules = $rules; networks = $networks; off = $off } | ConvertTo-Json -Compress -Depth 4))
`);
}

/**
 * Exits 0 once the rule is in place, `FIREWALL_PROMPT_REFUSED` when the
 * administrator prompt was refused. `Process.Start` with the `runas` verb is
 * used rather than `Start-Process`, whose error carries only a translated
 * message: a refusal is a Win32Exception with ERROR_CANCELLED in any language.
 */
export function firewallAllow(program: string): string[] {
  const elevated = encoded(`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$program = ${quote(program)}
Get-NetFirewallApplicationFilter | Where-Object { $_.Program -and [Environment]::ExpandEnvironmentVariables($_.Program) -ieq $program } | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' } | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Boite' -Description 'Lets a phone or another computer reach Boite.' -Direction Inbound -Action Allow -Program $program -Protocol TCP -Profile Any | Out-Null
`).slice(1);
  return encoded(`
try {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = ${quote(POWERSHELL)}
  $info.Arguments = ${quote(elevated.join(' '))}
  $info.Verb = 'runas'
  $info.UseShellExecute = $true
  $info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $run = [System.Diagnostics.Process]::Start($info)
  $run.WaitForExit()
  exit $run.ExitCode
} catch [System.ComponentModel.Win32Exception] {
  if ($_.Exception.NativeErrorCode -eq ${ELEVATION_CANCELLED}) { exit ${FIREWALL_PROMPT_REFUSED} }
  exit 1
} catch {
  exit 1
}
`);
}
