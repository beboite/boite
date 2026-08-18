# The one entry point. Everything else is reached through it.
#
#   claude-cc <command> [-Provider claude|codex|all] [options]
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = 'list',
    [string]$Provider = 'claude',
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest = @()
)

$ErrorActionPreference = 'Stop'

$Scripts = @{
    add    = 'claude-code-add.ps1'
    list   = 'claude-code-list.ps1'
    switch = 'claude-code-select.ps1'
    remove = 'claude-code-remove.ps1'
    auto   = 'claude-code-auto.ps1'
    doctor = 'claude-code-doctor.ps1'
}

$Aliases = @{
    ls     = 'list'
    select = 'switch'
    use    = 'switch'
    rm     = 'remove'
    save   = 'add'
    check  = 'doctor'
}

function Show-Usage {
    Write-Host 'claude-cc <command> [-Provider claude|codex|all] [options]'
    Write-Host ''
    Write-Host '  add       save the login the CLI is using right now'
    Write-Host '  list      the saved logins and what is known of their quota (-Refresh to ask the API)'
    Write-Host '  switch    change which saved login the CLI uses'
    Write-Host '  remove    forget a saved login'
    Write-Host '  auto      switch only if the one in use is out of quota'
    Write-Host '  doctor    check the install and the pool (-Protect, -Adopt, -Clean to repair, -Rollback to undo a switch)'
}

$name = "$Command".ToLowerInvariant()
if ($name -in @('-h', '--help', 'help', '')) { Show-Usage; exit 0 }
if ($Aliases.ContainsKey($name)) { $name = $Aliases[$name] }
if (-not $Scripts.ContainsKey($name)) {
    Write-Host "Unknown command '$Command'." -ForegroundColor Red
    Show-Usage
    exit 64
}

$script = Join-Path $PSScriptRoot $Scripts[$name]

# The remaining arguments, as a hashtable to splat.
#
# Splatting an array passes its elements positionally — `-Refresh` would arrive
# as the value of the first positional parameter rather than as the switch it
# is — so the flags are turned back into names and values here.
function ConvertTo-CcParams {
    param([string[]]$Tokens)
    $params = @{}
    $stray  = @()
    for ($i = 0; $i -lt $Tokens.Count; $i++) {
        $token = $Tokens[$i]
        if (-not $token.StartsWith('-')) { $stray += $token; continue }
        $key  = $token.TrimStart('-')
        $next = if ($i + 1 -lt $Tokens.Count) { $Tokens[$i + 1] } else { $null }
        if ($null -ne $next -and -not $next.StartsWith('-')) {
            $params[$key] = $next
            $i++
        } else {
            $params[$key] = $true
        }
    }
    return @{ Params = $params; Stray = $stray }
}

$parsed = ConvertTo-CcParams $Rest

# A bare word is nobody's parameter, and splatting drops it without a word. The
# email goes after `-Email`, and saying so beats switching to the wrong account.
if ($parsed.Stray.Count) {
    Write-Host ("Unexpected argument '{0}'. Options are named: -Email you@example.com" -f $parsed.Stray[0]) -ForegroundColor Red
    exit 64
}
$options = $parsed.Params

# `all` is not a provider — it runs the command once per provider. It is caught
# here, before anything tries to resolve it into a provider spec.
. (Join-Path $PSScriptRoot 'cc-providers.ps1')
if (Test-CcAllProviders $Provider) {
    $worst = 0
    foreach ($id in $CcProviderIds) {
        & $script -Provider $id @options
        # The loudest child owns the exit code: a setup problem in one provider
        # must not be hidden by a clean run in the other.
        if ($LASTEXITCODE -gt $worst) { $worst = $LASTEXITCODE }
        Write-Host ''
    }
    exit $worst
}

& $script -Provider $Provider @options
exit $LASTEXITCODE
