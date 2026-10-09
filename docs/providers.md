# Providers

## Subscription proxy

Settings, Providers offers an optional subscription proxy for Claude, Codex and
OpenCode 2, and for Grok when the gateway is Douane.
Choose Douane or CLIProxyAPI, enter the gateway's API URL and its limits dashboard
URL, enable the switch and save. The API URL accepts an origin or a path ending
in `/v1`. Model discovery runs on the machine hosting the core. The agent's own
discovery runs through the gateway first, so each model keeps the effort scale,
speed tiers (Fast) and names a direct subscription shows. `GET /v1/models` then
adds the models only the gateway routes, and stands alone when the agent's
discovery fails. Paired phones use that same catalog.

Claude Code is told the gateway is first-party, because the gateway relays Messages
unchanged to Anthropic on a subscription: tool search, first-party model aliases
and the one-hour prompt cache stay on (`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`,
`CLAUDE_CODE_PROMPT_CACHE_TTL=1h`), and fast mode skips the organization check
that needs a native login (`CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK`). Codex already
sends its service tier and prompt cache key to a custom provider.

While the proxy is enabled, Claude, Codex and OpenCode 2 show one account named
after the gateway, Douane or CLIProxyAPI, with the API URL's origin, and so
does Grok behind Douane. It has no rename,
check, remove or add actions, and the provider row reads Ready · via Douane.
The composer, delegation profiles, the default model and Limits show the same
account. This account is a view in the UI, not a stored account. Threads,
profiles, routes and agent grants keep naming the local account they were
created with, and the proxy only replaces that account's environment, so every
reference keeps working in both states. The UI shows the first local account of
the provider under the gateway's name, and `accountOf` resolves any local id of
a proxied provider to that view. Settings and provider protocols reach every
client, so a phone computes the same view. Nothing is deleted. Turning the
proxy off brings the local accounts back unchanged. A proxied provider with no
local account at all has nothing to show and asks for a sign-in as before.

