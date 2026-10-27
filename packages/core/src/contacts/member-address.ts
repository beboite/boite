/** The public address of one explicitly selected host thread. Never parse it to establish authority. */
export function memberThreadId(memberId: string, threadId: string): string { return `${threadId}~${memberId.slice(0, 16)}`; }
