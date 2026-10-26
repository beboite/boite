# Documentation

## Using boite

- [Desktop updates](updates.md): Boite, Boite Nightly, downloads and restarting.
- [Restart handoff](restart-handoff.md): how an update stops running agents and resumes them.
- [The tour](onboarding.md): the first launch, and what it sets up.
- [Language](language.md): English and French, and where the sentences live.
- [Drafts](drafts.md): conversations with no project, a folder each in Documents/Boite.
- [Project icons](project-icons.md): the logo or stack mark each project shows, and where it is found.
- [Accounts](accounts.md): agent logins and isolated accounts.
- [Agent updates](agent-updates.md): update notices, the automatic update and remote machines.
- [Agent brain](brain.md): shared instructions, skill discovery and Git synchronization.
- [Agent hooks](hooks.md): each agent's hooks on every account, and what they blocked.
- [Secrets](secrets.md): API keys an agent asks for on a card and uses by ref, the system vault, keys kept for a project and what masking does not cover.
- [Model switching](model-switching.md): changing models and providers in one conversation.
- [Context](context.md): context usage and compaction.
- [Prompt cache timer](prompt-cache.md): how long a thread's cache stays warm, per provider, and the sources.
- [Agent coordination](coordination.md): messages between agents, machine links and limits.
- [Groups](groups.md): machines that connect to each other, their phones, Tailscale addresses and trust.
- [Contacts](contacts.md): another owner's Boite linked over Tailscale, the projects each side opens and requests between their agents.
- [Bots](bots.md): Boite's persistent agents, a thread with an identity: the CLI, the guide, its wakes, quiet turns, context block, memory, desk, routines, budget, status and migration.
- [Subagents](delegation.md): child conversations on by default, model profiles, live steering and usage.
- [Workflows](workflows.md): JSON plans of delegated steps, fan-out, conditions, templates and the graph.
- [Context modes](context-modes.md): starting a conversation without the user's instruction files, guides, MCP servers or hooks, with rules of its own.
- [Usage](usage.md): tokens, API cost and limits per day, provider and model.
- [Analytics](analytics.md): optional telemetry, consent, collected fields and data controls.
- [Diagnostics](diagnostics.md): Boite's own logs, the Settings page, anonymized exports, issue reports and what a client reports.
- [Keyboard shortcuts](keybindings.md): defaults and customization.
- [The right panel](panel.md): browser, changes, files, tasks, workflows and trace beside the chat.
- [The agent's browser](browser.md): the headless browser an agent drives on its machine, watched from any device.
- [Devices](devices.md): iOS Simulators and Android emulators the agent opens in the Device panel.
- [Windows](windows.md): desktop windows an agent captures as a PNG or contact sheet, or shows in the Window panel, with the owner's consent.
- [Chat files and previews](chat-files.md): files an agent publishes, file links, inline previews, and the pages an agent draws in its answer.
- [Diagrams and formulas](diagrams-and-formulas.md): Mermaid blocks and LaTeX formulas drawn in Markdown, loaded on demand and sanitized.
- [Experimental view kit](view-kit.md): an opt-in composition prototype and remaining authoring, runtime and publication improvements.
- [Experiments](experiments.md): bots, contacts, reviewed goals and other unfinished switches.
- [Pointer interactions](interactions.md): edge scrollbars and loading a thread on the press.
- [The thread terminal](terminal.md): the shell under the chat, and sign-ins that need one.
- [The project board](board.md): the project's todos in four columns in the terminal's drawer, a card started as a `/goal2`.
- [The `boite` CLI](cli.md): what an agent runs to reach its thread and its panel.
- [Titles](titles.md): automatic and manual conversation titles.
- [Session import](imports.md): bringing in a Claude Code conversation.
- [Phone access](phone.md): pairing, permissions and offline behavior.
- [Android app](android.md): the nightly APK, one built for another host, and its signing key.
- [Android server](android-server.md): Boite on a phone in Termux, the Boite Server app and keeping it running.
- [Voice dictation](voice.md): local Whisper, API transcription and microphone access.
- [Headless server](server.md): Docker, persistent storage and remote access.
- [Plugins](plugins.md): recommended plugins, adding one from a git URL, and writing your own.

## Building and contributing

- [Contributing](../CONTRIBUTING.md): setup and checks before a pull request.
- [Development](development.md): local runs, test fixtures and captures.
- [Adding an RPC method](development.md#adding-an-rpc-method): contract, domain handlers, permissions and refusal tests.
- [Architecture](architecture.md): the core, clients, journal and drivers.
- [Providers](providers.md): descriptors, protocols and supported capabilities.
- [Process tracing](trace.md): resource use and platform limits.
- [Platform readiness](portability.md): Linux and macOS checks and remaining desktop gaps.
- [Performance](performance.md): what a remote client is sent, startup, and the benches that measure both.
- [CI](ci.md): checks, caching, nightly builds and image publication.
- [Releasing](releasing.md): installers, channels and versioning.
- [Release reports](releases/2.0.0-beta.1.md): the first beta's scope and measurements.
- [Repository rules](../AGENTS.md): boundaries a contributor must preserve.
