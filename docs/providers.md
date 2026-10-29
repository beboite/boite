# Providers

## Subscription proxy

Settings, Providers offers an optional subscription proxy for Claude, Codex and
both OpenCode versions, and for Grok when the gateway is Douane.
Choose Douane or CLIProxyAPI, enter the gateway's API URL and its limits dashboard
URL, enable the switch and save. The API URL accepts an origin or a path ending
in `/v1`. Model discovery runs on the machine hosting the core. The agent's own
discovery runs through the gateway first, so each model keeps the effort scale,
speed tiers (Fast) and names a direct subscription shows. `GET /v1/models` then
adds the models only the gateway routes, and stands alone when the agent's
discovery fails. A route named after the vendor (`claude/claude-opus-5-5`) is
the agent's own model and is listed once, under its native id
(`nativeModelId` in contracts). A default model, draft or composer choice saved
under the route id opens on that native id with its effort. Paired phones use
that same catalog.

Claude Code is told the gateway is first-party, because the gateway relays Messages
unchanged to Anthropic on a subscription: tool search, first-party model aliases
and the one-hour prompt cache stay on (`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`,
`CLAUDE_CODE_PROMPT_CACHE_TTL=1h`), and fast mode skips the organization check
that needs a native login (`CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK`). Codex already
sends its service tier and prompt cache key to a custom provider.

