# Providers

A provider is an agent Boite can run, described by JSON rather than by code, so
adding one is a file instead of a release. Shipped descriptors live in
`packages/core/src/providers/shipped/` and are read-only; a user drops their own
under `<dataDir>/providers/*.json`. The types are in the contract, the loader in
`packages/core/src/providers/loader.ts`.

A descriptor loads or is refused with the file, the field and what was expected.
An unknown field is a refusal, a user file may not take a shipped id, and `roots`
is checked before anything else. `providers.dryRun` validates a file and prints
the plan without writing anything.

## The fields

OpenCode's descriptor, with the `linux` and `macos` profiles left out:

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
        { "kind": "file", "value": "{appdata}/npm/node_modules/opencode-ai/bin/opencode.exe" },
        { "kind": "path", "value": "opencode" }
      ],
      "launch": { "args": ["acp", "--port", "0"] },
      "isolation": { "XDG_DATA_HOME": "{isolationDir}", "XDG_CONFIG_HOME": "{isolationDir}" },
      "close": { "processes": ["opencode.exe"] }
    }
  },
  "auth": { "kind": "oauth-cli", "session": ["opencode/auth.json"] },
  "login": { "command": ["opencode", "auth", "login"] },
  "models": [{ "id": "default", "name": "OpenCode default", "default": true }],
  "capabilities": { "approvals": true, "hooks": false, "checkpoint": false, "images": false, "planMode": false, "resume": true }
}
```

- `id` is the key everything refers to, and a user descriptor may not reuse a
  shipped one. `schemaVersion` is `1` and is checked. `name` and `shortName` are
  what the picker and the chips show.
- `protocol` picks the driver: `claude-sdk`, `acp`, `codex-appserver`, `pi`,
  or `echo`. OpenCode uses `acp`. A protocol with no driver behind it has nothing to run,
  so it is the one field that cannot be invented.
- `roots` lists every directory the engine may read or write for this provider. A
  path outside them is refused, and a `..` segment is refused at load.
- `profiles` holds one `OsProfile` per operating system, keyed `windows`, `linux`,
  `macos`. A provider with no profile for the running OS is not offered.
- `auth.kind` is `oauth-cli`, `api-key` or `none`, and `auth.session` names the
  files inside the isolation directory that carry the login, which is what the
  core reads to tell `ok` from `unauthenticated`. `auth.identity` says where the
  account name comes from.
- `login` is either `command`, the argv of the provider's own login command plus
  an optional `env`, or `acp: { methodId }`, the `authenticate` method of an ACP
  agent whose sign-in has no command. A provider without one cannot be logged in
  from Boite, and the Accounts page says so instead of pretending.
- `models` is a `ModelInfo` list: `id`, `name`, an optional `default`, `legacy`
  (still accepted, folded away in the picker), `badge: "new"`, and an `effort`
  block of named levels with a default. An agent that owns its own list gets the
  single model `default`, and the probe supplies the rest.
- `capabilities` is six booleans: `approvals`, `hooks`, `checkpoint`, `images`,
  `planMode`, `resume`. `approvals: false` means the thread's permission mode
  never reaches that agent, and the UI stops promising a gate that does not exist.
  `images: false` refuses a turn's attachments before anything is sent, so a
  driver whose protocol carries no image at all never has to. Where `images` is
  true, each protocol hands an attachment over in its own shape: the Claude
  driver turns the prompt into a content-block array, one text block plus one
  `{ type: 'image', source: { type: 'base64', media_type, data } }` block per
  attachment; ACP sends a `{ type: 'image', mimeType, data }` block alongside
  the text block of `session/prompt`, but only once the agent's `initialize`
  answer says `agentCapabilities.promptCapabilities.image` is true, or the turn
  fails before anything goes out; Codex appends one
  `{ type: 'image', url: 'data:<mimeType>;base64,<data>' }` entry per attachment
  to `turn/start`'s `input`; pi adds an `images` array of
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
speaks, so `codex.ts` reports none.

## Inside an OS profile

- `detect` is `{ command }` or `{ file }`. A provider whose detect does not
  resolve reports unavailable rather than failing at spawn.
- `executable` is an ordered candidate list: `kind: "file"` is an exact path,
  `kind: "path"` a name looked up on PATH, first hit wins.
- `launch.args` put the agent into the mode Boite speaks to, and they let a
  descriptor name a script rather than a program: npm installs several of these
  agents as a shim Bun cannot spawn, so the profile runs `node` with the
  package's own `dist/cli.js` as the first argument.
- `isolation` is the environment that makes one account blind to the others, with
  `{isolationDir}` substituted per account at spawn ([accounts.md](accounts.md)).
- `close.processes` names what the core closes when an account is removed, and is
  empty for an agent running under `node`: the process in the job is `node`, not
  the agent. `install` is the optional managed release, below.

## The tokens

Four expand when the descriptor loads, in `roots`, in every executable candidate,
in `launch.args` and in a profile's `env`. `{home}` is the home directory,
`{appdata}` the Windows roaming per-user directory, `{agentsDir}` is
`<dataDir>/agents/<providerId>/current`, where a managed install puts its files
(it resolves to a path that does not exist until they land, which is what makes
such a provider read as absent), and `{browserNoop}` is the launcher that does
nothing, for a `BROWSER` variable. A fifth, `{shippedDir}`, points at the shipped
descriptor folder, so a shipped login command can name a script beside it.
`{isolationDir}` is deliberately none of them: it is per account and substituted
at spawn, in the `isolation` map and in a login command's `env`.

There is no token for the thread's model, effort or permission mode: a descriptor
declares one launch line and the driver is what changes it. Grok is the only one
that needs that today, and only for the permission mode: the `grok` quirk splices
`--permission-mode <mode>` before the `agent` subcommand, or `--always-approve`
after it, on the way to the spawn. A probe has no thread, so it launches the
declared line as it is.

## Managed installs

An `install` block is how Boite ships an agent whose binary is not on the machine
and which has no installer of its own: a `version`, a zip `url`, its `sha256`, its
`archiveBytes`, and every `files` entry expected out of the archive with its exact
size, the first one the executable.

`format` defaults to `zip`. A `binary` download installs one executable directly;
its single `files` entry must have the same size as `archiveBytes`. Both formats
verify the download's length and SHA-256 before making it available. Claude on
Windows uses the official x64 binary this way. Its managed copy lives under
Boite's data directory, without replacing a CLI installation elsewhere.

For a missing managed agent, `Connect an account` downloads it and starts an
isolated login after installation. Cancelling or leaving the Providers page
cancels the pending login continuation. The download itself can be cancelled
with its Cancel button. Existing CLI accounts are left unchanged.

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

Free space is checked first, against the archive plus the unpacked files plus a
256 MB margin. A cancel aborts the fetch and leaves no `.part`, and nothing goes
into the journal, so a core that dies mid-download comes back saying `absent`.
`providers.uninstall` deletes `<dataDir>/agents/<id>` and is refused while a lease
is held, and one is held for every process a thread, probe or login launched.

## What ships

Seven descriptors ship, and only the first six are ever visible to a user: `echo`
is the deterministic fake the tests and the bench run on, loaded only under
`BOITE_ECHO=1`.

| Provider | Protocol | Launched as | Isolated by | Session file | Login |
|---|---|---|---|---|---|
| Claude | `claude-sdk` | the SDK drives the CLI | `CLAUDE_CONFIG_DIR` | `.credentials.json` | `claude auth login` |
| OpenCode | `acp` | `opencode acp --port 0` | `XDG_DATA_HOME`, `XDG_CONFIG_HOME` | `opencode/auth.json` | `opencode auth login` |
| Antigravity | `acp` | `agy_acp_server.exe` from the managed install | `GEMINI_HOME`, every account | `antigravity-acp/acp_token.json` | the protocol's `authenticate` |
| Grok | `acp` | `grok [--permission-mode <mode>] agent [--always-approve] stdio` | `GROK_HOME` | `auth.json` | `grok login --device-auth` |
| Codex | `codex-appserver` | `codex app-server` | `CODEX_HOME` | `auth.json` | `codex login --device-auth` |
| pi | `pi` | `pi --mode rpc` | `PI_CODING_AGENT_DIR` | `auth.json` | none |
| Echo | `echo` | nothing | nothing | none | a script beside the descriptor |

Claude is the one whose model list is entirely in the descriptor, current and
legacy, each with its own effort scale; the other five carry `default` alone and
let the probe fill the rest. On Windows, Codex and pi are both reached around an
npm shim Bun cannot spawn, one through a vendored executable and the other
through `node`; Grok is reached through the binary its own installer puts under
`{home}/.grok/bin`, with PATH behind it.

Antigravity is the one on the managed install: its binary is nowhere until
`providers.install` downloads Google's release, so the picker offers Install
first. It is also the one whose accounts are all isolated, the descriptor says
`isolation.alwaysIsolated`, because the user's own IDE login is never what it
runs on. Four descriptor fields exist for it and are open to any provider:

- `env`, on an OS profile, is environment every process of the provider gets,
  whatever its account, unlike `isolation`. Antigravity uses it for the harness
  path and for a `BROWSER` pointed at `{browserNoop}`, a launcher that exits 0
  which the core writes once under the data directory, so the agent never opens a
  window on its own.
- `unsetEnv`, on an OS profile, names variables taken out of the inherited
  environment before the spawn, so a key the user set for their own tools cannot
  redirect the agent Boite runs.
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
plan mode. `quirks: ["grok"]` says three things
(`packages/core/src/drivers/grok.ts`). The probe reads each model's own effort
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

## The models probe

`providers.probe` spawns one short-lived process under the synthetic thread
`probe:<providerId>:<accountId>`, exactly the way a session would, so it sits in
a Job Object and in the trace like any other, then asks the protocol's own
question:

- Claude: SDK `supportedModels()` without a user prompt. Effort levels, adaptive
  thinking and Fast support come from each returned model. Descriptor effort
  controls stay hidden until that account has answered.
- ACP: `initialize` and `session/new`, then whichever of two answers the agent
  sent. `models.availableModels` wins when it is there: each entry is a model of
  its own, and under the `grok` quirk it carries its own effort scale out of
  `_meta.reasoningEfforts`, the level flagged `default: true` the one preselected.
  Otherwise the `configOptions` whose category is `model` and `thought_level` are
  read. That effort scale describes only the current model, so Boite does not
  copy it to other models. An agent that sends neither leaves the descriptor's
  models standing.
- Codex: `initialize`, the `initialized` notification, then `model/list` until no
  cursor comes back. Each model carries its own efforts and its own default, so
  two models on one account can offer two different scales. `serviceTiers` supplies
  speed choices without adding unlisted tiers. It answers before
  any login, so an unauthenticated account is no reason to skip the probe.
- pi: `get_state`, `get_available_models` and `get_available_thinking_levels`.
  Each model id carries its provider prefix, because that is what pi's `--model`
  takes and two providers can ship a name. An unauthenticated pi answers with
  nothing, so the descriptor's models are left standing rather than replaced by an
  empty list.

The child is killed through the registry on every path. The answer keeps the
descriptor's `default` first, so the choice can always go back to the agent, is
cached per provider and account until `providers.reload` or a change to that
account, and reaches every client as `providers.probed`. Two callers at once share
one process. `refresh: true` bypasses a completed cache entry, sharing any probe
already in flight. The UI keeps a persistent display cache and reads asynchronously.
A probe that finds no executable, whose agent dies or that runs past
twenty seconds throws with the reason and caches nothing. `threads.create` and
`threads.update` accept what the last probe listed on top of the descriptor's; a
model nobody probed is refused, saying to open the picker.

## Permission modes

Boite has five: `default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk`.
Each protocol takes them differently, and the difference is not cosmetic.

- ACP standardises the call, `session/set_mode`, and standardises none of the ids
  inside `availableModes`: the same mode is spelled `acceptEdits`,
  `accept_edits` and `auto_edit` by three different agents. So each Boite mode
  carries an ordered candidate list matched without case, `_` or `-`, and the
  first spelling the agent lists wins. It goes out when the session opens and
  again at the start of any turn the agent has drifted from, and it is
  deliberately not part of the session key, so a warm session follows a change
  instead of being dropped. An agent that lists no modes or refuses the call is one
  warning in the log while the turn runs anyway: a mode is a preference, never a
  reason to refuse a turn.
- Codex takes a pair when the thread opens, an approval policy and a sandbox:
  `default` and `acceptEdits` are on-request plus workspace-write, `plan` never
  plus read-only, `bypassPermissions` and `dontAsk` never plus danger-full-access.
  No call changes that pair on a live thread, so the mode is part of the session
  key: changing it drops the process and the next turn resumes with the new pair.
- pi has no approval call anywhere in its RPC mode, so `capabilities.approvals` is
  false, the thread's permission mode never reaches the agent, and each session
  says so once in the log. A driver that waited for a permission question there
  would wait forever.

A permission is not the only thing an agent asks. A protocol that carries a
free-form question maps it to `askQuestion` on the turn context, which draws a
question card in the timeline and answers the agent with what the user picked;
Codex's `item/tool/requestUserInput` is the one that does today. A question is
not a permission mode and is never gated by one: an agent whose approvals are
off can still ask.

### Codex task tracking

Boite enables `tools.update_plan.enabled` through the per-thread configuration
on both `thread/start` and `thread/resume`. Codex disables this tool by default;
listening for `turn/plan/updated` alone does not make it available to the agent.
The native plan populates the thread's activity tasks. Goal instructions explain
this mapping so the agent uses its planning tools instead of legacy Boite todos.