Douane's default dashboard path is `/admin/#quotas`; CLIProxyAPI uses
`/management.html#/quota`. A gateway may translate any model to any API, but a
proprietary model stays in its own harness: Claude lists Claude models and
Codex lists OpenAI models, whatever routing prefix the gateway gives them, while
Grok and Muse models are listed by neither. Grok's models are listed by Grok
alone, behind Douane. Gemini models are offered to both,
because Antigravity, their own harness, cannot run through a gateway. Open
models (`gpt-oss`, Kimi, Qwen, Llama, DeepSeek, Mistral, GLM) are offered to
each harness whose API the gateway advertises for them, under any routing
prefix. A name the rules do not recognize takes its vendor from the routing
prefix (`codex/`, `claude/`, ...). A catalog without endpoint metadata keeps
the older rule, which matches the whole id against the harness's native model
names. With Douane, the core reads `GET /v1/quotas` with the proxy key and
Limits shows native bars, described in [usage](usage.md#gateway-quotas). With
CLIProxyAPI, or a Douane that answers 404 on that route, Limits opens the
dashboard inside Boite instead of the account popup. Desktop uses the shell's
existing browser view, and browsers and phones use an iframe. The dashboard must permit embedding
and its configured URL must be reachable from the device displaying it.
HTTPS browser sessions require an HTTPS dashboard URL; Boite shows this before
creating a blocked HTTP frame. Open dashboard provides a separate sign-in page,
then Reload retries the embedded view. Some gateways refuse framing or restrict
cross-site cookies; those dashboards remain available through Open dashboard.
Show account limits opens the native limits and monitoring switches for agents
that keep their own configuration; Show proxy dashboard returns to the gateway.

Which agents the proxy serves is decided per provider, not per protocol
(`subscriptionProxyServes` in the contract): the Claude and Codex protocols
whole, and OpenCode 2 by its id, because ACP is also what Antigravity and
OpenCode 1 speak, and those keep their own configuration. Grok is served by
its id too, and by Douane alone (`SUBSCRIPTION_PROXY_KIND_PROVIDERS`): behind
CLIProxyAPI it keeps its own sign-in.

Grok moves to the gateway by its environment and stays the same agent. Its CLI
lists the gateway's Grok models itself, from
`GET /v1/models?provider=xai&ids=upstream`: xAI's ids, without the gateway's
prefix, in xAI's order, each row carrying the context window and the efforts
the CLI reads (`context_window`, `reasoning_efforts`). A thread therefore keeps
its model when the proxy is turned on or off, and a session opens on xAI's
default, since the CLI starts on the first model of an endpoint's list. The
core reads no catalog of its own for Grok and adds no model to that list. A
Douane older than these fields lists prefixed ids in alphabetical order, with
no effort and a 256,000 token window for every model. `XAI_API_KEY` carries
the proxy key, `GROK_MODELS_BASE_URL`, `GROK_XAI_API_BASE_URL` and
`GROK_CLI_CHAT_PROXY_BASE_URL` the gateway, so the key reaches no other host.
Turns carry `x-douane-provider: xai` (through `GROK_CONFIG`, the CLI's inline
configuration): the gateway spends the Grok subscription, never another one
that routes a model of the same name. The CLI prefers a stored sign-in to a
key and would send that token to the gateway, so `GROK_AUTH_PATH` points it at
`<dataDir>/subscription-proxy/grok-auth.json`, which nothing writes: the CLI
finds no sign-in, and the account's own stays for when the proxy is off. This
was measured on Grok CLI 1.0.46, where `GROK_AUTH_PATH` is not documented.

OpenCode 2 does not move to the gateway, it gains it: the core adds one
provider to OpenCode's inline configuration, named after the gateway's kind
(`douane` or `cliproxyapi`), which calls the gateway's Chat Completions route
(`@opencode/ai/providers/openai-compatible`, `settings.baseURL`, the key read
from `BOITE_SUBSCRIPTION_PROXY_KEY`). OpenCode's own providers stay beside it.
The picker lists OpenCode's own models first, then the gateway's as
`douane/<gateway id>`: every model but those with a harness of their own, so
no Claude, GPT or Grok model, and Gemini, Muse and the open families. A custom
provider only knows the models its configuration names, so the core keeps the
last catalog it read (the journal setting `subscription-proxy-opencode-models`)
and writes it into that block at every spawn; a restart starts a turn on a
gateway model without probing first. While the proxy is on, the gateway is the
login: an OpenCode 2 account reads `ok` with no sign-in of its own. OpenCode 2
lists none of an injected provider's models in its ACP model option and still
takes them, and for about half a second after `session/new` it refuses one it
has not loaded yet: the driver sends a model under the injected prefix
(`BOITE_SUBSCRIPTION_PROXY_PREFIX`) though it is not listed, and asks again
after 250, 500, 1,000 and 1,500 ms before it warns.

An optional API key stays on the core and is supplied through the agent's
environment, never a URL or process argument. Leave the key field empty to keep
a saved key, or select Remove saved key. Configuration and key changes are saved
in one transaction. Use HTTPS when sending a key over an untrusted network;
HTTP remains available for local and private-network gateways. Dashboard management credentials belong
to the dashboard's own sign-in and are not passed by Boite.

Claude calls the gateway's Messages API. Codex uses its Responses API with
WebSocket support enabled. Codex owns the conversation identifier and prompt
cache key, retaining them between turns and after a socket reconnect; Boite
does not override those headers. Cache-read token counts reported by the agent
remain visible in usage. Disabling the proxy restores the local accounts,
native login checks, model discovery and subscription quota monitoring. Other
agents use their existing configuration.

A provider descriptor configures an agent for an existing driver. Adding an ACP
provider can use JSON alone; adding a new protocol requires runtime code. Shipped
descriptors live in
`packages/core/src/providers/shipped/` and are read-only; a user drops their own
under `<dataDir>/providers/*.json`. The types are in the contract, the loader in
`packages/core/src/providers/loader.ts`, the field checks in `validate.ts`, the
load-time tokens in `expand.ts` and executable resolution in `resolve.ts`, all
beside it. Runtime behavior belongs to the corresponding modules under
`packages/core/src/drivers/`; this page describes their supported behavior.
Shipped descriptors and dependency manifests own version pins.

A descriptor loads or is refused with the file, the field and what was expected.
An unknown field is a refusal, a user file may not take a shipped id, and `roots`
is checked before anything else. `providers.dryRun` validates a file and prints
the plan without writing anything.

## The fields

OpenCode's descriptor, with the `linux` and `macos` profiles, `shared` and
`hookSources` left out:

```json
{
  "id": "opencode",
  "schemaVersion": 1,
  "name": "OpenCode", "shortName": "OpenCode",
  "protocol": "acp",
  "roots": ["{home}/.local/share/opencode", "{home}/.config/opencode", "{isolationDir}"],
  "profiles": {
    "windows": {
      "detect": {},
      "executable": [
        { "kind": "file", "value": "{agentsDir}/opencode.exe" },
        { "kind": "file", "value": "{npmRoot}/opencode-ai/bin/opencode.exe" },
        { "kind": "path", "value": "opencode", "major": 1 }
      ],
      "launch": { "args": ["acp", "--port", "0"] },
      "isolation": { "XDG_DATA_HOME": "{isolationDir}", "XDG_CONFIG_HOME": "{isolationDir}" },
      "close": { "processes": ["opencode.exe"] }
    }
  },
  "auth": { "kind": "oauth-cli", "session": ["opencode/auth.json"] },
  "login": { "command": ["opencode", "auth", "login"], "terminal": true },
  "models": [{ "id": "default", "name": "OpenCode default", "default": true }],
  "capabilities": { "approvals": true, "hooks": true, "checkpoint": false, "images": false, "planMode": false, "resume": true }
}
```

- `id` is the key everything refers to, and a user descriptor may not reuse a
  shipped one. `schemaVersion` is `1` and is checked. `name` and `shortName` are
  what the picker and the chips show.
- `protocol` picks the driver: `claude-sdk`, `acp`, `codex-appserver`, `muse`,
  `pi`, `agy` or `echo`. OpenCode uses `acp`. A protocol with no driver behind it has nothing to run,
  so it is the one field that cannot be invented.
- `roots` bounds core-owned provider file access. Paths outside them and `..`
  segments are refused. It is not an OS filesystem sandbox for the agent.
- `profiles` holds one `OsProfile` per operating system, keyed `windows`, `linux`,
  `macos`. A provider with no profile for the running OS is not offered.
- `auth.kind` is `oauth-cli`, `api-key` or `none`, and `auth.session` names the
  files inside the isolation directory that carry the login, which is what the
  core reads to tell `ok` from `unauthenticated`. `auth.sqlite` is the same
  question for an agent that keeps its sign-ins in a database: a `file` inside
  the isolation directory and the `tables` that hold them. The account reads
  `ok` once one of those tables has a row, `unauthenticated` while none does or
  the file is not there yet, and `unknown` when the file will not open. The
  core opens it read-only and never writes it. `auth.identity` says where the
  account name comes from.
- `login` is either `command`, the argv of the provider's own login command plus
  an optional `env`, or `acp: { methodId }`, the `authenticate` method of an ACP
  agent whose sign-in has no command. `terminal: true` beside a `command` runs it
  in a real shell the user answers, for a login drawn as a menu
  ([accounts.md](accounts.md#signing-in-from-a-terminal)); it is refused on an
  `acp` login. A provider without one cannot be logged in
  from Boite; its account controls show the refusal.
- `models` is a `ModelInfo` list: `id`, `name`, an optional `default`, `legacy`
  (still accepted, folded away in the picker), `badge: "new"`, and an `effort`
  block of named levels with a default. A native agent may declare an empty list
  and let the probe supply its catalog. The unnamed `default` alias remains
  accepted for existing descriptors. Echo requires at least one static model.
- `experimental: true` marks an agent Boite drives without long use behind it.
  It stays off until the user turns it on ([below](#turning-a-provider-off)),
  and its row on the Providers page carries an Experimental badge.
- `capabilities` is six booleans: `approvals`, `hooks`, `checkpoint`, `images`,
  `planMode`, `resume`. `approvals: false` means the thread's permission mode
  never reaches that agent, and the UI stops promising a gate that does not exist.
  `hooks: true` says the agent runs hooks of its own, which is what lets the
  descriptor name `hookSources` and puts the agent in Settings > Brain > Hooks.
  `images: false` refuses a turn's image attachments before anything is sent, so an unsupported image cannot reach the provider. Where `images` is
  true, each protocol hands an attachment over in its own shape: the Claude
  driver turns the prompt into a content-block array, one text block plus one
  `{ type: 'image', source: { type: 'base64', media_type, data } }` block per
  attachment; ACP sends a `{ type: 'image', mimeType, data }` block alongside
  the text block of `session/prompt`, but only once the agent's `initialize`
  answer says `agentCapabilities.promptCapabilities.image` is true, or the turn
  fails before anything goes out; Codex appends one
  `{ type: 'image', url: 'data:<mimeType>;base64,<data>' }` entry per attachment
  to `turn/start`'s `input`; Muse appends one
  `{ type: 'image', base64Data, mediaType }` part per attachment to its own
  `turn/start` `input`; pi adds an `images` array of
  `{ type: 'image', data, mimeType }` entries to the `prompt` command.

A thread's `/commands` come from wherever the protocol says an agent lists its
own, never from the descriptor: `commands(list)` on `TurnContext` carries the
whole list each time a driver learns or relearns it, and the core dedups and
tells the clients only on a change. Claude reads `Query.supportedCommands()`
once the CLI is up and takes a `{ type: 'system', subtype: 'commands_changed' }`
message on top of it for a mid-session change. ACP takes a `session/update`
whose `sessionUpdate` is `available_commands_update`, which an agent may send
right after `session/new` or `session/load`, before any turn; the driver keeps
the thread's latest `TurnContext` outside the running turn for exactly that
window, since the update carries no turn of its own to report through. pi asks
once per process, right after it comes up, with the `get_commands` RPC
command. Codex has no such listing in the app-server protocol the driver
speaks, so `codex.ts` reports none, and `muse.ts` reads none from Muse's
session protocol either.

## Inside an OS profile

- `detect` is `{ command }` or `{ file }`. A provider whose detect does not
  resolve reports unavailable rather than failing at spawn.
- `executable` is an ordered candidate list, first hit wins. `kind: "file"` is
  an exact path and `kind: "path"` a name looked up on PATH. On Windows a PATH
  lookup passes over `.cmd`, `.bat` and `.ps1` launchers to the next PATH
  directory holding a real program of that name, and misses when there is none:
  the drivers spawn through node, which refuses a launcher script with EINVAL,
  so the agent reads as not installed and its row offers the install instead.
  A turn started on it is refused with the launcher script's path, so the
  reason is on screen rather than a bare "not available".
  A profile that names a launcher script as a `file` candidate keeps them, as
  Muse Code does, since its driver maps its launcher to its program. `kind: "npm"` names
  a globally installed package, `@scope/name#bin`, for the agents npm installs
  as a `.cmd` shim Bun cannot spawn. The core looks for the package under the
  npm prefix (`npm_config_prefix`, `%APPDATA%/npm`, the directory of `npm`,
  `node` or the bin on PATH), pnpm's and Bun's global directories and the usual
  Unix prefixes. It reads the bin script from the package's own `package.json`
  and runs it with the Node installed beside that prefix, else Node on PATH,
  else Bun. The script goes first on the command line, before `launch.args`, and
  the summary shows the script as the executable. Only the `pi` and `acp`
  protocols take an `npm` candidate: the SDK and app-server drivers spawn the
  program with no leading argument.
- A `path` or `file` candidate may name a `major`. It then counts only when
  the program found there reports that major version, read with the profile's
  `update.versionArgs`, `--version` by default. Two majors of one agent can
  install under one name: `opencode` on PATH is OpenCode 1 or OpenCode 2, and
  each has a descriptor of its own. A program at another major is passed over
  for the next candidate. The reading is kept per program path, with the size
  and modification time of its file, in `<dataDir>/executable-versions.json`,
  so asking costs one run of the program per install and none at a restart.
  Until a program has answered, the profile resolves to nothing rather than
  to a later candidate; the answer lists the providers again and
  `providers.updated` follows. Whoever must know what is installed right now
  waits for it, five seconds at most: `providers.list`, `providers.reload`,
  the turns a restart hands over, and the version read after an update, whose
  updater has just rewritten the program. A program that could not be run is
  passed over for the candidate behind it and asked again a minute later. A
  provider that is turned off is listed from what is already known and its
  program is never asked; turning it on asks it. A launcher script that
  stays the same while the program behind it changes is covered by one check
  per run of the core, at the first resolution half a minute or more after the
  reading is first used, and by another after an agent update. A program
  stopped at its 20 second deadline has given no answer: it is passed over and
  asked again, never recorded as having no version. An `npm` candidate takes no `major`: it
  already names its package (`packages/core/src/providers/versions.ts`).
- A `file` candidate that starts with `{npmRoot}` is looked for under each
  global npm `node_modules` directory, the same list an `npm` candidate walks,
  with the profile's `path` names as the bin hints. That is how Codex and
  OpenCode find the program their npm package vendors under nvm-windows, fnm,
  scoop or a custom prefix, where the shim on PATH is a `.cmd`. The token is
  expanded at each resolution, not at load, and only at the start of a `file`
  value.
- A PATH lookup, for a candidate, a `detect.command` or the npm roots, is
  remembered for 30 seconds per name and PATH, so the provider list and each
  turn start do not walk PATH again. A remembered program that is gone is looked
  up again. A reload, a managed install or uninstall and an update forget every
  lookup; a program installed outside Boite shows up within 30 seconds, or at
  once on a reload.
- `launch.args` put the agent into the mode Boite speaks to. The `agy` driver
  adds its print-mode flags itself, because the same binary also answers
  `agy models` for the probe, so the Antigravity CLI declares none; anything a
  descriptor puts there goes first on both command lines.
- `isolation` is the environment that makes one account blind to the others, with
  `{isolationDir}` substituted per account at spawn ([accounts.md](accounts.md)).
- `close.processes` names what the core closes when an account is removed, and is
  empty for an agent running under `node`: the process in the job is `node`, not
  the agent. `install` is the optional managed release, below.

An `update` block says how the user's own install updates itself; see
[agent updates](agent-updates.md).

## Hooks and shared configuration

Three optional descriptor fields carry the user's own configuration to isolated
accounts and tell Settings where the agent's hooks are ([hooks.md](hooks.md)).
Codex's:

```json
"shared": [{
  "variable": "CODEX_HOME",
  "paths": ["config.toml", "hooks.json", "AGENTS.md", "skills", "rules", "prompts", "plugins"],
  "retarget": { "config.toml": ["hooks.json", "config.toml"] }
}],
"hookSources": [{ "variable": "CODEX_HOME", "path": "hooks.json", "format": "events" }]
```

- `shared[].variable` is an isolation variable of the profile. Each path is
  relative to the directory it names: for the default account, the user's own
  (`~/.codex`); for an isolated one, the account's. At every spawn a directory
  there is linked and a file is copied ([accounts.md](accounts.md#what-an-isolated-account-shares)).
- `retarget` maps a copied file to the shared paths whose absolute location it
  may spell. The copy has each spelling (raw, forward slashes, doubled
  backslashes) rewritten to the account's own path. Codex needs it for
  `config.toml`, which keys each hook's trust by the path of `hooks.json`.
- `hookSources[]` is a place the agent reads hooks from, with the same
  `variable` and relative `path`, or no variable and a path starting with `~/`,
  for a file another agent owns: Grok reads Claude's `~/.claude/settings.json`.
  `format` is `events`, a JSON file or directory of them shaped like Claude's
  `hooks` block, or `modules`, a directory of plugin scripts.
- `sharedKeys[]` names top-level keys of a JSON file the account keeps as its
  own, set from the user's copy before every spawn. Claude's user-scope MCP
  servers live under `mcpServers` in `.claude.json`, beside its sign-in
  identity, so that file is never copied whole:
  `{ "variable": "CLAUDE_CONFIG_DIR", "path": ".claude.json", "home": "~/.claude.json", "keys": ["mcpServers"] }`.
  The user's file is `path` under the variable when the core's environment sets
  it, else `home`, else `path` under the variable's default.

A share or a source is refused at load when a path is absolute or has a `..`,
`.` or empty segment, when no profile isolates its variable, when a share's
variable is set outside `{isolationDir}` by any profile, when a `retarget`
entry names something outside `paths`, or when a shared path covers or sits
inside a file the account keeps to itself: `auth.session`, a profile's
`session` or a `seedFiles` entry. That is why OpenCode, whose config and data
homes are the same directory, lists `opencode/opencode.json` and its siblings
one by one and never `opencode`, which holds `opencode/auth.json`.
`hookSources` also needs `capabilities.hooks`. A `sharedKeys` file obeys the
same limits as a shared path, and needs at least one key and a `home` under `~/`.

The [account sharing guide](accounts.md#what-an-isolated-account-shares)
lists shipped configuration paths and link/copy behavior. [Hooks](hooks.md)
lists hook sources, reporting and probe exclusions.

## The tokens

Four expand when the descriptor loads, in `roots`, in every executable candidate,
in `launch.args` and in a profile's `env`. `{home}` is the home directory,
`{appdata}` the Windows roaming per-user directory, `{agentsDir}` is
`<dataDir>/agents/<providerId>/current`, where a managed install puts its files
(it resolves to a path that does not exist until they land, which is what makes
such a provider read as absent), and `{browserNoop}` is the launcher that does
nothing, for a `BROWSER` variable. A fifth, `{shippedDir}`, points at the shipped
descriptor folder, so a shipped login command can name a script beside it.
`{isolationDir}` is separate: it is per account and substituted
at spawn, in the `isolation` map and in a login command's `env`.

The driver adds model, effort and permission arguments; they are not descriptor
tokens. The `agy` driver
builds the whole print-mode line itself (below). Grok needs it for the permission
mode alone: the `grok` quirk splices
`--permission-mode <mode>` before the `agent` subcommand, or `--always-approve`
after it, on the way to the spawn. A probe has no thread, so it launches the
declared line as it is.

## Managed installs

An `install` block is how Boite ships an agent whose binary is not on the machine
and which has no installer of its own: a `version` (letters, digits and `. _ + -`,
since it names the release directory), a zip `url`, its `sha256`, its
`archiveBytes`, and every `files` entry expected out of the archive with its exact
size, the first one the executable.
Additional executable files declare `executable: true`; the installer gives
those files execute permissions on Linux and macOS. An optional `arch` field
names `x64` or `arm64`. A mismatched archive stays visible with an explanation
and is refused before downloading. Antigravity's pinned archives support x64
on Windows/Linux and ARM64 on macOS.

`format` defaults to `zip`. A `binary` download installs one executable directly;
its single `files` entry must have the same size as `archiveBytes`. Both formats
verify the download's length and SHA-256 before making it available. Claude on
Windows uses the official x64 binary this way. Its managed copy lives under
Boite's data directory, without replacing a CLI installation elsewhere.

Codex and OpenCode ship a Windows x64 release the same way, from their GitHub
releases; the Codex archive also carries `codex-command-runner.exe` and
`codex-windows-sandbox-setup.exe`, unpacked beside the agent as upstream ships them. The
managed copy is the first executable candidate, so an update reaches the agent
Boite runs even when an npm copy exists. `test/shipped-installs.live.test.ts`,
opt-in behind `BOITE_E2E_INSTALLS=1`, downloads both and runs `--version`.
Muse Code ships the same way on Windows x64, as the single binary Meta's own
installer downloads (`format: "binary"`, pinned with its SHA-256). The official
installer puts a `muse.cmd` launcher on PATH instead, which Bun cannot spawn, so
the driver reads `.muse-version` beside it and runs the `muse-bin-<version>.exe`
it names; a launcher with no such binary beside it is refused with a sentence
saying to install Muse Code from Providers.
Grok and pi have no archive Boite can pin, so their row links to the agent's own
install guide.

Settings > Providers offers the next install or sign-in step. Install adopts
an existing CLI login before `providers.updated`; otherwise it continues to
sign-in. Cancellation or leaving the page cancels that continuation. Returning
to the window checks for external installs. Provider families can group multiple
descriptors in one row. [Accounts](accounts.md#the-guided-connection) describes
the guided connection and account controls.

`providers.install` streams the archive to
`<dataDir>/agents/<id>/downloads/<version>.zip.part`, hashing as it writes, and
refuses a wrong digest or a wrong length naming both values. It unpacks with a
streaming unzip into `releases/<version>/`, so no member is held whole in memory:
an entry that is absolute or carries a `..` segment is refused by name, a member
the descriptor does not list is skipped rather than written, and each listed file
is checked against its size once it is out. Then `current` is repointed, a
junction on Windows and a symlink elsewhere, and `.install-complete.json` is
written beside the files: that record, with its version matching the descriptor's,
is the only thing that makes a provider read as `installed`.

A bad connection does not start the download over. A dropped connection, a
server answer of 408, 429 or 5xx, or 30 seconds without a byte ends one attempt,
and the download tries again after 1, 2, 4, 8 and 16 seconds. Each retry asks
only for the missing bytes (`Range`, with `If-Range` carrying the server's ETag
or date); a server that sends the whole file again is read from the start. Once
the retries run out the install fails with how far it got, and keeps the `.part`
beside a `.part.json` naming its URL and digest. The next install of the same
archive hashes those bytes again and resumes after them. A body longer than
`archiveBytes`, or a `Content-Length` that disagrees with it, is refused at once.

Free space is checked first, against the archive plus the unpacked files plus a
256 MB margin, less what a kept `.part` already holds. A cancel aborts the fetch
and leaves no `.part`. Nothing goes into the journal, so a core that stops
mid-download comes back saying `absent`, and its `.part` stays for the next
install to resume.
`providers.uninstall` deletes `<dataDir>/agents/<id>` and is refused while a lease
is held, and one is held for every process a thread, probe or login launched.

An update installs the new release beside the old one and repoints `current`.
The old release is deleted as soon as no lease is held: right after the update,
or when the last process of that provider ends. A core that starts also deletes
every release `current` does not point at, and every download except the `.part`
of the version the descriptor pins. A file Windows still holds is logged and
left for the next of those moments.

## What ships

Ten descriptors ship, and only the first nine are ever visible to a user: `echo`
is the deterministic fake the tests and the bench run on, loaded only under
`BOITE_ECHO=1`.

| Provider | Protocol | Launch |
| --- | --- | --- |
| Claude | `claude-sdk` | SDK-driven CLI |
| OpenCode | `acp` | `opencode acp --port 0` |
| OpenCode 2 | `acp` | `opencode2 acp`, experimental and off until turned on |
| Antigravity | `acp` | Managed `agy_acp_server` for the host OS |
| Antigravity CLI | `agy` | `agy --input-format stream-json --output-format stream-json -p=` |
| Grok | `acp` | `grok [permission flags] agent [approval flag] stdio` |
| Codex | `codex-appserver` | `codex app-server` |
| Muse Code | `muse` | `muse serve --trust-workspace [mode flags]` |
| pi | `pi` | Package bin through Node or `pi --mode rpc` |
| Echo | `echo` | In-process fixture |

[Accounts](accounts.md#the-isolation-directory) owns isolation variables,
session-file locations and login behavior. Descriptor model lists are fallbacks;
native probes supply account-specific models and capabilities. Windows npm
shims require a vendored binary or supported `npm` candidate. Managed desktop
versions are pinned in `packages/core/src/providers/shipped/*.json`; server image
CLI versions are separate pins in `docker/agents/package.json`.

Antigravity requires a managed install and always-isolated accounts. Its
descriptor uses additional fields available to other providers:

- `env`, on an OS profile, is environment every process of the provider gets,
  whatever its account, unlike `isolation`. Antigravity uses it for the harness
  path and for a `BROWSER` pointed at `{browserNoop}`, a launcher that exits 0
  which the core writes once under the data directory, so the agent never opens a
  window on its own.
- `unsetEnv`, on an OS profile, names variables taken out of the inherited
  environment before the spawn, so a key the user set for their own tools cannot
  redirect the agent Boite runs.
- `session`, on an OS profile, replaces `auth.session` on that OS. An empty list
  says the login can live outside any file there: the `auth.session` files still
  read `ok` when present, and without them its accounts read `unknown` and turns
  still start. A CLI that is signed out reads `unknown` as well, so its default
  account is adopted instead of leaving room for the guided sign-in. Claude's
  macOS and Windows profiles set it. Claude Code keeps its login in the macOS
  Keychain, and writes `.credentials.json` only when the Keychain is out of
  reach. On Windows, Claude Code moves the login from `.credentials.json` into
  Credential Manager once the `tengu_windows_credman` flag, cached in Claude
  Code's config, turns that storage on; the move happens at the CLI's next
  start. Without the empty list, an account that read `ok` would read
  `unauthenticated` after that move and every turn would be refused, though the
  CLI stayed signed in.
- `seedFiles`, on the descriptor, maps a relative path to content written under
  the isolation directory before anything starts. Antigravity needs
  `antigravity-acp/settings.json` holding `{"auth":{"type":"oauth-personal"}}`.
- `login.acp.methodId` is the other shape of the login block: instead of a
  command, the core starts the agent itself, sends `initialize` then
  `authenticate` with that method, and forwards the sign-in link the server
  prints. The redirect URL pasted back is fetched once by the core, which is how
  a phone finishes a sign-in whose loopback listener runs on the core's machine.
  The paste is checked against the `redirect_uri` of the link the agent printed,
  same port and same path, so the fetch lands on the agent's listener and
  nowhere else on the machine. [accounts.md](accounts.md) has the flow.

`quirks` turns on a dialect the ACP driver knows, and there are two.
`quirks: ["antigravity"]` folds a tool call's command, working directory and
output under one spelling and draws an `interaction_` permission request as the
agent's own question; its modes are `default`, `auto_edit` and `yolo`, with no
plan mode. `quirks: ["grok"]` selects Grok behavior
(`packages/core/src/drivers/grok.ts`). Text sent while a prompt runs, an
asynchronous answer or a coordination message, goes out as Grok's
`_x.ai/interject { sessionId, text }`, which joins the running turn at its next
tool or model gap. It is sent only while the prompt is in flight, since an
idle Grok runs the text as a turn of its own; an agent that refuses the method,
Grok before 1.0.41, keeps the text for the next turn. The probe reads each model's own effort
scale out of its `_meta.reasoningEfforts`, which is where Grok writes a per-model
scale. The thread's model and effort go out as one
`session/set_model { sessionId, modelId, _meta: { reasoningEffort } }` right
after the session opens, never as a `session/set_config_option`, which Grok
answers with method-not-found; the call is skipped when the thread is on the
agent's own model with no effort set, and skipped again when the session answer
already reports that model and that effort. And the permission mode rides on the
command line, because Grok advertises no `availableModes` for a
`session/set_mode` to match: `default`, `acceptEdits` and `plan` become
`--permission-mode <name>` before the `agent` subcommand, `bypassPermissions` and
`dontAsk` become `--always-approve` after it. A mode is fixed for the life of the
process, so it joins the session key the way Codex's approval pair does and a
change drops the process. Nothing ever sends `authenticate` to Grok: an account
with no `auth.json` is refused before a turn starts, and `authenticate` on an
empty home opens a browser.

An ACP thread resumes its session with `session/load` when the agent
advertises `loadSession`. When the agent refuses that load while its process is
alive, what the refusal says decides. -32002 (resource not found), a missing
`session/load` method, or a reason that names a missing session means the
conversation is gone: the core forgets the session id, starts a new session
generation and runs the same turn again, once, on a fresh session whose prompt
carries the conversation so far. A turn the user stopped meanwhile stays
stopped. -32000 (authentication
required) and -32800 (cancelled) leave the session alone: the turn fails with
the agent's reason and the next turn loads the session again. Any other error,
such as an internal one, keeps the session the first time; the same session
refused that way on the next load too counts as gone, since OpenCode answers a
missing session with its generic -32603 "OpenCode service failure". An agent
without `loadSession` opens a new session whenever a turn finds no process
holding the thread's session, whatever ended it (the turn itself, the idle
window, an archive, a restart); that turn's prompt carries the conversation so
far, and the log says the agent cannot load a session. Stop sends
`session/cancel` and gives the agent three seconds to end the turn before the
process is dropped; a
stop while the process or the session is still starting drops it at once. An
agent that exits before it answers `initialize`, in a turn, a probe or a login,
fails with its exit code and the last line it wrote to stderr. Stderr is read in
whole lines, a line cut at 64 KB. A tool's text output and a markdown document
are cut at 64K characters with a note saying where, and a diff whose two sides
pass that size is drawn as a sentence giving its size.

## OpenCode 2

OpenCode 2 is another program than OpenCode 1, published as `@opencode/cli`
beside `opencode-ai`, and its descriptor `opencode-v2` ships beside `opencode`
as an experimental provider. Both speak ACP to the same driver. What the
descriptor accounts for, each point read off OpenCode 2.0.24 on Linux:

- The two install under one name. The npm package and the installer both put
  a program called `opencode` on the machine, where OpenCode 1 already is, and
  add `opencode2` beside it. So `opencode-v2` looks for `opencode2` first, then
  for the npm package's own binary, and takes a program called `opencode` only
  at major 2. `opencode` takes it only at major 1, and falls back to the
  `opencode-ai` package's own binary when the name on PATH went to version 2.
- `opencode acp` takes no `--port`: version 2 refuses the flag and exits.
- Its own subagent tool is denied, as version 1's `task` is, since delegation
  goes through Boite. The profile's `env` sends it in version 2's syntax, a
  `permissions` rule on the `subagent` action, as `OPENCODE_CONFIG_CONTENT`.
- A sign-in is a row of `opencode/opencode.db`, in its `credential`, `account`
  or `control_account` table, which `auth.sqlite` names. Version 2 never reads
  version 1's `auth.json`: each is signed in on its own, even on the default
  account, whose folder the two share. The same database holds the sessions of
  both. Version 2 loads a session version 1 created; version 1 answers -32603
  to one version 2 created, so a thread moved to version 2 stays there.
- Every command but `acp` talks to a background service that outlives it and
  listens on one fixed port, so a second account could never start its own.
  Boite never starts it: turns and probes run over `acp`, which serves itself,
  and the login command is `opencode2 auth login --standalone`.
  `XDG_STATE_HOME` is isolated under `{isolationDir}/state`, beside the XDG
  pair OpenCode 1 isolates, so a command typed by hand in the login terminal
  registers its service in the account's folder and not in the user's.
- OpenCode Go usage is read with the key version 2 stored for `opencode-go`
  in the `credential` table (`packages/core/src/providers/opencode.ts`).
- The plugin API changed: a plugin written for version 1 does not load in
  version 2. The descriptor shares the same `opencode/plugins` folder with an
  isolated account and Settings counts what is in it, whatever it was written
  for.
- It has no managed install: version 2 is published as npm tarballs, a
  format the installer does not unpack, so its row links to the install guide.

`test/opencode2.live.test.ts`, opt-in behind `BOITE_E2E_OPENCODE2=1`, turns the
provider on, runs a turn, resumes it on a new process and moves the session to
`plan`. Behind a [subscription proxy](#subscription-proxy) it was run against a
local stand-in for the gateway, which received the turn on its Chat
Completions route with the key and the gateway's own model id; no turn went
through a real Douane or CLIProxyAPI. Not verified either: Windows and macOS,
an OAuth sign-in, and image attachments, which is why `capabilities.images` is
false.

## Turning a provider off

Every provider has a switch on the Providers page, for a machine that has
more agents installed than its user wants offered. `providers.setEnabled`
stores the choice per core, in the journal setting `provider-switches`, and
each summary carries it as `enabled`. A provider nobody touched follows its
descriptor: on, or off when it is `experimental`.

Off, nothing of that provider starts. A turn, a model probe and
`threads.capabilities` go through the same gate as a missing agent
(`assertDriverRunnable`) and answer with a sentence saying where to turn it
back on, and the capability reason `provider-disabled`. A sign-in and a banked
reset are refused the same way, and a connection check reads the login files
without starting the agent. The update check skips it, its program is not
even asked its version, its usage is not read, no title is written on it, a
delegated agent cannot be routed to it and no default account is adopted for
it. Its warm processes
are released at once; a turn already queued or running ends by itself.

Nothing is removed. Accounts, threads, the managed install and the user's own
install stay as they are, and turning the provider back on adopts an existing
login the way a fresh install does. The page lists the off providers last,
dimmed, under Turned off, with no install or sign-in step; a row that holds
two providers, Antigravity and its CLI, has one switch per provider inside
it. The clients hide an off provider from every list that offers one, the
model picker included, and a thread that was on it shows a Turned off chip in
its composer. The method is the owner's: a paired device reads `enabled` and
cannot change it.

## The Antigravity CLI

`antigravity` is the managed ACP server with isolated logins.
`antigravity-cli` runs an already installed and signed-in `agy` from PATH or its
Windows installation path. Both appear in one provider family. agy's system
keyring token and `~/.gemini/antigravity-cli` settings cannot be relocated, so it
supports only the default account. A signed-out model probe asks the user to
sign in through agy's terminal.

Turns, probes and usage reads set `AGY_CLI_DISABLE_AUTO_UPDATE=true` to prevent
a detached updater from opening a console. The explicit updater leaves it unset.
`BROWSER={browserNoop}` also prevents automatic browser windows.

The driver and `drivers/agy/` modules use
`--input-format stream-json --output-format stream-json -p=`. The empty value
is required; bare `-p` consumes the next argument. Each prompt is one stdin JSON
line with `event: 'user'` and a user message. `init` supplies `conversation_id`,
`step_update` streams text or tools by `step_index`, and `result` completes the
turn. `result.status: 'ERROR'` fails with its message. Usage sums that turn's
steps, counting thinking as output; the last answer feeds the context count
without a reported window.

A new process resumes through `--conversation <id>`. Model, effort and mode are
launch flags in the process key; changing them reopens the same conversation.
A positive `warmProcessMinutes` keeps the process between turns. Otherwise stdin
closes and exit has eight seconds; a following turn waits. Stop ends the
registered process tree or POSIX group, subject to [trace limits](trace.md#linux-and-macos).
Stop during model discovery sends no prompt. Print mode refuses `/compact` and
other interactive-only commands.

## The models probe

`providers.probe` spawns one short-lived process under the synthetic thread
`probe:<providerId>:<accountId>`, exactly the way a session would, so it sits in
a Job Object and in the trace like any other, then asks the protocol's own
question:

- Claude: SDK `supportedModels()` without a user prompt, with
  `settings.disableAllHooks` so no `SessionStart` hook fires. Effort levels, adaptive
  thinking and Fast support come from each returned model. Descriptor effort
  controls stay hidden until that account has answered.
- ACP: `initialize` and `session/new`, then whichever of two answers the agent
  sent. `models.availableModels` wins when it is there: each entry is a model of
  its own, and under the `grok` quirk it carries its own effort scale out of
  `_meta.reasoningEfforts`, the level flagged `default: true` the one preselected.
  Otherwise the `configOptions` whose category is `model` and `thought_level` are
  read. That effort scale describes only the current model, so Boite does not
  copy it to other models. An agent that sends neither leaves the descriptor's
  models standing. OpenCode names a model's `thought_level` only once a session
  is on that model: `providers.probe` takes an optional `model`, selects it with
  `session/set_config_option` in a fresh probe process and reads the scale the
  answer carries. One read per model is cached with the list, the composer asks
  for the model it lands on, and a failed read keeps the list already cached.
  A model's scale is read once, even when the agent names none for it. The
  config options a turn's own `session/new` or `session/load` answers are kept
  for the account too, so a later process that resumes a session seeds its
  controls from them instead of opening a discovery `session/new` every time.
- Codex: `initialize`, the `initialized` notification, then `model/list` until no
  cursor comes back. Each model carries its own efforts and its own default, so
  two models on one account can offer two different scales. `serviceTiers` supplies
  speed choices without adding unlisted tiers. It answers before
  any login, so an unauthenticated account is no reason to skip the probe.
- Muse: `initialize`, `initialized`, then `model/list`, on a host started with
  `--no-session-log --disable-write --disable-shell` so a probe can neither write
  nor leave a session behind. Only models routed to `meta` are kept. `model/list`
  carries no efforts, so each model's tiers come from the catalog Muse caches
  under the `museHome` its `initialize` answer names
  (`model-catalog/*.json`, rows of the same profile with
  `reasoning_effort_variants`); a model the catalog does not describe gets
  `low` to `max` with `high` preselected, which is Muse's own default. A host
  that is not signed in lists nothing, and the descriptor's models stand.
- agy: `agy models`, one `id<TAB>label` line per model. agy lists
  reasoning variants as separate IDs, so two or more variants of one base become
  one model
  whose effort scale is those variants, `medium` preselected when it is there.
  The thread's model and effort then go out as the one id agy knows,
  `--model <base>-<level>`. A variant alone, and an id without a level
  suffix, stays as listed.
- pi: `get_state`, `get_available_models` and `get_available_thinking_levels`.
  Each model id carries its provider prefix, because that is what pi's `--model`
  takes and two providers can ship a name. An unauthenticated pi answers with
  nothing, so the descriptor's models are left standing rather than replaced by an
  empty list.

The child is killed through the registry on every path. The answer keeps the
descriptor's `default` first, so the choice can always go back to the agent, is
cached per provider and account until a `providers.reload` that changes a
descriptor, what one resolves to or a rejection, or a change to that
account, and reaches every client as `providers.probed`. A reload that changes
none of that emits no `providers.updated`. Two callers at once share
one process. `refresh: true` bypasses a completed cache entry, sharing any probe
already in flight. The UI keeps a persistent display cache and reads asynchronously.
Cleanup starts the registry's bounded stop before waiting for process pipes to
close. A missing close event gets one additional second, then a
`provider.probeCleanup` warning. The original models or discovery error still
reach the caller, and the next request for that account can proceed.
A probe that finds no executable, whose agent dies or that runs past
twenty seconds, thirty for pi, throws with the reason and caches nothing. `threads.create` and
`threads.update` accept what the last probe listed on top of the descriptor's; a
model nobody probed is refused, saying to open the picker.

A probed scale lives in memory. After a core restart a thread may carry an
effort whose scale is not read yet: `turns.start` lets it through, because it
was checked when it was chosen, and refuses only an effort missing from a scale
that is known.

## Permission modes

Boite has six: `default`, `acceptEdits`, `plan`, `bypassPermissions`, `yolo`, `dontAsk`.
Drivers translate them according to their protocol capabilities.

YOLO is separate from Auto (`bypassPermissions`). It selects the agent's most
permissive execution mode and automatically accepts tool approval requests that
still reach Boite, without a permission card. Claude runs with
`bypassPermissions` and `disableAllHooks: true`, disabling configured and plugin
hooks while retaining Boite's SDK callbacks for tool reporting and incoming
answers. Codex runs with approvals set to `never`, full filesystem access and
`features.hooks=false`. Claude applies the hook setting live; Codex replaces
its process,
so turning it off restores the user's hook configuration. No settings file is
rewritten. ACP and Muse use their native unrestricted mode and Boite accepts
remaining approval requests; ACP has no standard hook-disable call. Antigravity
uses its permission-skip flag. Questions seeking input still ask for real
answers; YOLO does not invent form values or complete a device sign-in.

- ACP standardises the call, `session/set_mode`, and standardises none of the ids
  inside `availableModes`: the same mode is spelled `acceptEdits`,
  `accept_edits` and `auto_edit` by three different agents. So each Boite mode
  carries an ordered candidate list matched without case, `_` or `-`, and the
  first spelling the agent lists wins. It goes out when the session opens and
  again at the start of any turn the agent has drifted from, and it is
  deliberately not part of the session key, so a warm session follows a change
  instead of being dropped. An agent that lists no modes or refuses the call is one
  warning in the log while the turn runs anyway: a mode is a preference, never a
  reason to refuse a turn. An agent may list its modes as a config option of
  category `mode` instead, with no `availableModes` at all, which is what
  OpenCode does with `build` and `plan`: the same candidates are matched
  against that option's values and the mode goes out as a
  `session/set_config_option`. A change the agent makes on its own reaches
  Boite as a `config_option_update`, which refreshes the kept value so the
  next turn puts the thread's mode back. Every Boite mode but `plan` ends its candidate
  list on the agent's plain mode (`default`, `build`, `normal`), so a thread
  that leaves `plan` for a mode the agent does not list goes back to the plain
  one instead of staying in `plan`.
- Codex takes a pair when the thread opens, an approval policy and a sandbox:
  `default` and `acceptEdits` are on-request plus workspace-write, `plan` never
  plus read-only, `bypassPermissions` and `dontAsk` never plus danger-full-access.
  No call changes that pair on a running turn, so the mode is part of the session
  key: changing it interrupts and resumes the active turn with the new pair,
  keeping the same Boite turn and conversation.
  Under on-request, a command, a file change, a wider sandbox
  (`item/permissions/requestApproval`, granted for the turn) and an MCP tool
  call each draw a permission card. Codex asks for the MCP tool call through
  `mcpServer/elicitation/request`, as does an MCP server asking a plain yes or
  no; an elicitation that needs a form with required fields, a url or a device
  check has no card yet and is declined, with a line in the log. Stop answers
  an open card with `cancel`, not with the user's refusal.
- Muse splits a mode in two. The approval mode goes on the wire, on
  `session/start` and through `session/setApprovalMode` when the host reports
  another, so a warm host follows it: `default` and `acceptEdits` are
  `promptUnmatched`, `plan` is `denyUnmatched`, `bypassPermissions` and `dontAsk`
  are `allowAll`. The sandbox posture is a host flag, fixed for the process:
  `plan` adds `--disable-write --disable-shell`, `bypassPermissions` and
  `dontAsk` add `--disable-sandbox`. Those flags join the session key, so only a
  change between the three postures drops the process, and the next host resumes
  the session. `acceptEdits` adds one rule of the driver's: a file write inside
  the thread's folder that Muse neither marks `protectedWrite` nor escalated
  through its own judge is approved once without a card.
- agy asks nothing in print mode: whatever its mode does not allow, it denies by
  itself. So the mode is a launch flag and part of the session key.
  `acceptEdits` and `plan` become `--mode accept-edits` and `--mode plan`,
  `bypassPermissions` and `dontAsk` become `--dangerously-skip-permissions`,
  and `default` sends nothing, which leaves agy's own `toolPermission` setting
  in charge.
- pi has no approval call anywhere in its RPC mode, so `capabilities.approvals` is
  false, the thread's permission mode never reaches the agent, and each session
  says so once in the log. A driver that waited for a permission question there
  cannot enforce a permission gate.

The composer offers four of the six and names each by what the agent may do
without asking (`lib/permission-modes.ts`): Ask, Edit freely, Auto and YOLO.
The list follows the agent. Codex loses Edit freely, which is the same pair as
its default, and its default reads "This folder", because workspace-write lets
it edit and run commands there without a card. An agent whose
`capabilities.approvals` is false gets no mode chip: every choice would describe
something it does not do. No confirmation keeps the warning colour on its chip,
since it reaches the whole computer.

A permission is not the only thing an agent asks. A protocol that carries a
free-form question maps it to `askQuestion` on the turn context, which draws a
question card in the timeline and answers the agent with what the user picked;
Codex's `item/tool/requestUserInput` and Muse's `userInput/requested` are the two
that do today. A question is
not a permission mode and is never gated by one: an agent whose approvals are
off can still ask.

An answer can carry files when the question has a free field, as T3 Code's
question attachments do: a screenshot of the bug, a mockup. The card has no
field of its own. While such a question waits, the composer is its free answer,
as in T3 Code: its placeholder and a line above the box name the question, and
Send takes the card's picks with the text and files
(`lib/question-reply.svelte.ts`). Files arrive by the composer's paperclip, a
paste or a drop, with its caps and image reduction, and a file alone is a valid
answer. Ignore on that line sets the thread's questions aside, and the composer
sends ordinary messages again; the card's "Answer in writing" brings it back.
No protocol carries an image in
a question's answer (Claude's `AskUserQuestion` takes strings, Codex's
`requestUserInput` and Muse's `userInput` take text, pi's dialogs a value), so
the core writes each file under `<dataDir>/attachments/` like a prompt's files
and appends their paths to the answer text, with the note prompts use; the
agent reads them with its own tools (Read, `view_image`). The journalled answer
and the card keep only each file's kind, type, name and size, never its bytes
or path. ACP and Antigravity questions offer options only, so they take no files.

## Stdio transport failures

Codex, Muse and pi use `drivers/stdio.ts` for request lifetime and newline
framing; their `rpc.ts` modules retain protocol-specific envelopes. Stdout lines
are bounded to 16 * 1024 * 1024 UTF-16 code units. A final line without a newline
is processed before EOF. Non-JSON or invalid object records produce a fixed
protocol diagnostic without copying their raw output into diagnostic logs.

Oversized stdout, failed reads/writes, closed pipes or a throwing message handler
close the transport and reject all pending requests once. The session marks
that captured child non-reusable, gives its exit diagnostic a 500 ms grace and
settles any active notification-driven turn even if the prompt response already
arrived. User Stop wins over a subsequent fault or exit. Callbacks from a retired
child cannot mutate a replacement; unrelated sessions continue running.

Request cancellation and explicit expiry remove the pending request, so late
responses cannot update its result. Prompts and reported active model runs have
no default control-read timeout. Raw provider output is classified separately
and omitted from [structured diagnostics](trace.md#structured-diagnostics);
visible provider errors retain their existing user-facing behavior.

### Codex startup

If Codex exits with code 1 while `initialize` is pending and its stderr reports
`failed to initialize sqlite state runtime`, Boite retries startup twice, after
500 ms and 1,000 ms. Each attempt uses the same account and configuration.
The native thread is created or resumed only after initialization succeeds;
the prompt is sent once. Stop cancels the retry wait. Other startup failures
and failures after initialization end the turn without an automatic retry.
Each retry is logged, and a third failure keeps the agent's exit error visible.
An initialization RPC error waits up to 2 seconds for process closure and remaining
stderr before the retry decision, so a process that stays alive cannot stall it.

### Codex task tracking

Boite enables `tools.update_plan.enabled` through the per-thread configuration
on both `thread/start` and `thread/resume`. Codex disables this tool by default;
listening for `turn/plan/updated` alone does not make it available to the agent.
The native plan populates the thread's activity tasks. Goal instructions explain
this mapping so the agent uses its planning tools instead of legacy Boite todos.

### Muse Code

`packages/core/src/drivers/muse.ts` speaks MSP, Muse's session protocol:
JSON-RPC 2.0 as ndjson over `muse serve`'s stdio, with its own transport rather
than `@muse-code/sdk`, because the SDK spawns its own child and every agent
process here goes through `procs.spawnChild`. The driver refuses a host whose
`initialize` answer names another envelope version than 1.

- Every command carries a client-minted UUIDv7 `commandId`, and a new session's
  id is minted the same way. A fresh turn's id is the `commandId` of its
  `turn/start`, so an item that arrives before the answer still finds its turn.
- An item notification carries the whole item so far. Text already written from
  `item/delta` is remembered per item and field, and a snapshot only adds what
  lies past it, so an answer is drawn once whichever way it arrived.
- Text sent while a turn runs, an asynchronous answer or a coordination
  message, goes out as `turn/steer` naming that turn in `expectedTurnId`. A
  host whose turn already ended refuses it, and the text waits for the next turn.
- Approvals and questions arrive as `approval/requested` and
  `userInput/requested` notifications and are answered with `approval/decide`
  and `userInput/answer`. Allow sends the narrowest approving choice the host
  offers, once before session before persistent; a stop sends `abort`, or the
  denial when there is none. The server-request forms are declined.
- A missing login ends the turn with `authRequired`, which the driver turns into
  a sentence saying to sign the account in from Providers.
- `threads.compact` sends `session/compact`; a `noop` answer fails the turn
  with Muse's reason. `session/todoListChanged` fills the thread's tasks, a
  cancelled item left out, and `session/contextUsage` feeds the context meter.
- Each startup step, `initialize` and then `session/start` or `session/resume`,
  has 90 s. A host that misses it is closed and the turn fails with the step's
  name. A stop during startup closes the host at once and ends the turn
  stopped, and a stop that lands before `turn/start` or `session/compact` sends
  neither, so a stopped turn never reaches the model.
- `session/closed` retires the host, idle or not. The turn it interrupts fails
  with Muse's reason, and the next turn resumes the session on a new host.
- Closing the host ends the thread's whole process tree on Windows. On Linux
  and macOS only the direct child is killed.
- The profile sets `MUSE_NO_AUTO_UPDATE=1`, so the launcher never updates what
  Boite pinned, and unsets `META_API_KEY`, so a key in the user's environment
  never replaces the account's login.

### pi

`packages/core/src/drivers/pi.ts` and the modules under `drivers/pi/` speak
pi's RPC mode: JSON lines over the stdio of `pi --mode rpc`.

- A turn ends on `agent_settled`, never on `agent_end`. pi retries an overloaded
  or dropped request by itself inside the same run (`auto_retry_start`,
  `auto_retry_end`) and recovers from a context overflow by compacting, so only
  the outcome of the last assistant message counts. A 529 that pi recovered
  from ends the turn done; one it gave up on fails the turn with pi's final
  error.
- An extension command or input handler can answer `prompt` without starting
  a run or sending `agent_settled`. The driver reads `get_state` after prompt
  acceptance unless the turn already settled. It ends an idle run when
  `isStreaming` is false and races the read against the terminal event. The
  read expires after five seconds; a refused read gets the same bounded window
  for a terminal event. Missing both fails and retires the session. A reported
  active model run has no default duration deadline.
- Stop sends `abort`, after `clear_queue` when coordination steered the run. A
  pi that has not settled 15 s later is closed and the turn ends stopped. The
  same holds for a pi still in its prompt preflight, which answers `abort` and
  `get_state` but holds the answer to `prompt`. A stopped turn also ends
  stopped when the core shuts down before then.
  Closing a session ends the thread's whole process tree on Windows, so a dev
  server a tool left running goes with it. On Linux and macOS only the direct
  child is killed.
- Extension dialogs (`select`, `confirm`, `input`, `editor`) become question
  cards. A dialog with a `timeout` loses its card when the time runs out,
  because pi then answers it with its default. `notify` is drawn in the turn,
  and an error notice becomes an error card that does not fail the turn.
  `setStatus`, `setWidget`, `setTitle` and `set_editor_text` get no answer and
  are not drawn.
- A warm process follows a change of model or level with `set_model` and
  `set_thinking_level`. There is no call that goes back to pi's own model or to
  no level, so either change starts a new process.
- After each turn `get_session_stats` feeds the context meter with a five-second
  control-read expiry. A timed-out response is removed and cannot update a later
  turn's context.
