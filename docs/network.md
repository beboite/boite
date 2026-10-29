# Network flows

Every connection Boite opens beyond the machine it runs on, when it fires, what
it sends, how a user turns it off and the [admin policy](enterprise.md) key that
blocks it. Inventory taken from `origin/main` at `1654f1b0` (2026-10-28) over
the core, the UI, the desktop shell, the CLI and plugins.

Not listed: what an agent CLI sends to its model provider during a turn (choose
the agents with `providers.allow` or `providers.deny`), build and CI scripts,
the Android apps, and loopback-only traffic (local gateways, the speech server,
the OpenCode server, protected bridges, health checks).

| # | Flow | Destination | When | Data sent | Default | User switch | Policy key |
|---|---|---|---|---|---|---|---|
| 1 | Usage analytics | The analytics relay (`DEFAULT_TELEMETRY_URL` in `packages/core/src/telemetry.ts`), which forwards to the analytics store | Queue flushed every 5 min, a daily ping, product events | Install UUID (hashed by the relay in basic mode), event, time, app and OS version, arch, provider, outcome, durations; enhanced adds model, effort, permission mode, rounded token counts. The relay sees the IP | Basic, in published builds only | Settings > General > Privacy and analytics: Off; `BOITE_TELEMETRY_URL=""` | `analytics` |
| 2 | Analytics consent receipt | Same relay, `POST /consent` | The user picks a mode in the tour or Settings | Mode, receipt UUID, IP | On an explicit choice | `BOITE_TELEMETRY_URL=""` | `analytics` |
| 3 | Analytics deletion and export | Same relay, `POST /forget`, `POST /export` | Leaving enhanced mode (retried until accepted), Export | Enhanced install UUID | After enhanced was on | None: it is the deletion path | `analytics` (`off` holds a pending deletion until the key allows it) |
| 4 | Desktop app update check | GitHub releases API and release assets of the app's repository | 8 s after the window opens, every 6 h, on focus after 15 min, Check for updates | GET, user agent, IP | On, desktop app only | None | `updates.app: "off"` |
| 5 | Desktop app update download | GitHub release assets | Update click; by itself when automatic installs are on | GET, IP | On click; automatic off | `autoInstallUpdates` | `updates.app` (`off` refuses it, `check` locks automatic installs off) |
| 6 | Server core update check | GitHub releases API | Standalone Linux server: 8 s after start, every 6 h, when an owner connects after 15 min | GET, IP | On for a standalone server | None | `updates.server: "off"` |
| 7 | Server core update download | GitHub release asset | Update click on the server's row | GET, IP | No | Do not click | `updates.server: "off"` |
| 8 | Agent version check (npm) | `registry.npmjs.org/<package>/latest` | 10 min after start, every 6 h, Check for updates | Package name, IP | On for each enabled agent | Turn the agent off | `updates.agents: "off"`; a provider the policy blocks is never checked |
| 9 | Agent version check (vendor manifest) | `downloads.claude.ai` release manifest | As row 8, for a Claude Boite installed | GET, IP | On | Turn Claude off | `updates.agents: "off"` |
| 10 | Agent version check run by the agent | The agent vendor, through the agent's own updater | As row 8 | What that updater sends | On while that agent is enabled | Turn the agent off | `updates.agents: "off"` |
| 11 | Agent update | The vendor's updater, `registry.npmjs.org`, or the hosts of row 12 | Update click; by itself when automatic updates are on | Package and version, IP | On click; automatic off | `autoUpdateHarnesses` | `updates.agents` (`off` refuses it, `check` locks automatic updates off) |
| 12 | Agent managed install | `downloads.claude.ai`, GitHub releases of Codex and OpenCode, `dl.google.com`, `lookaside.facebook.com` | Install click | GET with range resume, IP | No | Do not click | `providers.allow` / `providers.deny` for a blocked provider; user-initiated for an allowed one |
| 13 | Claude quota read | `api.anthropic.com/api/oauth/usage` | Limits page, sidebar bars (60 s cache), limit auto-resume | The account's OAuth token | On per account | Per-account quota switch | `quotaReads: false` |
| 14 | Claude quota reset | `api.anthropic.com` usage and reset endpoints | Reset click on Limits | OAuth token, organization id | No | Do not click | `quotaReads: false` |
| 15 | Codex quota read and reset | OpenAI, through a `codex app-server` Boite starts | As rows 13 and 14 | The account's credentials, used by the CLI | On per account | Per-account quota switch | `quotaReads: false` |
| 16 | Antigravity quota read | `oauth2.googleapis.com`, `cloudcode-pa.googleapis.com` and its daily host | As row 13 | OAuth client and refresh token, access token, project id | On per account | Per-account quota switch | `quotaReads: false` |
| 17 | Grok quota read and token renewal | `auth.x.ai`, `cli-chat-proxy.grok.com` | As row 13 | Refresh token, client id, access token | On per account | Per-account quota switch | `quotaReads: false` |
| 18 | OpenCode Go quota read | `opencode.ai/zen/go/v1/usage` | As row 13 | OpenCode Go API key | On per account | Per-account quota switch | `quotaReads: false` |
| 19 | Subscription gateway | The gateway URL the user saved | Model discovery, Limits, gateway checks while it is on | Gateway key, model and quota requests | No | Gateway switch off | `gateway: false`, or `gateway.allowedBaseUrls` |
| 20 | Credential move to a gateway | The saved gateway, `POST /admin/api/accounts/import` | The user confirms Move | The selected accounts' credential files and API keys | No | Do not use | `gateway: false` |
| 21 | Recommended plugin update check | GitHub repositories of the recommended plugins (`git fetch --depth 1`) | 1 min after start, every 6 h, opening Settings > Plugins, before install | Git request, IP | On once one is installed; Settings > Plugins always checks | Uninstall the plugin | `plugins.recommended: false` |
| 22 | Plugin install from a URL | The https Git repository the user pastes | Add from URL | Git fetch | No | Do not use | `plugins.install: false` |
| 23 | Plugin artifact download | Release assets the plugin's manifest names | Install, Update, Reinstall | GET, IP | No | Do not click | `plugins.install: false` |
| 24 | A plugin's own traffic | Whatever the plugin reaches | While an installed plugin runs | What the plugin sends | Runs after install | Stop it, Start with Boite off, uninstall | None: the plugin is a program the user installed; `plugins.install: false` keeps new ones out |
| 25 | Cloud dictation | `api.groq.com`, `openrouter.ai` transcription endpoints | Each dictation with the API engine, or the fallback | Audio, language, the API key | No | Settings > Voice: Local, fallback off | `dictation: "local"` or `"off"` |
| 26 | Local dictation download | `huggingface.co`, `registry.npmjs.org`, whisper.cpp GitHub releases | Set up dictation, pick a new model | GET, IP | No | Do not set up | `dictation: "off"`; user-initiated under `local` |
| 27 | Custom dictation model | The Hugging Face URL the user gives | Add a model from a link | GET | No | Do not use | `dictation: "off"` |
| 28 | Web Push | The browser vendor's push service (`fcm.googleapis.com`, `*.push.apple.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`) | Each notification for a device that enabled them | Encrypted title, body, thread and kind; VAPID signature | No | Disable on the device | `network.push: false` |
| 29 | Issue report | GitHub, through the user's `gh`, or a prefilled issue page | Report an issue click | Anonymized title, description and logs, the user's GitHub identity | No | Do not click; untick logs | `issueReports: false` |
| 30 | Pull request discovery, watch and archive | GitHub, through the user's `gh` | Sidebar discovery, linked PR panel, `boite pr watch`, merged-PR sweep | Repository, branch, PR URLs, the user's `gh` token | On when `gh` is signed in | Per-project merged-PR archive switch | `pullRequests: false` |
| 31 | Brain sync | The brain checkout's Git remote | Synchronize click; automatic pull when set | Git fetch; a push of local brain commits on manual sync | No | Automatic pull off; Disconnect | None: user-initiated, to a remote the user configured, off by default |
| 32 | Agent browser | Any site the agent or the user opens; a search page for text typed in its address bar | `boite browser` commands, panel navigation | Page traffic with the profile's cookies | On | None | `agentBrowser: false`; `agentBrowser.searchUrl` sets the search page |
| 33 | Agent-made HTML previews | Any URL the page references | A client opens a preview or `boite view` page | Client IP, referrer, what the page's script sends | On | None | `previews.remoteResources: false` |
| 34 | Group machine-to-machine requests | Other members' public URL, MagicDNS name, tailnet or LAN address | While in a group | Signed and sealed requests | No | Leave the group, `groupBots` off, `BOITE_TAILNET=0` | `network.groups: false` |
| 35 | Group relay socket | A member reached through another | A client reaching a member it cannot dial | Signed hello, relayed frames | No | Leave the group | `network.groups: false` |
| 36 | Tailnet name lookup | `100.100.100.100`, the local Tailscale resolver | Computing group addresses | PTR query for the machine's tailnet IP | On when Tailscale is up | `BOITE_TAILNET=0` | None: answered by the Tailscale daemon on the machine |
| 37 | Clients to connected machines | The local core or machine URLs the user added | While connected | RPC, attachment downloads | Local core only | Remove the machine | None: user-initiated, to machines the user added |
| 38 | Contacts: Tailscale API | `api.tailscale.com/api/v2` | Invite, join, Contacts page (60 s cache) | Tailscale API key, tailnet IP, device id | No: needs a stored key | Remove the key | `network.contacts: false` |
| 39 | Contact join and link | The inviter's tailnet name or Funnel address | Pasting a link, kept links, contact requests | Core id, keys, machine name, one-time token, then sealed requests | No | Remove the contact | `network.contacts: false` |
| 40 | Contact routes on Tailscale Funnel | The public internet, through Funnel on port 8443 | An "Elsewhere" invitation | Exposes `/contacts/*` publicly | No | Cancel invitations | `network.contacts: false` (refused; routes kept from before close at startup) |
| 41 | Funnel reachability check | `dns.google`, `cloudflare-dns.com`, then the machine's own Funnel address | After an "Elsewhere" invitation and at start while routes are up | Funnel host name, an empty join request | No | As row 40 | `network.contacts: false` |
| 42 | Tailscale Serve | Tailscale HTTPS on 443 and its certificate | Tailscale switch, `boite-core tailscale on` | Runs `tailscale serve` | No | Switch off | `network.tailscaleServe: false` |
| 43 | Agent sign-in | The agent vendor's login, run by the CLI | Connect click on Providers | The vendor's OAuth, handled by the CLI | No | Do not click | `providers.allow` / `providers.deny` for a blocked provider; user-initiated for an allowed one |
| 44 | External links | Docs, Tailscale admin, release notes, runtime downloads, in the system browser | A click | A normal browser request | No | Do not click | None: opened by the user in the system browser, outside Boite |

## Flows with no user switch

Each one is either blocked by a policy key or started by the user:

- Rows 4 and 6, the app and server update checks: `updates.app`, `updates.server`.
- Row 8, agent version checks: `updates.agents`.
- Row 21, recommended plugin checks, including on opening Settings > Plugins: `plugins.recommended`.
- Row 30, pull request discovery and watch: `pullRequests`.
- Row 32, the agent browser: `agentBrowser`.
- Row 33, remote resources in previews: `previews.remoteResources`.
- Rows 5, 7, 20, 22, 23, 26, 27 and 29, downloads, installs, credential moves
  and reports the user clicks: blocked by `updates.app`, `updates.server`,
  `gateway`, `plugins.install`, `dictation` and `issueReports`.
- Rows 12 and 43, agent installs and sign-ins: blocked for a provider outside
  `providers.allow` or in `providers.deny`; for an allowed provider they run
  only on the user's click, since choosing the agent is the administrator's
  decision and installing it is the user's.
- Rows 31, 37 and 44: user-initiated toward a destination the user chose, as
  the table says.
