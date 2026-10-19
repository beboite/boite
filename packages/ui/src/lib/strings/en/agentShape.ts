export const strings = {

  /** What a Claude thread's last request started with, from the context meter. */
  agentShape: {
    open: 'What the agent sees',
    title: 'What the agent sees',
    intro: 'The system prompt and tools of the last request, as Claude Code recorded it.',
    loading: 'Reading the transcript',
    failed: 'Could not read the transcript: {error}',
    noSession: 'No request yet: send a first message.',
    noTranscript: 'The session transcript is not on this machine any more.',
    unrecorded: 'This Claude Code version records no request details. Update it to 2.1.300 or later.',
    system: 'System prompt',
    tools: 'Tools',
    block: 'Block {n}',
    truncated: 'Cut here; the block holds {chars} characters.',
    description: 'description {chars}',
    omitted: '{n} more, counted in the total',
    estimate: 'about {tokens} tokens',
    estimateHint: 'Characters divided by four: an estimate, not the provider\'s count.',
    chars: '{n} chars',
    model: 'Model',
    effort: 'Effort',
    thinking: 'Thinking',
    maxTokens: 'Max output',
    betas: 'Betas',
    version: 'Claude Code',
    sent: 'Sent',
  }
} as const;
