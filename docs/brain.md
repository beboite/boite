# Agent brain

Settings > Brain connects an existing folder on the selected core's
machine. Browse folders or enter its absolute path, then select Connect folder.
Each core stores its own path, so the
same repository can live at different locations on different computers.

Only owners can inspect or configure a brain and synchronize it. A paired
device cannot call these methods. An owner using a phone-sized browser has the
same controls. The connected folder shows Synchronize and a Use with agents
switch, which saves immediately. Change folder reveals the path editor and
Disconnect, which removes the setting and leaves the files alone.
Instructions, Skills and Plugins each have a tab with a count. Select a file
to expand its description and path; Git details stay under Sync details.

## Detection

Boite reads these instruction entrypoints at the folder root: `AGENTS.md`,
`.agents/AGENTS.md`, `CLAUDE.md` and `GEMINI.md`.

The catalog scans `skills`, `.agents/skills`, `.claude/skills`, `.codex/skills`,
`plugins`, `.claude/plugins` and `.codex/plugins`. A skill is a `SKILL.md` with
YAML frontmatter containing a nonempty name and description. An agent plugin
has a `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` manifest with
a nonempty name. Malformed entries remain visible with their file and reason.

Links inside the folder are followed once; links outside it are reported and
not read. Git metadata, dependencies and secret directories are skipped.
Inventory is bounded to 500 entries, 2,000 directories, six nested levels and
64 KiB per file. Reaching a bound appears as a problem in the inventory.

Plugin detection does not install or enable a plugin. The agent's own plugin
manager still owns that operation. This catalog is separate from Boite's
native extensions in Settings > Plugins. It does not inventory other agent
profiles elsewhere on the machine.

## Instructions in conversations

When sharing is enabled, the core prepends the contents of the two `AGENTS.md`
entrypoints and the valid skill names, descriptions and absolute paths to
normal turns. Claude additionally gets `CLAUDE.md`; Antigravity gets `GEMINI.md`.
Skill bodies stay on disk for the agent to read when needed. Project instruction
files still follow each agent's native discovery rules.

The shared driver context carries the prefix, including on warm sessions.
The user's journalled message remains unchanged. Entry files and the catalog
are reread for each normal turn, so a refresh or process restart is unnecessary.
Missing folders or unreadable instruction files fail the turn instead of silently
dropping their content. The combined prefix is limited to 128 KiB.

Native slash commands, compaction and agent coordination turns do not receive
the prefix. Disconnecting a brain stops future injection but cannot remove
instructions already present in an agent's conversation history. Start a new
thread when previous instructions must leave the context.

## Synchronization

Use an existing Git checkout with a configured upstream on each computer.
Git and authentication must already work on the machine hosting that core.
A plain folder works for instruction sharing, without synchronization.

Synchronize fetches the configured remote, fast-forwards incoming commits and
pushes outgoing commits to the upstream branch. It never stages, commits,
stashes, resets, force-pushes or resolves conflicts. Local file changes,
diverging histories, detached HEAD and a missing upstream stop the operation.
Commit changes with Git before synchronizing. A second click cannot run a
concurrent synchronization, and the folder cannot change during one.
If the branch, upstream or HEAD changes during fetch, synchronization stops.
Outgoing pushes name the checked commit rather than a mutable HEAD.

Boite records the last successful synchronization for this folder. The commit
counts use local Git knowledge, refreshed by Synchronize. Authentication is
noninteractive, repository hooks are disabled for these operations, and each
Git command has a 30-second deadline. Git runs through the process registry
and is stopped when the core closes.

This version does not clone repositories, commit edits, schedule background
synchronization or copy files directly between machines.

## Verification

`bun test packages/core/test/brain.test.ts` exercises detection, invalid entries,
links, owner access, instruction delivery and synchronization between two
temporary checkouts through a local bare remote. No personal brain is read.

`bun test tests/e2e/brain.test.ts` exercises the settings flow, errors and
disconnect through the in-memory client. Desktop and phone captures go to
`tests/e2e/.artifacts/brain-*.png`. This does not test provider-side plugin
loading, a live model, hosted Git authentication or a second physical machine.
