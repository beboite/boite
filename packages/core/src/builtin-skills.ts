import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
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
  description: 'Check whether Boite itself failed (a turn, a tool, the window, the shell, a phone) from its own logs, explain it, and draft a GitHub issue with an anonymized export that the user publishes.',
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

## 3. Draft, show, and let the user publish it

Write the description to a file: what the user did, what they expected, what
happened, when (UTC) and how often, and the lines that show it. Never paste
conversation content, secrets or file contents.

\`\`\`sh
boite issue draft --title "<symptom in a few words>" --description-file <file>
\`\`\`

Show the user the printed draft. It is anonymized but the issue is public on
github.com/beboite/boite; let them change anything. An agent never publishes
it: the issue goes out under the user's own GitHub account, by their hand.
The draft prints a link that opens GitHub with the issue filled in; give it
to the user (\`boite browse <link>\` opens it in the panel) so they submit it
there, signed in to their GitHub account, or from Settings > Diagnostics,
which creates it with \`gh\` when it is signed in. Give the path of the full
anonymized export too, which they can drag into the issue.

With \`gh: ready\`, look for an existing report first:
\`gh issue list --repo beboite/boite --search "<words>" --state all\`, and
give the user the matching issue so they comment there instead of opening a
duplicate.
`,
};

export const PROVE_IT_SKILL: BuiltinSkill = {
  name: 'boite-prove-it',
  description: 'Check that a change works before calling it done, and put the proof in the answer: the deciding output, a capture, a clip or a chart.',
  body: `# Prove it

A change is done once you have seen it work. Size the check to the change: a
typo needs none, a refactor needs its tests, a bug fix needs the symptom gone,
a change on screen needs a look at the screen.

## Check

- Run the project's own commands (tests, type check, build) on the final
  state. After a later edit, rerun only what it touched.
- A bug: reproduce it first when you can, then show it no longer happens.
- A visual change: capture the screen the user would look at and open the
  image yourself. Desktop first, phone when the change reaches it.
- Another agent's work: read its diff and its deciding output before you rely
  on it.
- When a login, a device or production stands in the way, run the closest
  thing that does run and say what stays unchecked. A check you did not run
  never passed.

## Show

Put the proof where the user reads, in the answer:

| Proof | How |
|---|---|
| A command's result | The one deciding line, such as \`42 pass, 0 fail\` |
| A screen, a render, a clip | \`boite attach <file>\` |
| Before and after | Both files attached, or one \`boite view\` page side by side |
| Numbers, a timeline, a comparison | A \`\`\`mermaid fence in the answer (xychart-beta, timeline) or a table |

A link to a Markdown report proves nothing to the user: it opens as raw text.
Notes for the next agent go in the project's docs, not in the answer.

Close with what you ran, what it showed and what you did not verify, in one
or two lines.
`,
};

export const VISUAL_SKILL: BuiltinSkill = {
  name: 'boite-visual',
  description: 'A visual beyond a mermaid fence: a boite view page (simulator, animation, controls) or an HTML file to keep, what to draw and how to check it.',
  body: `# Show it visually

Four ways, four jobs:

| Way | For |
|---|---|
| A \`\`\`mermaid fence or TeX in your answer | A diagram, a chart or a formula. No command: chat draws it. The default. |
| \`boite view <page.html>\` | A page drawn in your answer, after the paragraph it explains, in the app's look: what Mermaid cannot draw, such as a simulator, an animation or controls. |
| \`boite attach <file>\` | A file the user keeps or opens elsewhere: a capture, a clip, a PDF, a standalone HTML page. |
| \`boite preview <file.html>\` | The project's own HTML, opened in the panel to try. |

Read \`boite view help\` before your first page: it gives the page rules,
classes and colors. This skill is about what to draw.

## Start from the question

Name the one question the reader has, then draw what answers it:

| Question | Drawing |
|---|---|
| In what order? | A connected sequence with inputs, outputs and failure branches |
| What belongs where? | A map with boundaries and what crosses them |
| What if I pick this? | A switch that changes the diagram and its consequence together |
| Why did it fail? | The expected path and the point where the real one stopped |
| Which option? | The options side by side, the deciding difference marked |
| How much? | A chart with real values, units and a baseline |

A row of cards shows no cause and effect: draw the arrows and label what
travels along them.

## Keep it honest and small

- Separate what was done and checked, what is proposed and what is unknown.
  Mark invented example values as examples.
- The first screen carries the answer; optional depth goes in \`<details>\`.
- A control earns its place when using it changes what the reader sees. No
  tabs that only split paragraphs.
- Use the user's language and words, and define a term the first time.
- Keep your written answer short and do not repeat what the page shows.

## A file to keep

When the user wants something to keep, share or print, write one
self-contained HTML file (inline CSS and JavaScript, embedded images, nothing
loaded from the network) and send it with \`boite attach\`. Check the same
file as below, then run \`boite view\` to show it in the chat as well.

## Check

Run \`boite view check <page.html>\` before publishing. It embeds the local
assets and loads the page with the view's kit and sandbox at desktop and
phone content widths (816 and 330 px), without creating any message,
artifact, tab or panel. It saves uniquely named PNGs in your current
directory. Open both captures, fix what you see and rerun the check.

For controls, write a local \`checks.js\` and run
\`boite view check <page.html> --script checks.js\`. The file is the body of
an async function, without a function wrapper. It runs after a fresh page
load at each width. Use DOM clicks and input/change events to exercise every
control, await updates, throw an Error when an assertion fails, and return
JSON values that show the resulting state. The captures show that state
after the script, even when it throws. Open those captures too.

The check uses the app's fallback palettes and fonts, not the connected
client's custom theme or selected fonts. Use \`--scheme light\` to check the
light palette; dark is the default. Errors or an unavailable browser exit
nonzero after saving available captures; \`--json\` returns capture paths.
Fix errors and advice before publishing with \`boite view <page.html>\`,
then place the page in your answer with the printed image line.
`,
};

