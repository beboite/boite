import type { Message, Thread } from '@boite/contracts';
import { T0 } from './shared';

/**
 * A thread whose answer holds what `lib/rich-markdown.ts` draws: a flowchart,
 * a sequence diagram, formulas in the line and on their own, a diagram that
 * does not parse, a price that stays text and a ```view block's simulator.
 * `?fake=1&diagrams=1` seeds it for the captures of docs/diagrams-and-formulas.md.
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
    '```',
    '',
    'Move the hit rate to see what a request costs:',
    '',
    '```view',
    '<div class="card stack">',
    '  <label class="field">Hit rate <input id="rate" type="range" min="0" max="100" value="80"> <output id="out">80 %</output></label>',
    '  <div class="row">',
    '    <div class="stat"><span class="label">Cost per request</span><b id="cost">0.28 ¢</b></div>',
    '    <div class="bar" id="bar" style="--value:28%"></div>',
    '  </div>',
    '</div>',
    '<script>',
    '  const rate = document.getElementById("rate");',
    '  rate.oninput = () => {',
    '    const cost = rate.value / 100 * 0.1 + (1 - rate.value / 100) * 1;',
    '    document.getElementById("out").value = rate.value + " %";',
    '    document.getElementById("cost").textContent = cost.toFixed(2) + " ¢";',
    '    document.getElementById("bar").style.setProperty("--value", cost * 100 + "%");',
    '  };',
    '</script>',
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
