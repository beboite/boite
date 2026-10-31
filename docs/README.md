# Documentation

## Getting started

- [Install and update the desktop app](updates.md): downloads, stable and nightly channels, and restarting.
- [The tour](onboarding.md): first launch, language, appearance and workspace choices.
- [Accounts](accounts.md): agent sign-ins and isolated accounts on the machine running them.
- [Phone access](phone.md): pairing, mobile navigation, permissions and offline behavior.
- [Android client app](android.md): the APK that opens the phone UI and connects to an existing core.
- [Headless server](server.md): run a core with Docker or without the desktop app.
- [Android server](android-server.md): host a core and agents on a phone with Termux and the separate Boite Server app.
- [Experiments](experiments.md): switches for unfinished features. Bots and contacts remain experimental.

## Everyday work

- [Drafts](drafts.md): conversations without a project, each with a folder in Documents/Boite.
- [Model switching](model-switching.md): change models and providers in one conversation.
- [Context](context.md): usage, compaction, queued prompts, goals, loops and side questions.
- [Subagents](delegation.md): delegate to child conversations, steer them and follow their results.
- [Workflows](workflows.md): plans of delegated steps, conditions, templates and the graph.
- [The right panel](panel.md): browser, changes, files, tasks and trace beside the chat.
- [The agent's browser](browser.md): headless browser commands and watching a page from any device.
- [Devices](devices.md): simulators, emulators and connected Android devices; live video is experimental.
- [Windows](windows.md): desktop-window captures and the Window panel, with the owner's consent.
- [Virtual desktop](desktop.md): a private Linux desktop in memory where an agent runs GUI apps and drives them through their accessibility tree.
- [Chat files and previews](chat-files.md): attachments, file links, inline previews and pages drawn in an answer.
- [Diagrams and formulas](diagrams-and-formulas.md): Mermaid and LaTeX in messages.
- [Experimental view kit](view-kit.md): an opt-in composition prototype and remaining authoring, runtime and publication improvements.
- [The thread terminal](terminal.md): shells under the chat and interactive sign-ins.
- [Reviewed goals](goals.md): `/goal2`, its fresh reviewer and the checklist of the user's requests.
- [The project board](board.md): todo columns and reviewed `/goal2` work.
- [Usage](usage.md): tokens, API estimates, subscription limits and quota alerts.
- [Prompt cache timer](prompt-cache.md): experimental cache-lifetime estimates and their limits.
- [Voice dictation](voice.md): local Whisper, API transcription and microphone access.
- [Secrets](secrets.md): key-request cards, project secrets, vault storage and masking limits.
- [Keyboard shortcuts](keybindings.md): defaults and customization.
- [Pointer interactions](interactions.md): edge scrollbars and loading a thread on press.
- [Titles](titles.md): automatic and manual conversation titles.
- [Session import](imports.md): experimental import of a Claude Code conversation.
- [Agent updates](agent-updates.md): CLI update notices, automatic updates and remote machines.
- [Diagnostics](diagnostics.md): logs, anonymized exports and problem reports.

## Machines and bots

- [Machines](machines.md): connect cores, switch between them and keep each thread on its owning machine.
- [Groups](groups.md): one owner's machines and devices, invitations, addresses and trust.
- [Contacts](contacts.md): experimental collaboration with another owner on explicitly shared projects.
- [Agent coordination](coordination.md): messages between threads and machines, discussions and permissions.
- [Bots](bots.md): experimental persistent agents with their own identity, thread, memory, desk and routines.
- [Agent brain](brain.md): shared instructions, skill discovery and Git synchronization.
- [Agent hooks](hooks.md): hooks on each account and what they blocked.
- [Plugins](plugins.md): install recommended plugins or a Git URL, and write your own.
- [Task manager](trace.md#agent-task-manager): CPU, GPU, memory and storage across connected machines.
- [Restart handoff](restart-handoff.md): how an update stops running agents and resumes them.

## Technical reference

- [Contributing](../CONTRIBUTING.md): setup and checks before a pull request.
- [Development](development.md): local runs, test fixtures and captures.
- [Adding an RPC method](development.md#adding-an-rpc-method): contracts, permissions and real/fake parity.
- [Architecture](architecture.md): the core, clients, journal and drivers.
- [Providers](providers.md): descriptors, protocols and supported capabilities, including experimental providers.
- [Context modes](context-modes.md): instruction, guide, hook and tool isolation, with provider-specific support.
- [The `boite` CLI](cli.md): commands an agent uses to reach its thread and panel.
- [Process tracing](trace.md): process ownership, resource protection and platform limits.
- [Platform readiness](portability.md): Linux and macOS installation checks and remaining desktop gaps.
- [Performance](performance.md): payloads, startup behavior and dated benchmark results.
- [Project icons](project-icons.md): image discovery, bounds and delivery to clients.
- [Language](language.md): translation catalogs and adding a language.
- [Analytics](analytics.md): telemetry consent, collected fields and data controls.
- [Admin policy](enterprise.md): the machine-wide file that locks updates, providers, analytics and network features.
- [Network flows](network.md): every outbound connection, what it sends and the policy key that blocks it.
- [CI](ci.md): checks, caches, nightly builds and image publication.
- [Releasing](releasing.md): artifacts, signing, channels and versioning.
- [Release reports](releases/2.0.0-beta.1.md): the first beta's historical scope and measurements.
- [Repository rules](../AGENTS.md): boundaries contributors must preserve.
