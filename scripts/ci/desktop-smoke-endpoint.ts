import { readFileSync } from 'node:fs';

export interface CoreEndpoint {
  pid: number;
  port: number;
  token: string;
}

export interface EndpointWaitOptions {
  deadline: number;
  exitCode: () => number | null;
}

function isCoreEndpoint(value: unknown): value is CoreEndpoint {
  if (!value || typeof value !== 'object') return false;
  const endpoint = value as Partial<CoreEndpoint>;
  return typeof endpoint.pid === 'number' && Number.isInteger(endpoint.pid) && endpoint.pid > 0
    && typeof endpoint.port === 'number' && Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65_535
    && typeof endpoint.token === 'string' && endpoint.token.length > 0;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function waitForCoreEndpoint(file: string, options: EndpointWaitOptions): Promise<CoreEndpoint> {
  while (true) {
    const exitCode = options.exitCode();
    if (exitCode !== null) throw new Error(`Shell exited with ${exitCode}`);
    if (Date.now() > options.deadline) throw new Error('Installed shell did not start its core within 30 seconds');
    try {
      const endpoint: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (isCoreEndpoint(endpoint)) return endpoint;
    } catch (error) {
      if (!(error instanceof SyntaxError) && !isMissingFile(error)) throw error;
    }
    await Bun.sleep(100);
  }
}
