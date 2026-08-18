# What each supported CLI keeps on disk, and how to name it.
# Loaded before anything else: every other script asks this file where to look.

$CcProviderIds = @('claude', 'codex')

function Resolve-CcProviderId {
    param([string]$Id)
    $key = "$Id".Trim().ToLowerInvariant()
    if (-not $key) { return 'claude' }
    if ($key -in @('claude', 'claude-code', 'claudecode', 'cc', 'anthropic')) { return 'claude' }
    if ($key -in @('codex', 'openai', 'chatgpt', 'gpt')) { return 'codex' }
    throw "Unknown provider '$Id'. Known providers: $($CcProviderIds -join ', ')."
}

# `all` is not a provider: it is a request to run the command once per provider,
# and it has to be caught before this file is asked to resolve it.
function Test-CcAllProviders {
    param([string]$Id)
    "$Id".Trim().ToLowerInvariant() -in @('all', 'every', '*')
}

function Get-CcNewestPath {
    param([string[]]$Paths)
    $found = @($Paths |
        Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
        Sort-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } -Descending)
    if ($found.Count) { $found[0] } else { $null }
}

function Get-CcProviderSpec {
    param([string]$Id)
    $id = Resolve-CcProviderId $Id
    if ($id -eq 'codex') {
        $dir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
        return @{
            Id                      = 'codex'
            Label                   = 'Codex'
            Cli                     = 'codex'
            Store                   = Join-Path $HOME '.codex-cc-accounts'
            ConfigDir               = $dir
            CredCandidates          = @((Join-Path $dir 'auth.json'))
            ConfigCandidates        = @((Join-Path $dir 'auth.json'))
            CredLabel               = '~/.codex/auth.json'
            HasSeparateIdentityFile = $false
            UsesKeychain            = $false
            KeychainService         = $null
            SupportsUsage           = $true
        }
    }
    $dir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
    return @{
        Id                      = 'claude'
        Label                   = 'Claude Code'
        Cli                     = 'claude'
        Store                   = Join-Path $HOME '.claude-cc-accounts'
        ConfigDir               = $dir
        CredCandidates          = @((Join-Path $dir '.credentials.json'))
        # The email lives beside the tokens rather than with them.
        ConfigCandidates        = @((Join-Path $HOME '.claude.json'), (Join-Path $dir '.claude.json'))
        CredLabel               = '~/.claude/.credentials.json'
        HasSeparateIdentityFile = $true
        UsesKeychain            = $IsMacOS
        KeychainService         = 'Claude Code-credentials'
        SupportsUsage           = $true
    }
}