While the proxy is enabled, Claude, Codex and both OpenCode versions show one account named
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
prefix (`codex/`, `claude/`, ...). OpenCode also accepts Antigravity Claude
routes when the catalog explicitly advertises Chat Completions (`openai`);
other proprietary routes keep their native-harness restriction. A catalog without endpoint metadata keeps
the older rule, which matches the whole id against the harness's native model
names. With Douane, the core reads `GET /v1/quotas` with the proxy key and
Limits shows native bars, described in [usage](usage.md#gateway-quotas). With
CLIProxyAPI, or a Douane that answers 404 on that route, Limits opens the
dashboard inside Boite instead of the account popup. Desktop uses the shell's
existing browser view, and browsers and phones use an iframe. The dashboard must permit embedding
and its configured URL must be reachable from the device displaying it.
HTTPS browser sessions require an HTTPS dashboard URL; Boite shows this before
creating a blocked HTTP frame. Open Douane (Open CLIProxyAPI) provides a separate sign-in page,
then Reload retries the embedded view. Some gateways refuse framing or restrict
cross-site cookies; those dashboards remain available through that button.
Show account limits opens the native limits and monitoring switches for agents
that keep their own configuration; Show proxy dashboard returns to the gateway.

### Switching the gateway from Limits

Once a gateway is saved, Limits starts with a switch, Use Douane or Use
CLIProxyAPI, beside its address (or Douane on this machine in local mode). It
saves as it flips, through `subscriptionProxy.setEnabled`, and changes only
`enabled`: the kind, the URLs and the key stay as the owner saved them. A
paired phone reaches it too, which is the one way a phone changes the gateway
([phone](phone.md)); configuring one stays owner-only. Before anything is
saved there is no switch, and the method refuses with `no subscription proxy
is configured`. Off restores native authentication as a saved Use a
subscription proxy does. `?fake=1&gateway=douane` (or `cliproxyapi`) starts
the in-memory client with a saved gateway that is off.

### Douane on this machine

The proxy card's first choice is where the gateway runs: Remote gateway (the
URLs above, typed by the user) or Douane on this machine, the Douane plugin
(Settings > Plugins, [gateways](plugins.md#gateways)). Settings store it as
`subscriptionProxy.mode`, `remote` or `local`; settings with no `mode` read as
remote, unchanged. In local mode the kind is Douane and the core writes both
URLs from the plugin's port: `baseUrl` `http://127.0.0.1:<port>/v1` and
`dashboardUrl` `http://127.0.0.1:<port>/admin/`, and follows the plugin when
it moves to another port. The proxy key stays the placeholder, since a
loopback Douane asks clients for no key. `subscriptionProxyOf`, model
discovery, the gateway account view and Limits then work as with a remote
Douane.

The card says whether the plugin runs (`Douane <version> answers on
127.0.0.1:<port>`), is stopped or starting, or is not installed, with Open
Plugins when it does not run. Choosing local mode starts nothing: the plugin
runs from its own row, whether or not the proxy uses it.

### Open Douane

Open Douane, or Open CLIProxyAPI, opens the gateway's dashboard URL in the
system browser (`openExternal`). It sits beside Save proxy in the settings, at
the top of Limits whenever the proxy is on, and in the embedded dashboard's
header. A dashboard at a loopback address (`localhost`, `127.0.0.1`, `::1`)
answers only on the core's machine, so the button shows there alone: in the
desktop app on its own core, or in a browser that reaches its core at a
loopback address. A phone or another computer gets no button for it rather
than a dead link (`gatewayDashboardReachable` in contracts,
`lib/gateway-dashboard.ts`).

### Moving connections to Douane

Move my connections to Douane, under the proxy settings, appears once a Douane
gateway is saved and the core advertises `features.gatewayMove`. The Douane
plugin's row in Settings > Plugins offers it too while the plugin runs; that
one sends `target: "plugin"` and moves into the plugin whatever the proxy
points at. It lists what
this machine's accounts hold that Douane can serve, default and isolated
accounts alike (`subscriptionProxy.movePlan`), and the user ticks what to move:

- Claude's `.credentials.json`, Codex's `auth.json` and Grok's `auth.json`,
  sent whole.
- OpenCode's `opencode/auth.json`: its `github-copilot` entry, alone, becomes a
  Copilot account. Each `type: "api"` key becomes a custom endpoint
  `{"type":"openai_compatible","route","base_url","api_key","dialect":"chat"}`.
  The route is OpenCode's provider id, lowercased, renamed when Douane keeps
  that name for a provider of its own: `opencode` (Zen) becomes `zen`, any
  other such name takes `-api`. The address is the provider's `api` field in
  OpenCode's catalog cache, `$XDG_CACHE_HOME/opencode/models.json` (else
  `~/.cache/opencode/models.json`, on every OS), which an isolated account
  shares. `opencode-go` goes to Douane's own `opencode_go` provider as its
  key instead.
- Not movable, with the reason on the line: a signed-out account, a file that
  is not JSON, a key whose provider has no `api` address in the catalog
  (`noAddress`), a provider whose package is not an OpenAI-compatible one
  (`otherApi`), an OpenCode OAuth sign-in other than Copilot's
  (`otherSignIn`). OpenCode 2 keeps its sign-ins in a database and is not
  listed.

`subscriptionProxy.move` makes the core read each ticked file again and post
it alone to `POST <gateway>/admin/api/accounts/import`. The client never
receives a value; a gateway's error that repeats a value of the payload has
it replaced by `[hidden]`, and the log line counts items only. Each line then
reads Moved, Already there or Refused with Douane's reason. Before posting,
the core reads `GET /admin/api/accounts` and skips what Douane already has
and could not tell apart by itself: an endpoint with the same route and
address, a Copilot or OpenCode Go account, a sign-in whose email matches the
Boite account's. An endpoint whose route Douane already serves at another
address is refused (`routeTaken`). Douane updates a sign-in it recognizes by
its account id instead of adding it twice; that line reads Already there.

A remote Douane can ask for a management token (`management_token_env`), or
sit behind a login page. The dialog takes an optional token, sent as
`x-management-key` and saved on the core like the proxy key (journal setting
`subscription-proxy-management-token`, never sent to a client; the plan only
says whether one is saved). A 401 or 403 asks for that token, and a redirect or
an HTML page says the API is behind a login, both with `field:
managementToken`. A local Douane answers on loopback without one. What moving
a sign-in means for Boite's own copy: [accounts](accounts.md#moving-a-login-to-douane).

Which agents the proxy serves is decided per provider, not per protocol
(`subscriptionProxyServes` in the contract): the Claude and Codex protocols
whole, and both OpenCode versions by their ids, because ACP is also what
Antigravity and other agents speak, and those keep their own configuration. Grok is served by
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

Muse Code uses Douane only after its quotas response announces a non-disabled
entry in the native `meta` pool and the core verifies both native routes without
inference: the catalog must contain Muse metadata, and an OPTIONS request to the
Responses route must advertise POST. Older gateways returning 404 or dashboard
HTML keep native authentication. A Muse model served by OpenCode Go does not
connect Muse Code. Without that pool, with CLIProxyAPI, or with the gateway
off, Muse keeps its native sign-in. Discovery updates the connection state
even when Meta has not reported a quota window yet.

Muse's MSP host reads an isolated gateway configuration under the core's data
directory, with `endpoint_transport.base_url` pinned to `/muse-code` and
`auth: "bearer"`. Its catalog uses `/muse-code/models` and its turns use
`/muse-code/responses`, both restricted to Meta by Douane. `META_API_KEY`
carries the proxy key only in the child environment; it overrides saved
authentication. Native settings and sign-ins remain intact. Models and
efforts still come from Muse's own MSP discovery, with their upstream ids.

Both OpenCode versions gain the gateway as an additional provider, named after
its kind (`douane` or `cliproxyapi`), calling its Chat Completions route.
OpenCode 1 uses the singular `provider` configuration with
`npm: @ai-sdk/openai-compatible` and `options.baseURL`; its `options.apiKey`
references `{env:BOITE_SUBSCRIPTION_PROXY_KEY}`. OpenCode 2 keeps its plural
`providers` configuration with `package: @opencode/ai/providers/openai-compatible`,
`settings.baseURL` and `env: [BOITE_SUBSCRIPTION_PROXY_KEY]`. Existing inline
permissions and other providers are preserved. The key is never embedded in
that configuration, and disabling the proxy restores the descriptor's original
environment and native account checks.

OpenCode 2 uses ACP for login and model discovery. Conversation execution uses
an owned `serve --stdio --port 0` process on loopback, with a random Basic-auth
password and the same isolated environment. Closing its stdin ends its lease.
The native event stream draws tools, reasoning, permissions and usage; plain
tool text stays output, while images and file diffs stay attached documents.
Follow-ups use the native prompt inbox with `delivery: "steer"`, so queued
messages and Send now join the running execution. OpenCode 2's ACP endpoint
rejects concurrent prompts. Events received during a follow-up submission wait
until its acceptance is journalled, keeping the user message before its reply.
Accepted inbox IDs remain tracked until delivery or cancellation, so a previous
execution's terminal event cannot discard a late follow-up. Yolo mode approves
native permissions without opening a permission card, including child sessions.

The picker lists OpenCode's own models first, then the gateway's as
`douane/<gateway id>`: Gemini, Muse, the open families, and Antigravity Claude
models whose catalog row explicitly includes `openai` in
`supported_endpoint_types`. A Claude route with no endpoint metadata or only
Messages support is not added; GPT, Grok and other Claude routes remain in
their native harnesses. Older catalogs without endpoint metadata still offer
Gemini, Muse and open models. Gateway model IDs retain their routing prefix in
the provider configuration, so selecting `douane/antigravity/claude-opus-4-6-thinking`
calls the gateway with `antigravity/claude-opus-4-6-thinking`.
The picker groups gateway models by their upstream provider, even in short
catalogs and search results. For example, `douane/opencode` and
`douane/openrouter` distinguish two MiniMax entries. Favorites show the same
source, and a model's tooltip gives its complete id.

The injected models preserve positive integer `context_length` (or
`context_window`) and `max_output_tokens` as their context and output limits.
OpenCode 1 requires both values to emit a valid limit object; an incomplete
pair is omitted. OpenCode 2 accepts either validated limit independently.
Advertised thinking budgets, dynamic thinking or effort levels enable
OpenCode 1's `reasoning` capability and its `reasoning_content` replay field;
OpenCode 2 receives `compatibility.reasoningField` instead. Missing or malformed
metadata adds no inferred limits or thinking capability. These values survive
the persisted catalog, so later spawns keep them. OpenCode still applies its
own output ceiling; the catalog does not override that runtime policy.

OpenCode 1.19 sends `x-opencode-session-id` on every model request and
`X-Session-Id` for custom providers, using its own conversation ID. A gateway
can use that ID for signed-thinking replay between tool turns without a
shared prompt hash or a process-wide session value.

A custom provider only knows the models its configuration names, so the core
keeps the last catalog it read (the journal setting
`subscription-proxy-opencode-models`) and writes it into that block at every
spawn; a restart starts a turn on a gateway model without probing first. While
the proxy is on, either OpenCode account reads `ok` with no native sign-in.
OpenCode 2 lists none of an injected provider's models in its ACP model option
and still takes them, and for about half a second after `session/new` it refuses
one it has not loaded yet: the driver sends a model under the injected prefix
(`BOITE_SUBSCRIPTION_PROXY_PREFIX`) though it is not listed, and asks again
after 250, 500, 1,000 and 1,500 ms before it warns. Both versions receive that
prefix; agents without it keep the normal model-option validation.

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
  `pi` or `echo`. OpenCode uses `acp`. A protocol with no driver behind it has nothing to run,
  so it is the one field that cannot be invented.
- `roots` bounds core-owned provider file access. Paths outside them and `..`
  segments are refused. It is not an OS filesystem sandbox for the agent.
- `profiles` holds one `OsProfile` per operating system, keyed `windows`, `linux`,
  `macos`. A provider with no profile for the running OS is not offered.
- `env` supplies common environment defaults for every OS profile; each profile's
  `env` overrides them before path tokens are expanded.
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
  Each of them takes a turn's 50 images (`ATTACHMENTS_PER_TURN`) in that one
  prompt, with no count of its own: the bytes are what weigh, and the 10 MB
  turn total keeps the frame each driver writes the size it was with 20.
  Claude's API counts the images of the whole request, earlier turns included
  (platform.claude.com, build-with-claude/vision, read 2026-10-28): past 20,
  each must be within 2000 px (`IMAGE_MAX_EDGE`); a request takes 100 images
  on a 200k-token model and 600 on a 1M one, and its body stops at 32 MB.
  What the Claude CLI does once a conversation holds more images than that is
  its own business and is not tested here.

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
command. Codex has no command listing, so its skills stand in for one: the
driver asks `skills/list` for the thread's folder once per process and again
on `skills/changed`, and lists the enabled skills whose name is one command
token, the first of a name winning. A prompt that opens on `/name` of a listed
skill waits up to 5 s for that first list, then goes to `turn/start` (or
`turn/steer`) the way Codex's own composer sends a skill: the text with
`$name` in place of `/name`, plus a `{ type: 'skill', name, path }` item. A
Codex without `skills/list` is one log line and an empty menu. `muse.ts`
reads no commands from Muse's session protocol.

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
  with the profile's `path` names as the bin hints. That is how Claude, Codex and
  OpenCode find the program their npm package vendors under nvm-windows, fnm,
  scoop or a custom prefix, where the shim on PATH is a `.cmd`. The token is
  expanded at each resolution, not at load, and only at the start of a `file`
  value.
- A PATH lookup, for a candidate, a `detect.command` or the npm roots, is
  remembered for 30 seconds per name and PATH, so the provider list and each
  turn start do not walk PATH again. What an `npm` candidate resolves to is
  remembered the same way, per spec, PATH and npm prefix variables. A
  remembered program or script that is gone is looked up again. A reload, a
  managed install or uninstall and an update forget every lookup; a program
  installed outside Boite shows up within 30 seconds, or at once on a reload.
- On Linux and macOS, a `codex` that PATH resolves to npm's
  `@openai/codex/bin/codex.js` launcher is replaced by the executable vendor
  binary the launcher would start (the platform package beside it, or the
  launcher's own `vendor/`). The updater still runs the launcher, which tells
  `codex update` which package manager owns the install. The launcher is a
  Node process that otherwise stays up beside each Codex process. A wrapper script in front of it, which may set limits of its
  own, is still what runs (`packages/core/src/providers/codex-launcher.ts`).
- `launch.args` put the agent into the mode Boite speaks to.
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
tokens. Grok needs it for the permission mode alone: the `grok` quirk splices
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
its single `files` entry must have the same size as `archiveBytes`. `tgz` is a
gzipped tar, the shape of an npm package tarball: its members sit under
`package/`, and `files` names them with that prefix. Every format verifies the
download's length and SHA-256 before making it available. Claude on
Windows uses the official x64 binary this way. Its managed copy lives under
Boite's data directory, without replacing a CLI installation elsewhere.

A `binary` install can also name its publisher in `latest`: `versionUrl`, a
plain-text file holding the newest version; `manifest`, that version's JSON
manifest; `platform`, the key under the manifest's `platforms`; and `url`, the
binary. `manifest` and `url` contain `{version}`, and all three URLs are https.
Claude's release bucket has this shape, and its manifest gives each platform's
`binary`, `checksum` (SHA-256) and `size`. Install reads the publisher first,
unless it was read in the last minute, and downloads the release it names,
checked against the manifest's digest and size like a pinned one. The manifest's
binary name has to be the file the descriptor installs, `versionUrl` carries no
`{version}`, and a redirect off https is refused. A publisher that cannot be
reached, or a manifest that does not describe that binary, leaves the last
release read, or the pin when none was, and the core log says why. A release
that follows its publisher never goes back: an install or update naming an
older version than the one on disk is refused as up to date. The install card reads the publisher when a
client lists the providers and the last read is an hour old, never at startup.
Without this, a first install would land the release the Boite build pinned,
and an update could only reach the next pin.

Codex and OpenCode ship a Windows x64 release the same way, from their GitHub
releases; the Codex archive also carries `codex-code-mode-host.exe`,
`codex-command-runner.exe` and `codex-windows-sandbox-setup.exe`, unpacked beside
the agent as upstream ships them. Codex spawns the code-mode host from its own
directory to run its tools, so a pin whose archive lacks it, as 0.155.1's
did, leaves the agent unable to run any tool. The
managed copy is the first executable candidate, so an update reaches the agent
Boite runs even when an npm copy exists. `test/shipped-installs.live.test.ts`,
opt-in behind `BOITE_E2E_INSTALLS=1`, downloads each pinned release and runs `--version`.
Muse Code ships the same way on Windows x64, as the single binary Meta's own
installer downloads (`format: "binary"`, pinned with its SHA-256). The official
installer puts a `muse.cmd` launcher on PATH instead, which Bun cannot spawn, so
the driver reads `.muse-version` beside it and runs the `muse-bin-<version>.exe`
it names; a launcher with no such binary beside it is refused with a sentence
saying to install Muse Code from Providers.
OpenCode 2 ships on Windows x64 as the tarball of its npm platform package,
`@opencode/cli-windows-x64` (`format: "tgz"`), since it publishes no GitHub
release. Grok and pi have no archive Boite can pin, so their row links to the
agent's own install guide.

Settings > Providers offers the next install or sign-in step. Install adopts
an existing CLI login before `providers.updated`; otherwise it continues to
sign-in. Cancellation or leaving the page cancels that continuation. Returning
to the window checks for external installs. Provider families can group multiple
descriptors in one row. [Accounts](accounts.md#the-guided-connection) describes
the guided connection and account controls.

`providers.install` streams the archive to
`<dataDir>/agents/<id>/downloads/<version>.zip.part`, hashing as it writes, and
refuses a wrong digest or a wrong length naming both values. It unpacks with a
streaming unzip, or a streaming gunzip and tar reader, into `releases/<version>/`,
so no member is held whole in memory:
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
of the version the descriptor pins. A provider that follows its publisher keeps
its downloads at startup, since the release it was fetching may be newer than
the pin; each successful read of the publisher then deletes every download but
the one of the release it names. A file Windows still holds is logged and
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
| Grok | `acp` | `grok [permission flags] agent [approval flag] stdio` |
| Hermes Agent | `acp` | `hermes acp` ([below](#hermes)) |
| Codex | `codex-appserver` | `codex app-server` |
| Muse Code | `muse` | `muse serve --trust-workspace [MUSE_HOST_SETTINGS] [mode flags]` |
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

`quirks` turns on a dialect the ACP driver knows, and there are three.
`quirks: ["antigravity"]` folds a tool call's command, working directory and
output under one spelling and draws an `interaction_` permission request as the
agent's own question; its modes are `default`, `auto_edit` and `yolo`, with no
plan mode. An `invoke_subagent` call (titled `Running invoke_subagent` or `Run
invoke_subagent?`; agents before 1.4.1 name it `start_subagent`; without
`_meta.is_mcp_tool_call`) carries the batch it launched as `nativeAgents`, listed in Subagents: the call returns once the batch
is launched, its output is the launch's description, and the agent reports no
child ids, names, models or results, so the batch stays running while the turn
runs and reads unknown after it; only a failed launch is final, with its error.
A shell call (`kind: execute`) still running when the prompt answers is the
thread's background work: the process stays up past the warm window, and the
thread's next turns run on it, until the command's own update ends it, and Stop on the idle thread closes the process,
the only way to end such a command since `session/cancel` stops prompts alone.
A GIF goes to the agent as a saved file, the server taking PNG, JPEG and WebP
blocks only. On Linux the launch environment names the first CA bundle found
(`NIX_SSL_CERT_FILE`, then the usual `/etc` paths) as `SSL_CERT_FILE` unless
`SSL_CERT_FILE` or `SSL_CERT_DIR` is set, since the server's bundled Python
finds none on NixOS. `quirks: ["grok"]` selects Grok behavior
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
empty home opens a browser. `quirks: ["hermes"]` reads a `session/load` answer
without `modes` as a session that is gone ([Hermes](#hermes)).

An agent whose session answer lists `models` but offers no `model` config
option takes the thread's model as `session/set_model { sessionId, modelId }`,
with no effort, at the start of each turn the model moved; a thread put back on
the descriptor's `default` asks for the model the first session reported as
current. Hermes Agent is that agent today.

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
- Default profiles use separate XDG homes: `~/.local/share/opencode-v2`,
  `~/.config/opencode-v2`, `~/.local/state/opencode-v2` and
  `~/.cache/opencode-v2`. OpenCode adds its `opencode/` subdirectory to each.
  This keeps version 1's database locks and incompatible plugins out of version
  2. Login checks, login terminals, hooks and isolated-account sharing use
  these same homes, rather than an inherited version 1 XDG directory.
- A sign-in is a row of `opencode/opencode.db`, in its `credential`, `account`
  or `control_account` table, which `auth.sqlite` names. Version 2 never reads
  version 1's `auth.json`: each is signed in on its own, even on the default
  account. Session databases are separate too; a thread cannot reuse a native
  session from the other version.
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
  version 2. Version 2 loads plugins from its own configuration home only.
  Isolated version 2 accounts share those plugins; Settings counts that source.
- Its managed install on Windows x64 is the npm platform tarball, unpacked to
  `{agentsDir}/package/bin/opencode.exe`, the first executable candidate. It
  never claims the `opencode` name, so OpenCode 1 stays where it is. Linux and
  macOS have no managed install and link to the install guide.

`test/opencode2.live.test.ts`, opt-in behind `BOITE_E2E_OPENCODE2=1`, turns the
provider on, runs a turn, resumes it on a new process and moves the session to
`plan`. Behind a [subscription proxy](#subscription-proxy) it was run against a
local stand-in for the gateway, which received the turn on its Chat
Completions route with the key and the gateway's own model id; no turn went
through a real Douane or CLIProxyAPI. Not verified either: Windows and macOS,
and an OAuth sign-in. Images are on: 2.0.30 answers `initialize` with
`promptCapabilities.image` true, and an ACP image block reached a stand-in
gateway, declared with the same provider block Boite writes, as a Chat
Completions `image_url` part. OpenCode 1 stays at `images: false`: 1.19.2 also
advertises images, but replaces one with an error text for a gateway model
that declares no image input, which is every model the gateway block lists.

`BOITE_E2E_OPENCODE2_BINARY=/absolute/path/to/opencode2 bun test packages/core/test/opencode2.compat.test.ts`
uses the installed binary with a local API and disposable profiles. On 2.1.1
it covers model discovery, a file-reading tool, cold resume, plan mode, stop
and another turn while a version 1 database is locked and its plugin API is
incompatible. It needs no login or external model. Windows and macOS remain
unchecked by this run.

## A local ACP command

The Providers page has a Local ACP command card for any agent that speaks ACP
over stdio: a name, the command that starts it, its arguments one per field and
its environment variables. `providers.addLocal` checks each field
(`checkLocalAcpCommand` in `packages/contracts/src/local-acp.ts`, which the
in-memory client runs too) and refuses with the field it names (`name`,
`command`, `args[1]`, `env.KEY`), which the form marks.

- The id comes from the name: lowercase letters, digits and dashes. A name
  whose id a provider already has, or whose `<id>.json` already exists, is
  refused; nothing is overwritten.
- The command is a program on PATH or an absolute path. A relative path is
  refused, and so is a program this machine cannot start; on Windows a `.cmd`,
  `.bat` or `.ps1` launcher is refused with the program to enter instead.
- Arguments go to the program as written, one argument per field, with no shell
  and no quoting. `{home}` and the other load-time tokens expand as in any
  descriptor.
- Environment values are saved in plain text in the provider file. An API key
  belongs in the agent's own sign-in. A variable named `__proto__` is refused:
  the descriptor loader builds a plain object, which drops that key.

The core writes an ordinary user descriptor to `<dataDir>/providers/<id>.json`
(`localAcpDescriptor` in `packages/core/src/providers/local-command.ts`) and
reloads, so the loader, the ACP driver and `providers.dryRun` treat it like a
file written by hand. It has no login and no isolation: the default account
starts the agent with its own sign-in and settings. Its only model is
`default`, which leaves the agent on the model it is configured with until the
models probe reads the agent's list. A file that fails to load is deleted again
and the refusal is returned.

The provider's details offer Remove provider. `providers.removeLocal` refuses a
shipped provider and a provider with a turn running, releases its warm
processes and deletes the file. Accounts and threads stay, and come back when
the same name is added again. Both methods are the owner's; there is no edit,
only remove and add.

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
dimmed, under Turned off, with no install or sign-in step. The clients hide an off provider from every list that offers one, the
model picker included, and a thread that was on it shows a Turned off chip in
its composer. The method is the owner's: a paired device reads `enabled` and
cannot change it.

## Retired providers

Boite once shipped `antigravity-cli`, which ran the user's own `agy` in print
mode; the managed `antigravity` ACP server replaces it. A data directory from
that Boite still names it, so `providers/retired.ts` lists the id and startup
cleans up after it (`account-retirement.ts`): its accounts and the limits
switch of its `quota:antigravity-cli` source leave. A conversation on it stays
listed and readable, and reads as on a removed account: its next turn refuses
until the user picks another account in its model picker. An installed plugin
whose account pool names it keeps loading, without that id.

## The models probe

`providers.probe` first considers the explicitly scoped composing or viewed
session for Codex and ACP. It reuses only a compatible account, descriptor,
environment, workspace and context mode. Codex asks the idle host for its list;
ACP shares compatible initialization and reads its catalog without changing its
model. Missing ACP effort metadata and invalidated catalogs use an isolated probe.

Otherwise it spawns one short-lived process under the synthetic thread
`probe:<providerId>:<accountId>`, exactly the way a session would, so it sits in
a Job Object and in the trace like any other, then asks the protocol's own question:

- Claude: SDK `supportedModels()` without a user prompt, with
  `settings.disableAllHooks` so no `SessionStart` hook fires, and
  `strictMcpConfig` with no servers so it starts none of the user's MCP servers
  (an empty `mcpServers` alone passes no flag). The CLI quota read, titles and
  side questions do the same. Effort levels, adaptive
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
  for the account too. A process that resumes a session loads it first and
  opens a discovery `session/new` only when the load answered no options and
  nothing is cached; both OpenCode majors answer them on load. A probe or a
  discovery session is deleted with `session/delete` when the agent advertises
  `sessionCapabilities.delete` (OpenCode 2 does), so none of them stays in the
  agent's own session list. A refresh drops cached catalogs but keeps the one
  a session still opening reads: the composer refreshes as the app opens while
  the draft's process starts, and that answer is as fresh as a probe's.
- ACP after a sign-in: the login process, already running and signed in,
  opens one `session/new` in an empty folder and its answer becomes the
  account's catalog, told to clients as `providers.probed`. No probe process
  starts for an account that just signed in. A sign-in whose session did not
  open within 30 seconds is still signed in; the next look at the models probes.
- Under the `antigravity` quirk a probe waits 90 seconds instead of 20. The
  agent is a PyInstaller one-file program that unpacks itself before its
  server reads a line: 45 to 54 seconds on an 8 GB laptop with 600 MB free
  under 1.1.1, whose Windows build unpacked about 1.2 GB. The 1.4.1 builds are
  smaller (Linux 930 MB, Windows 86 MB plus a 146 MB harness).
  Each launch, probe, sign-in or session, unpacks into its own folder under
  `<isolationDir>/tmp`, set as `TEMP`, `TMP` and `TMPDIR`, and the folder goes
  once the process has exited. Every one of them ends in a forced stop, which
  would otherwise leave the unpacked copy in the user's temp folder. What a
  stopped core left there is removed the first time the account launches again.
- ACP controls on a running session: a model, effort or mode goes out only
  when the session's own last answer does not already report it. OpenCode 2
  puts the effort back on `default` with any model change, so the effort goes
  again after one; a thread with no effort sends `default` when the agent lists
  it, and a thread back on the agent's own model asks for the model the
  session opened on. A refused effort is not asked again in that process.
  A model the agent lists without the selected value, or refuses after any
  injected-model retries, stops the turn before its prompt. A later turn can
  retry that model.
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
- pi: `get_state`, `get_available_models` and `get_available_thinking_levels`.
  Each model id carries its provider prefix, because that is what pi's `--model`
  takes and two providers can ship a name. The thinking level `get_state` reports
  is the default effort of the model the probe's session is on, and of no other:
  pi does not say which level it would run another model on, so those models
  carry their scale without a default. A thread that picks one sends no level,
  pi keeps its own clamped to that model, and the reasoning chip reads Default
  until a level is picked. On such a model the reasoning popover, and the
  phone's options sheet, offer Default to hand a picked level back to pi. An unauthenticated pi answers with
  nothing, so the descriptor's models are left standing rather than replaced by an
  empty list.

The disposable child is killed through the registry on every path; a reused
session retains its ordinary lifecycle. The answer keeps the
descriptor's `default` first, so the choice can always go back to the agent, is
cached per provider and account until a `providers.reload` that changes a
descriptor, what one resolves to or a rejection, or a change to that
account, and reaches every client as `providers.probed`. A reload that changes
none of that emits no `providers.updated`. Two callers at once share
one process. `refresh: true` bypasses a completed cache entry, sharing any probe
already in flight. Until that read answers, the account's previous list still
answers model checks, and a read that fails leaves it in place; a reload or a
change to the account drops it as before. The caller is answered as soon as the
models are read: the process exits, its trace closes and its directory goes
afterwards, and the next probe of the same account that needs a fresh read waits
for that; a read the cache answers does not. Claude takes up to a second to exit. The UI keeps a persistent display cache and reads asynchronously.
Cleanup starts the registry's bounded stop before waiting for process pipes to
close. A missing close event gets one additional second, then a
`provider.probeCleanup` warning. The original models or discovery error still
reach the caller, and the next request for that account can proceed.

Every list an account answers is also saved in the journal
(`providers/saved-catalogs.ts`), under a hash of the descriptor, the resolved
executable, the account's gateway settings and its status, identity and
isolation folder. When the account has not answered since the core started, or
since a reload or an account change dropped its list, a probe with no `refresh`
and no `model`, on a provider turned on, returns the saved list at once if that
hash still matches, and a `refresh` read starts behind it; its answer reaches
clients as `providers.probed`. Until that read answers the saved list answers
model checks, and a read that fails leaves it in place, as a refreshed one does. Starting
the agent is what costs: on 2026-10-22 an Antigravity probe took 12.3 s on the
desktop, an OpenCode 2 probe 3 to 5 s on the server, and the picker showed
nothing until it answered. A list a driver already holds, from a sign-in's or
a turn's own session, answers instead and starts nothing. While nothing has
been read yet, every such probe gets the saved list, a second one while the
first refresh still reads and one after it failed included, held for model
checks the same way. Any change to the account (`accounts.updated`, a sign-in under
the same identity included) and its removal delete its saved list.
A model picked from a list the core gave on this connection lands at once, and
a draft created on it is not read again, except an ACP effort that list carries
no scale for. A list restored from browser storage, or one the core has not
given yet, is read before the pick or the send.
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

Protected shared work adds an immutable file/tool capability to the host-selected
mode and account. Claude removes native tools and user MCP/plugins/hooks and
provides only in-process protected tools. Codex disables alternate execution
features and MCP servers, applies a granular filesystem root deny and offline
profile, and provides host dynamic tools. `boite_exec` runs project commands
through the OS boundary; job-only `boite_commit` uses fixed trusted Git operations.
Default/acceptEdits require host approval, bypass/YOLO retain automatic approvals,
and plan/dontAsk refuse mediated commands. Restricted context tool lists expose
no generic command tool. Native mode changes retire/re-admit the capability.
The protected fingerprint participates in warm identity. Codex cold protected
starts replay through a fresh native thread because `thread/resume` cannot
replace dynamic tools. Ordinary local sessions keep the mappings below.
See [protected shared execution](contacts.md#native-linux-tool-execution) for
host prerequisites and the deterministic native driver proof.

OpenCode 1.19.3 uses its native ACP plugin hooks to deny every
non-core tool and command, plus a core-only remote MCP server. It supports only
its native default/build and plan modes. Other versions need a verified hook
path and bundled SDK inventory before admission. Other ACP implementations, including
OpenCode 2, cannot obtain this capability by advertising ACP permission support.
Private discovery retains the selected API/OAuth account and JSON provider/model
selection, including normalized JSONC and custom configuration files. Only SDKs
bundled by this native version may load; external SDK imports, legacy TOML and
remote-configuration credentials are refused explicitly. User plugins, MCP,
commands and project configuration cannot follow the protected session.
An explicit protected model must appear in the native catalogue or the selected
account's injected provider and be confirmed by ACP before a prompt. Missing,
refused or unconfirmed selections stop the turn without API traffic. Warm
turns recheck the current native model, including announced drift; choosing
the native default remains a separate selection. Ordinary local ACP keeps its
existing best-effort model preference.

pi 1.4.0 uses its own extension API: builtins, discovered extensions, MCP, skills,
prompts and project context are disabled, and a core extension registers only
protected tools and rejects other tool calls. Selected native account
authentication remains available to trusted provider control; model selection
is captured privately. Command-valued keys/headers and executable environment
preloads are refused before launch. Only YOLO and bypass modes
are admitted, because pi RPC has no native approval mode. The descriptor keeps
`capabilities.approvals: false`. ACP/pi fingerprints distinguish ordinary and
protected warm sessions, and every warm turn checks revocation before prompting.
Protected pi cold starts use a new private transcript and the core's captured
continuation instead of reopening ordinary or differently scoped native history.
The forced shared-turn context suppresses native resources while captured host
tool permissions control the protected tools. An actual host tool-free context
exposes neither native nor protected tools.

Muse 1.4.13 now supplies a verified mandatory MCP-only native registry gate;
its protected adapter uses the same OS executor and preserves selected native
account/model/approval semantics. Older Muse 1.3.0 remains refused because its
native file reads bypass its shell sandbox and its toolsets cannot retain only
MCP tools. Installed native production regressions cover both cases without
live inference. The exact release and gate are described under [Muse Code](#muse-code).

- Claude takes a changed mode in place through the SDK's `setPermissionMode`,
  sent before the next prompt and only when the mode moved. Claude can also move
  by itself: EnterPlanMode puts it in `plan`, and an ExitPlanMode the user
  refuses or stops leaves it there. The driver records the mode each `init`
  and `status` frame reports, so the next turn on the same process sees the
  drift and puts the thread's mode back before its prompt goes in.
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
- pi has no approval call anywhere in its RPC mode, so `capabilities.approvals` is
  false, the thread's permission mode never reaches the agent, and each session
  says so once in the log. A driver that waited for a permission question there
  cannot enforce a permission gate.

The composer offers four of the six and names each by what the agent may do
without asking (`lib/permission-modes.ts`): Ask, Edit freely, Auto and YOLO.
The list follows the agent. Codex loses Edit freely, which is the same pair as
its default, and its default reads "This folder", because workspace-write lets
it edit and run commands there without a card. An agent whose `capabilities.approvals` is false gets no mode chip: every
choice would describe something it does not do. No confirmation keeps the warning colour on its chip,
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
A question never takes a composer the user is writing in. One that arrives
while its thread's composer holds text or files stays out of it until that
composer is empty, so Enter still sends the draft as a message; one that
arrives within 1.5 s of a keystroke waits for that pause. "Answer in writing"
takes it at once, draft included. Once a question has the composer, typing
again does not give it back.
No protocol carries an image in
a question's answer (Claude's `AskUserQuestion` takes strings, Codex's
`requestUserInput` and Muse's `userInput` take text, pi's dialogs a value), so
the core writes each file under `<dataDir>/attachments/` like a prompt's files
and appends their paths to the answer text, with the note prompts use; the
agent reads them with its own tools (Read, `view_image`). The journalled answer
and the card keep only each file's kind, type, name and size, never its bytes
or path. ACP and Antigravity questions offer options only, so they take no files.

## Claude's system prompt

Without a `systemPrompt` option the Agent SDK sends an empty one, and the CLI
then gives the model one identity line. The driver asks for Claude Code's own
prompt instead (`preset: 'claude_code'`), the one Anthropic tunes per model, and
appends Boite's guide to it. Measured on 2026-10-15 with Claude Code 2.1.300
against a local fake API server, with memory off and the dynamic sections moved
out, the preset adds these characters to the system prompt:

| Model | Characters | What it adds |
| --- | --- | --- |
| Opus 5.5, Sonnet 5.5 | 3,260 | Harness rules, safety, code style, confirmation of hard-to-reverse actions, honest reports, context management |
| Haiku 5.5 | 6,052 | The same, plus a section on finishing a turn's work before asking |
| Fable 5.1 | 9,332 | The same, plus rules for scope and for the final message |

`excludeDynamicSections` moves the working directory and memory path to the
first message, so threads in different worktrees share one cached system
prompt. `autoMemoryEnabled: false` keeps the preset's file-based memory out:
memory belongs to the user's brain and Boite's own notes. A context mode keeps
the preset, which carries Haiku's section, and drops only Boite's guide when it
drops guides.

The CLI records a session's system prompt on its first request and sends that
record until compaction, even when a later launch passes different text. A
thread started before this change keeps its empty prompt until it compacts or
starts a new session; a change to the guide reaches a running session the same
way.

## Reasoning and tool summaries

What a thread shows of an agent's reasoning is what its protocol sends. Measured
on 2026-10-14 with Claude Code 2.1.299 and Codex 0.162.1:

| Provider | Reasoning text | Batch summaries |
| --- | --- | --- |
| Claude | A summary per thinking block: the driver passes `--thinking-display summarized` through `extraArgs` | `tool_use_summary` with `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES=1`, kept as each call's `summary`; off unless `Settings.toolSummaries` |
| Codex | Summary deltas, a bold heading then a paragraph; `auto` and `detailed` gave the same shape | none |
| ACP (Grok, OpenCode), pi | What the agent streams as thought chunks | none |

A CLI the SDK drives is non-interactive, and for that case Claude Code asks the
API to leave reasoning out (`omitted`): the blocks arrive with empty text, which
is what left a thread with "Thinking" rows and nothing in them. The display only
moves what comes back; the model thinks, and is billed, the same. Whether and how
much it thinks stays with the CLI (effort, `alwaysThinkingEnabled`), which is why
the driver sets the flag rather than the SDK's `thinking` option. The API
refuses `highlights` (one title per stretch of thinking) for a subscription
login: `thinking.adaptive.display: Input should be 'summarized', 'omitted'`, and
the CLI falls back to `omitted` for the rest of the process.

Claude 5.1 and later write the short line they put ahead of a tool call ("Now
I'll run the tests.") as a thinking block, not as text. When two non-empty
thinking blocks of one API message come right before a tool call, the driver
turns the second into a text part in place, so it reads as the agent's
narration between tool groups; the first stays folded as reasoning. One
thinking block before a call is reasoning, and a model before 5.1 (the model
of the stream's `message_start`, else the thread's) writes its updates as text,
so its consecutive thinking blocks share one part as before.

Tool summaries are off by default: the driver sets the variable only when the
owner turns on Settings > General > Tool summaries (`Settings.toolSummaries`),
read when a Claude process starts. Each tool summary is one request the CLI
sends to Haiku after a batch of calls finished (`source=tool_use_summary_generation` in its debug log), on the
thread's account. It names the calls it covers, so it can arrive while the next
batch already runs; a call of an earlier turn is not redrawn. The other
progress messages the CLI sends (`thinking_tokens`, `api_retry`, `status`,
`task_progress`) feed the turn's footer (`drivers/claude/progress.ts`, see
[trace](trace.md)); `prompt_suggestion` and `rate_limit_event` stay unused by
the timeline.

Each streamed API request owns its output parts. When Claude Code reports
`api_retry` after an interrupted response, the driver clears that attempt's
text, thinking and unexecuted tool cards before the replacement streams.
Completed requests and their tools remain. A `message_delta` with a stop
reason confirms completion; `message_stop` alone does not, because the CLI
also emits it when a stream is interrupted.

## Claude's MCP servers on demand

Claude Code starts every stdio server of the user's `mcpServers` with each
session, called or not. A Claude turn hands the CLI each of those servers as a
Streamable HTTP entry under the core's `/mcp/lazy/<registration>/<name>`
instead (`packages/core/src/mcp/lazy.ts`). The entry carries
`Authorization: Bearer ${BOITE_AGENT_TOKEN}`: the CLI expands the variable from
its environment, so the token never reaches its command line. A token of
another thread gets 404, a wrong one 401.

The servers come from the `.claude.json` the CLI reads (`CLAUDE_CONFIG_DIR`,
else the home directory), without the ones its project lists under
`disabledMcpServers`. HTTP and SSE servers stay the CLI's own. A passed entry
replaces the config's server of the same name, so the CLI starts none of them.

The first session of a server starts it for the handshake and saves what it
answered (`initialize` result and the tools, prompts, resources and templates
lists) in the journal setting `mcp-manifest:<fingerprint>`, keyed by command,
arguments and environment. The folder is not in the key: each worktree would
start every server once more. Later sessions with the same MCP protocol version
get the handshake, the lists, `ping` and `logging/setLevel` from that manifest
without a process. The first other request starts the real server under the
thread, in the thread's folder, with the CLI's environment plus the server's
own and the agent variables, then forwards it. A request that comes during the
server's handshake waits for it, and one the CLI cancels meanwhile is dropped
unanswered. The server stays for the rest of
the session. Its own requests (roots, sampling, elicitation) reach the CLI on
its GET stream, or on its newest open POST stream when there is none. Once a
server is live, the core reads its lists again and saves them; when its tools
differ from what the session was given, the session gets
`notifications/tools/list_changed`.

The CLI's end releases the registration, not the turn's: a warm or viewed
session keeps its CLI across turns, and the servers it started with it. The
core then closes each server's stdin and, after 3 seconds, stops it with what
it started. The core reads a server's stdout as lines of at most 16 MiB
through the drivers' shared `LineSplitter`; a longer line fails every call the
server owed and stops it the same way. A server
whose command, arguments or environment hold a `${...}` reference stays with
the CLI, which expands it. Set `BOITE_LAZY_MCP=0` in the core's environment
to give the CLI the servers as configured.

## Stdio transport failures

Codex, Muse and pi use `drivers/stdio.ts` for request lifetime and newline
framing; their `rpc.ts` modules retain protocol-specific envelopes. Stdout lines
are bounded to 16 * 1024 * 1024 UTF-16 code units. A final line without a newline
is processed before EOF. Non-JSON or invalid object records produce a fixed
protocol diagnostic without copying their raw output into diagnostic logs.

Oversized stdout, failed reads/writes, stdout closure or a throwing message handler
close the transport and reject all pending requests once. The session marks
that captured child non-reusable, gives its exit diagnostic a 500 ms grace and
settles any active notification-driven turn even if the prompt response already
arrived. User Stop wins over a subsequent fault or exit. Callbacks from a retired
child cannot mutate a replacement; unrelated sessions continue running.

A clean stdin close makes the captured session non-reusable and refuses new
writes while already sent requests can still receive stdout responses, including
the final record at EOF. Their existing cancellation and expiry remain active.
Drainage ends at stdout EOF/close, an
explicit failure, a read/write error or the existing 500 ms exit grace, whichever
comes first. Stdout termination or drain expiry invokes the session fault
callback; with a live child and stdout that never closes, requests settle after
500 ms and session
teardown can take a further 500 ms for its exit diagnostic.

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

Every `thread/start`, `thread/resume` and `thread/fork` sends
`mcp_optional_startup_grace_ms: 10000` in its per-thread configuration, unless
`config/read` shows the user set that key, `0` included (Codex then waits for
each server's own `startup_timeout_sec`). Codex
waits that long for the MCP servers of `config.toml` before the first model
request and leaves out any server still starting; its default of about a second
is too short for a cold `npx` or `uvx` server, whose tools would then be missing
from the first turn of each new process. A server that hangs delays only that
first turn, by 10 seconds.

A thread archived in the Codex app or CLI, which share the default account's
history, makes `thread/resume` answer `session <id> is archived`. Boite then calls
`thread/unarchive` on it and resumes once more, so the thread keeps its native
history instead of failing every turn. A rollout that is gone is different: the
turn starts a new native thread and carries the conversation in its prompt.

The app-server that writes a title or a branch name starts with
`features.plugins=false` and `features.apps=false`, reads the effective
configuration of the thread's folder with `config/read`, and opens its ephemeral
thread with every MCP server listed there set to `enabled = false`. Without it,
each title would start the user's MCP servers and plugins, and a server could act
on the prompt. A Codex that refuses `config/read` writes no title: the attempt
fails with that reason rather than start the servers, and the thread keeps the
title it has.

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
  lies past it, so an answer is drawn once whichever way it arrived. Only the
  running turn's items are recorded, and the record is emptied when the turn
  ends: a delta of another turn's item (a queued one, a replay) is dropped.
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
- From Muse 1.4.13, read from `.muse-version` beside a `muse` executable, the
  host starts with `MUSE_HOST_SETTINGS` (`drivers/muse/mapping.ts`). Older
  hosts refuse `-c`, so they start as before.
  - `run.reminder_roster={}` stops Muse's skill, goal and verify reminder
    agents. Each one calls the thread's model again at every step, and the
    blocking ones hold the turn open after the answer. On 2026-10-25, through
    Douane, `muse exec --json --model muse-wonder-full-1.0-contributor
    --reasoning-effort xhigh --workspace <empty dir> "<list this folder with a
    tool, then answer ok>"`, alternated with and without
    `-c 'run.reminder_roster={}'`, took 24.1 s and 25.1 s with the reminders and
    14.8 s and 16.3 s without.

Protected shared Muse sessions require native 1.4.13 and MSP fingerprint
`sha256:7fddaf646dbc317e5fcac0785e135eb04df14fbb0db1863089dfd6da21730e5b`.
`drivers/muse/protected.ts` writes a private native configuration with only
`mcp__boite_protected__boite_exec` and `mcp__boite_protected__boite_commit` in
`run.toolset`. The native registry rejects forged calls to other tools; a
required MCP failure or unresolved name stops run preparation before inference.
The native host reads selected auth through its private config root and retains
its account refresh, model, transport and approval semantics. Only model tool
commands enter the common offline OS executor. Native discovery sees an empty
workspace and core-owned HOME/XDG roots, including foreign `CODEX_HOME` and
Claude/plugin discovery roots. External hooks/MCP/plugins and experimental
environment overrides are excluded. Native shell and writes are also
disabled. Protected cold starts create a new private session and use the core's
captured continuation; ordinary local resume is unchanged. Native 1.3.0 and
unverified versions/fingerprints remain refused. These guarantees depend on the
verified native registry gate, not its shell sandbox or a permission callback.

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

### Hermes

Hermes Agent (Nous Research, MIT) speaks ACP through `hermes acp` on stdio. It
runs hosted models and local ones through any OpenAI-compatible server
(llama.cpp, Ollama, vLLM, LM Studio). Read against Hermes 0.21.5
(`v2026.9.24`) on Linux.

- Install, per user, no root:
  `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup`
  puts a checkout under `~/.hermes/hermes-agent` and links
  `~/.local/bin/hermes`; on Windows `install.ps1` uses
  `%LOCALAPPDATA%\hermes\hermes-agent`. The descriptor looks on PATH, then in
  `~/.local/bin`, then in the checkout's `venv`, and on Windows in the
  checkout's `venv\Scripts\hermes.exe` first. A pinned install in a virtual
  environment of your own is
  `python3 -m venv ~/.local/lib/hermes-agent && git clone --depth 1 --branch v2026.9.24 https://github.com/NousResearch/hermes-agent ~/.local/lib/hermes-agent/src && ~/.local/lib/hermes-agent/bin/pip install -e "$HOME/.local/lib/hermes-agent/src[acp]" && ln -s ~/.local/lib/hermes-agent/bin/hermes ~/.local/bin/hermes`.
  `hermes acp --check` answers `Hermes ACP check OK`.
- Each account has its own `HERMES_HOME` (`~/.hermes`, or
  `%LOCALAPPDATA%\hermes` on Windows, for the default account). It holds the
  model and provider (`config.yaml`), keys (`.env`), sessions (`state.db`) and
  memories. An account reads `ok` once `config.yaml` exists, which `hermes`
  does not write on its own. Login runs `hermes model` in a terminal, Hermes'
  own picker for a provider and model. `skills` and `SOUL.md` are shared from
  the user's own home. The profile unsets `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
  `OPENROUTER_API_KEY` and `OPENROUTER_BASE_URL`, which Hermes reads ahead of an
  account's own `.env`, plus `HERMES_SESSION_ID` and `HERMES_TUI_GATEWAY_URL`,
  which would tie the process to another Hermes.
- A local model: start the server with a window of at least 64K tokens, since
  Hermes refuses a model under that, for example
  `llama-server -m qwen2.5-0.5b-instruct-q4_k_m.gguf --alias qwen2.5-0.5b -c 65536 -fa on -ctk q8_0 -ctv q8_0 --host 127.0.0.1 --port 8089`.
  Then pick "Custom endpoint" in `hermes model`, or write the account's
  `config.yaml`:

  ```yaml
  model:
    provider: custom
    default: qwen2.5-0.5b
    base_url: http://127.0.0.1:8089/v1
    context_length: 65536
  ```

  No key is needed for a local server.
- Models: the descriptor carries `default`, Hermes' configured model. The probe
  reads `models.availableModels` from `session/new`, ids `provider:model`
  (`custom:qwen2.5-0.5b`). Hermes 0.21.5 answers no config options, so the
  model goes out as `session/set_model` with no effort; Hermes answers -32603
  while a turn runs and -32602 for a model it does not have. A refused switch,
  including a return to the configured default, stops the turn before its
  prompt. Switching can take seconds, since Hermes rebuilds its agent.
- Modes: `default` asks before edits and dangerous commands, `accept_edits`
  allows edits inside the workspace and `dont_ask` allows edits outside
  sensitive paths. `acceptEdits` and `dontAsk` map to those two, the others to
  `default`, where every request reaches Boite as a permission card answered
  with Hermes' `allow_once` or `deny`. There is no plan mode. An unanswered
  request is denied by Hermes after its own `approvals.timeout`, 300 seconds by
  default.
- Resume: `session/load` replays the history before it answers, which the
  driver drops. For a session it no longer has, Hermes answers an empty result
  instead of an error, and a prompt on that id stops with `refusal`; the `hermes`
  quirk reads a load answer without `modes` as gone, and the turn runs again on
  a new session carrying the conversation.
- Images go as ACP image blocks; `initialize` advertises them.
- Hermes' own `/` commands reach Boite as `available_commands_update`. A prompt
  sent while Hermes runs a turn is queued by Hermes for the next one; Boite
  does not send one.
- Not covered: Hermes' `main` branch starts a gateway daemon per
  `HERMES_HOME` behind `hermes acp`, which outlives the ACP process; this
  descriptor was read against the release before it.
- Live test: `BOITE_E2E_HERMES=1 HERMES_E2E_BASE_URL=http://127.0.0.1:8089/v1 HERMES_E2E_MODEL=qwen2.5-0.5b bun test test/hermes.live.test.ts`
  in `packages/core`. It refuses a non-loopback URL, so no turn leaves the
  machine.