/** The diagnostic skill comes first: it is listed only while agents may read the logs. */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [REPORT_ISSUE_SKILL, PROVE_IT_SKILL, VISUAL_SKILL];

function render(skill: BuiltinSkill): string {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}`;
}

function kind(path: string, wanted: 'file' | 'directory'): boolean {
  try { const stat = lstatSync(path); return wanted === 'file' ? stat.isFile() : stat.isDirectory(); } catch { return false; }
}

/**
 * Never wait on the open: a pipe swapped in after `kind` would otherwise block
 * the core's event loop until someone opened its other end. Windows has no such files.
 */
const NONBLOCK = constants.O_NONBLOCK ?? 0;

/**
 * Whether the file holds exactly `text`. An agent can rewrite it, even swap it
 * between two calls: one descriptor, opened without following a link or waiting,
 * gives the kind, the size and the bytes, and never more than `text` and one byte are read.
 */
function holds(path: string, text: string): boolean {
  const expected = Buffer.from(text, 'utf8');
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | NONBLOCK); } catch { return false; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== expected.length) return false;
    const buffer = Buffer.alloc(expected.length + 1);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return read === expected.length && buffer.subarray(0, read).equals(expected);
  } finally { closeSync(fd); }
}

/**
 * Writes `text` into a regular file only, without following a link or waiting on a pipe
 * swapped in after the checks. Such a thing is removed once, and the second open must
 * create the file itself (`O_EXCL`); a second swap fails rather than write anywhere else.
 */
function write(path: string, text: string): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0) | NONBLOCK;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | null = null;
    try { fd = openSync(path, attempt === 0 ? flags : flags | constants.O_EXCL, 0o644); }
    catch (error) {
      // A link (ELOOP) or a pipe nobody reads (ENXIO).
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === 0 && (code === 'ELOOP' || code === 'ENXIO')) { rmSync(path, { force: true }); continue; }
      throw error;
    }
    try {
      if (!fstatSync(fd).isFile()) {
        closeSync(fd); fd = null;
        if (attempt === 0) { rmSync(path, { force: true }); continue; }
        throw new Error(`${path} is not a regular file`);
      }
      // A short write (a full disk) must not leave a cut skill listed as whole.
      const data = Buffer.from(text, 'utf8');
      for (let offset = 0; offset < data.length;) {
        const written = writeSync(fd, data, offset);
        if (written <= 0) throw new Error(`${path}: short write`);
        offset += written;
      }
      return;
    } finally { if (fd !== null) closeSync(fd); }
  }
}

/** Writes each skill when missing or different, and returns where each lives. A write that fails leaves that skill out. */
export function ensureBuiltinSkills(dataDir: string, onError: (message: string) => void = () => {}): { name: string; description: string; path: string }[] {
  const listed: { name: string; description: string; path: string }[] = [];
  for (const skill of BUILTIN_SKILLS) {
    const directory = join(dataDir, 'skills', skill.name);
    const path = join(directory, 'SKILL.md');
    const text = render(skill);
    try {
      // Anything but a plain folder and file there (a link, a folder named SKILL.md) is replaced.
      if (!kind(directory, 'directory')) rmSync(directory, { recursive: true, force: true });
      if (!kind(path, 'file')) rmSync(path, { recursive: true, force: true });
      if (!kind(path, 'file') || !holds(path, text)) {
        mkdirSync(directory, { recursive: true });
        write(path, text);
      }
      listed.push({ name: skill.name, description: skill.description, path });
    } catch (error) { onError(`built-in skill ${skill.name} could not be written to ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return listed;
}

/**
 * `ensureBuiltinSkills` on every guide build, never from a cache: an agent runs
 * as the same user and could rewrite the file, and the next session must get
 * Boite's text again, not what one thread left there. One read per skill.
 */
export function builtinSkills(dataDir: string, onError?: (message: string) => void): { name: string; description: string; path: string }[] {
  return ensureBuiltinSkills(dataDir, onError);
}
