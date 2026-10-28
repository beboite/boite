# Admin policy

An administrator can lock what Boite does on a machine with one JSON file.
Every key is optional. A key that is absent leaves the choice to the user, and
a machine without the file behaves exactly as before. The core enforces the
file: a client, the `boite` CLI or an agent asking for something a key forbids
gets a refusal that names the key and the file. Every outbound connection and
the key that governs it are listed in [network](network.md).

## Where the file goes

| Platform | Path |
|---|---|
| Linux | `/etc/boite/policy.json` |
| macOS | `/Library/Application Support/Boite/policy.json` |
| Windows | `%ProgramData%\Boite\policy.json` |

Only when no file exists at that path does the core read the file named by the
`BOITE_POLICY_FILE` environment variable. This suits a container or a server
whose administrator cannot write to the system location. A user who can set
environment variables can also point it elsewhere, so a machine-wide policy
belongs at the system path, writable only by administrators.

The core looks at the file every 3 seconds (a `stat`; the file is read only
when its inode, size or modification time changed) and on every client read
of the policy. An edit applies without a restart: settings it locks change at
once, providers it blocks show as off, and clients receive `policy.changed`.
Two exceptions need a restart: `network.lan` decides the listening address at
startup, and `network.contacts` closes Tailscale Funnel routes at startup.

Windows registry policies are not read yet; the file is the only source.

## Keys

| Key | Values | Effect |
|---|---|---|
| `analytics` | `"off"`, `"basic"` | `off` sends nothing to the analytics relay, consent receipts, deletions and exports included. `basic` allows Off or Basic and refuses Enhanced. |
| `updates.app` | `"off"`, `"check"`, `"auto"` | Desktop app updates. `off` stops the check and the download. `check` lets the user see and install an update but turns off automatic installs. `auto` turns automatic installs on. |
| `updates.server` | `"off"`, `"check"`, `"auto"` | Updates of a standalone server core. `off` stops the release check and the install. `check` and `auto` both allow the check and a manual install; the server never installs by itself. |
| `updates.agents` | `"off"`, `"check"`, `"auto"` | Agent CLI updates. `off` stops version checks and updates. `check` turns automatic updates off; `auto` turns them on. |
| `providers.allow` | array of provider ids | Only these providers may run. Every other one is off and cannot be turned on, installed, probed or signed in. |
| `providers.deny` | array of provider ids | These providers are off, as above. |
| `gateway` | `false`, or `{ "allowedBaseUrls": [...] }` | `false` turns any subscription gateway off and refuses configuring one, its key, its quotas and credential moves. With `allowedBaseUrls`, only a gateway whose address starts with one of these URLs (on a path boundary) may be used. |
| `quotaReads` | `false` | No quota read sends an account's token to its provider. Limits rows read "disabled" with the reason; quota resets are refused. |
| `plugins.install` | `false` | No plugin install, reinstall or update, from the catalog or from a Git URL. Installed plugins keep running. |
| `plugins.recommended` | `false` | The recommended plugins' Git sources are never fetched for update checks. |
| `issueReports` | `false` | Report an issue is refused; nothing goes to GitHub. |
| `dictation` | `"local"`, `"off"` | `local` refuses cloud transcription engines and the cloud fallback. `off` refuses dictation and its downloads. |
| `previews.remoteResources` | `false` | Agent-made HTML previews and views may load only their own files: a content security policy blocks remote scripts, images, styles, fonts and requests. |
| `agentBrowser` | `false`, or `{ "searchUrl": "https://...{query}..." }` | `false` refuses every agent browser command, from an agent, the CLI or the panel. `searchUrl` is the address used for text typed in the browser's address bar that is not a URL; it must be https and contain `{query}`. |
| `network.lan` | `false` | The core listens on loopback only, whatever the setting or `--lan`/`--host` say. An explicit loopback `--host` is kept. |
| `network.tailscaleServe` | `false` | Serving the core over Tailscale HTTPS is refused. |
| `network.groups` | `false` | Creating, joining and inviting to groups is refused, group exchanges with other machines stop, the extra tailnet listener closes, and the group settings are off. |
| `network.contacts` | `false` | Contacts, invitations and the Tailscale API are refused, kept links are not dialed, and Funnel routes close at startup. |
| `network.push` | `false` | Web Push subscriptions are refused and nothing is sent to subscriptions kept from before. |
| `pullRequests` | `false` | Boite runs no `gh` command: pull request discovery, linking, watching and the merged-PR archive stop. |

`true` on a boolean key, or a missing key, leaves the choice to the user. A
setting a key locks reads back with the locked value, and an attempt to change
it is refused. The user's own stored choice is kept: removing the key brings it
back.

## Examples

Cloud agents allowed, nothing sent to the project:

```json
{
  "analytics": "off",
  "issueReports": false,
  "plugins": { "recommended": false },
  "updates": { "app": "check", "server": "check", "agents": "check" }
}
```

Local models only, nothing leaves the machine but what the user opens:

```json
{
  "analytics": "off",
  "updates": { "app": "off", "server": "off", "agents": "off" },
  "providers": { "allow": ["opencode"] },
  "gateway": false,
  "quotaReads": false,
  "plugins": { "install": false, "recommended": false },
  "issueReports": false,
  "dictation": "local",
  "previews": { "remoteResources": false },
  "agentBrowser": false,
  "network": { "lan": false, "tailscaleServe": false, "groups": false, "contacts": false, "push": false },
  "pullRequests": false
}
```

The provider listed must be configured for a local model server; the policy
does not inspect where an allowed agent sends its own model traffic.

## A bad file

A bad file never stops the core.

- A file that is not valid JSON, is not a JSON object, cannot be read or is
  larger than 256 KB fails closed: every key takes its strictest value, as in
  the "local models only" example with `providers.allow` empty, until the file
  is fixed.
- In a file that parses, a key with a bad value takes that key's strictest
  value, an unknown key is ignored, and every other key applies.

Each problem names the file, the field and the value expected, for example
`/etc/boite/policy.json: dictation is "cloud"; expected "local" or "off"`. It is
logged with source `policy` and returned to clients in `policy.get`.

## What clients see

`policy.get` returns the file path, whether it exists, the parsed values, the
locked keys, the problems and whether the file failed closed. The core pushes
the same state as `policy.changed` when the file changes. Paired devices may
read it, so a phone shows which controls are locked and why. A refusal is an
RPC error with code `Refused` and `data: { policy, file }`; a provider the
policy blocks carries the same `policy` object in its summary.

The desktop shell reads the same file for `updates.app` before it checks for
or downloads an app update.
