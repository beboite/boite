import type { Message, Thread } from '@boite/contracts';
import { T0 } from './shared';

/**
 * A thread whose answer holds what `lib/rich-markdown.ts` draws: a flowchart,
 * a sequence diagram, formulas in the line and on their own, a diagram that
 * does not parse, and a price that stays text. `?fake=1&diagrams=1` seeds it
 * for the captures of docs/diagrams-and-formulas.md.
 */
export function diagramsThread(): Thread {
  const at = T0 + 1_200_000;
  const turnId = 'turn-diagrams-1';
  const answer = [
    'The request goes through the core before it reaches the agent:',
    '',
    '```mermaid',
    'flowchart LR',
    '  Phone[Phone] -->|pairing token| Core{Core}',
    '  Desktop[Desktop] --> Core',
    '  Core --> Driver[Driver]',
    '  Driver --> Agent([Agent])',
    '```',
    '',
    'And a turn, message by message:',
    '',
    '```mermaid',
    'sequenceDiagram',
    '  participant U as User',
    '  participant C as Core',
    '  participant A as Agent',
    '  U->>C: Send prompt',
    '  C->>A: Start turn',
    '  A-->>C: Stream text',
    '  C-->>U: Render answer',
    '```',
    '',
    'The cache hit rate is \\(h = \\frac{hits}{hits + misses}\\), so the expected cost per request is',
    '',
    '$$',
    'E[c] = h \\cdot c_{hit} + (1 - h) \\cdot c_{miss} = \\sum_{i=1}^{n} p_i c_i',
    '$$',
    '',
    'A plan costs between 5 $ and 10 $ a month; `$PATH` and $HOME stay as written.',
    '',
    'This one has a typo:',
    '',
    '```mermaid',
    'flowchart LR',
    '  A --> ',
    '```'
  ].join('\n');
  const messages: Message[] = [
    { id: 'm-diagrams-1', threadId: 't-diagrams', turnId, role: 'user', parts: [{ type: 'text', text: 'Draw how a prompt reaches the agent, and the cache cost.' }], state: 'complete', createdAt: at },
    {
      id: 'm-diagrams-2', threadId: 't-diagrams', turnId, role: 'assistant', state: 'complete', createdAt: at + 2_000,
      parts: [
        { type: 'thinking', text: 'The cost is a weighted mean: \\(h c_{hit} + (1 - h) c_{miss}\\).\n\nComparing it with the miss cost.', startedAt: at + 1_000, finishedAt: at + 2_000 },
        { type: 'text', text: answer }
      ]
    }
  ];
  return {
    id: 't-diagrams', projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null, permissionMode: 'default',
    archived: false, pinned: false, title: 'Diagrams and formulas', titleSource: 'prompt', cwd: 'C:\\src\\boite', branch: null,
    status: 'idle', unread: false, sessionId: 'sess-diagrams', load: null, context: null,
    createdAt: at, updatedAt: at + 4_000, messagesBefore: null, commands: [],
    turns: [{ id: turnId, threadId: 't-diagrams', status: 'done', queuedAt: at, startedAt: at, finishedAt: at + 4_000, usage: null, error: null }],
    messages
  };
}
