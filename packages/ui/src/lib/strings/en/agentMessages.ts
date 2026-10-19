export const strings = {

  agentMessages: {
    heading: 'Discussions',
    open: 'Open the discussion', back: 'All discussions', openThread: 'Open this conversation',
    empty: 'No discussion with another agent yet.',
    /** The two halves of a discussion's count, for screen readers and hover. */
    sentReceived: '{sent} sent, {received} received',
    /** A letter of this thread's own agent, in a preview. */
    mine: 'This agent',
    /** A delegation prompt the user typed, on this thread's side. */
    you: 'You',
    result: 'Result',
    about: 'Works on',
    replyTo: 'In reply to',
    /** A burst touched more discussions than the timeline lists. */
    more: '+{count} more',
    /** What a timeline row says above the other agent's name: which way the burst went. */
    sentOne: 'Sent to', sentMany: '{count} messages sent to',
    receivedOne: 'Received from', receivedMany: '{count} messages received from',
    exchanged: 'Exchange with',
    /** A thread link in an answer that no connected machine or contact holds. */
    threadMissing: 'No connected machine has this conversation.',
    /** Who started or delegated whom. Where a conversation runs is said by its project and machine, not a tag. */
    relation: {
      starter: 'Started this thread', started: 'Started from here', parent: 'Parent', child: 'Subagent', resident: 'Looks after the project'
    }
  }
} as const;
