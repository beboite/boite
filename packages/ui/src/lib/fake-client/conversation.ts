

export const SPAWN_MARKER = /\[spawn:([^\]]+)\]/;

/** What `[tool-stream]` types one piece at a time before the parsed input lands. */
export const STREAMED_TOOL_INPUT = '{"command":"echo streamed","description":"a streamed input"}';

/** The three tool documents, the same ones the core's echo driver produces. */
/** What the fake agent asks when a prompt mentions a question, echo's wording. */
export const QUESTION_TEXT = 'Which shape should the echo take?';

export const QUESTION_OPTIONS = [
  { id: 'short', label: 'Short', description: 'one line back' },
  { id: 'long', label: 'Long', description: 'the whole prompt back' }
];

/** What `[ask]` asks without stopping, the way `boite ask` would. */
export const ASYNC_QUESTION_TEXT = 'Which port should the dev server take?';

export const ASYNC_QUESTION_OPTIONS = ['5173', '4173'];

export const DIFF_PATH = 'src/app.ts';

export const DIFF_OLD = 'export function boot() {\n  return start();\n}';

export const DIFF_NEW = "export function boot() {\n  return start({ warm: true });\n  log('booted');\n}";

export const DOC_TITLE = 'README.md';

export const DOC_TEXT = [
  '# README',
  '- the first item',
  '- the second item',
  '```ts',
  'export const answer = 42;',
  '```'
].join('\n');

export const IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The questions the four-hundred-message thread repeats, so heights vary down the list. */
export const LONG_ASKS = [
  'Where does the scheduler decide a turn may start?',
  'Read the descriptor loader and tell me what it refuses',
  'Why does the shell start its own core?',
  'What does the Job Object give us that a pid list does not?',
  'Show me the part of the journal that survives a crash'
];

/** The answers beside them, of deliberately uneven length. */
export const LONG_ANSWERS = [
  'In `packages/core/src/scheduler.ts`: a turn leaves the queue when both caps hold, the global one and the one on its account.',
  [
    'The loader refuses four things, each with the file, the field and what was expected:',
    '',
    '- a `protocol` it does not know',
    '- a `roots` entry that resolves outside the descriptor directory',
    '- an `env` key it would have to invent a value for',
    '- a `login` block on a provider whose account is the default one',
    '',
    'Nothing is dropped in silence, which is the rule the whole module is written to.'
  ].join('\n'),
  'Because the window is a client. The core is the host, and the shell owns it through a `KILL_ON_JOB_CLOSE` job so closing the window never leaves an agent running.',
  'Exact start and exit events for every process a thread launched, grandchildren included, plus the CPU and the peak memory the kernel already counted. A pid list gives you a guess and a race.',
  [
    'The journal is SQLite in WAL mode, so the last committed write is what a restart reads:',
    '',
    '```ts',
    "db.run('PRAGMA journal_mode = WAL');",
    "db.run('PRAGMA synchronous = NORMAL');",
    '```',
    '',
    'A turn that was running when the core died comes back as `stopped`, never as `running`.'
  ].join('\n')
];
