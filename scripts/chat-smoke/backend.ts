export const calls: unknown[][] = [];
Object.assign(window, { chatSmokeCalls: calls });
export const backend = () => ({ pilot: {
  startTurn: async (...args: unknown[]) => { calls.push(["send", ...args]); },
  respond: async (...args: unknown[]) => { calls.push(["respond", ...args]); },
  interrupt: async (...args: unknown[]) => { calls.push(["interrupt", ...args]); },
} });
export const notifications = { error: (message: string) => { throw new Error(message); } };
export const log = { warn: () => {} };
