import { vi } from 'vitest';

/** The opener plugin is the shell's system browser; nothing real may run in a test. */
export const openUrl = vi.fn(async (_url: string) => {});
