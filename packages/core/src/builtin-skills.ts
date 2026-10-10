import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Skills Boite ships to every agent it runs, with or without a brain. Each is
 * written under `<dataDir>/skills/<name>/SKILL.md` the first time a session
 * guide names it, and rewritten when a new core ships a different text. The
 * agent guide lists the name, the description and the path; the body stays on
 * disk until the agent needs it, as brain skills do.
 */
export interface BuiltinSkill { name: string; description: string; body: string }

export const REPORT_ISSUE_SKILL: BuiltinSkill = {
  name: 'boite-report-issue',
  description: 'Check whether Boite itself failed (a turn, a tool, the window, the shell, a phone) from its own logs, explain it, and with the user\'s yes report it on GitHub with an anonymized export.',
  body: `# Diagnose and report a Boite problem

Use this when the user says Boite froze, crashed, lost or duplicated a message,
stopped a turn for no visible reason, or when a \`boite\` command, a tool call
or the panel failed in a way your project's code does not explain.

## 1. Read Boite's own logs

\`\`\`sh
boite logs problems --since 2h          # warnings and errors grouped, with the threads they touched
boite logs --min-level warn --since 2h  # the same records one per line, oldest first
boite logs --mine --since 2h            # this thread and the threads it started, info and up
boite logs --search <word> --since 1d   # one subsystem, a pid, an error code
boite logs --min-level debug --since 15m --origin shell   # the desktop shell's detail
\`\`\`

Each line is \`time (UTC) LEVEL origin source/event [thread provider/model <parent turn=] (duration) message {data}\`.
\`origin\` is \`core\` (the engine that runs agents), \`shell\` (the desktop
window: \`shell.main-thread.blocked\` is a frozen window) or \`ui\` (a client:
rendering errors, failed calls, reconnections). Paths, names and addresses
are placeholders such as \`<project:3fa2c1>\`, \`~\`, \`<user>\`, \`<host:9e01aa>\`.

If the command answers that agent access is off, tell the user Settings >
Diagnostics turns it on, and stop.

## 2. Explain before acting

Find the records closest to the time the user describes. Tell the user, in
plain words, what failed, since when and how often, quoting two or three
lines. Say whether it looks like a Boite bug, a provider outage, a network or
login problem, or the machine running out of memory or CPU. Only a Boite bug
goes to GitHub.

## 3. Draft, show, then submit only on the user's yes

Write the description to a file: what the user did, what they expected, what
happened, when (UTC) and how often, and the lines that show it. Never paste
conversation content, secrets or file contents.

\`\`\`sh
boite issue draft --title "<symptom in a few words>" --description-file <file>
\`\`\`

Show the user the printed draft. It is anonymized but the issue is public on
github.com/beboite/boite; let them change anything. On their explicit yes:

\`\`\`sh
boite issue submit --title "<same>" --description-file <file>
\`\`\`

\`gh: ready\` creates it with the user's own GitHub login and prints the URL.
Otherwise the output has a link that opens GitHub with the issue filled in:
give it to the user (\`boite browse <link>\` opens it in the panel), since
they need to be signed in to a GitHub account. In both cases give the path
of the full anonymized export, which they can drag into the issue.

With \`gh: ready\`, look for an existing report first:
\`gh issue list --repo beboite/boite --search "<words>" --state all\`. Add a
comment to a matching issue instead of opening a duplicate, again only on the
user's yes.
`,
};

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [REPORT_ISSUE_SKILL];

function render(skill: BuiltinSkill): string {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}`;
}

/** Writes each skill when missing or different, and returns where each lives. A write that fails leaves that skill out. */
export function ensureBuiltinSkills(dataDir: string, onError: (message: string) => void = () => {}): { name: string; description: string; path: string }[] {
  const listed: { name: string; description: string; path: string }[] = [];
  for (const skill of BUILTIN_SKILLS) {
    const directory = join(dataDir, 'skills', skill.name);
    const path = join(directory, 'SKILL.md');
    const text = render(skill);
    try {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(path, text);
      }
      listed.push({ name: skill.name, description: skill.description, path });
    } catch (error) { onError(`built-in skill ${skill.name} could not be written to ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return listed;
}

const written = new Map<string, { name: string; description: string; path: string }[]>();

/** `ensureBuiltinSkills` once per data directory and process: the guide is built every new session. */
export function builtinSkills(dataDir: string, onError?: (message: string) => void): { name: string; description: string; path: string }[] {
  let listed = written.get(dataDir);
  if (listed === undefined) { listed = ensureBuiltinSkills(dataDir, onError); written.set(dataDir, listed); }
  return listed;
}
