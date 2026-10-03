import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { CoreClient } from '../client.ts';
import { CORE_VERSION } from '../version.ts';
import { boundedMcpResult, dispatchMcpTool, MCP_TOOLS, requireMcpIdentity, type McpWaitClientFactory } from './tools.ts';

// The SDK's standard-schema API requires JSON converters in addition to validation.
function schemaForMcp(schema: z.ZodType) {
  return { '~standard': { ...schema['~standard'], jsonSchema: {
    input: (): Record<string, unknown> => ({ ...z.toJSONSchema(schema, { io: 'input' }) }),
    output: (): Record<string, unknown> => ({ ...z.toJSONSchema(schema, { io: 'output' }) }),
  } } };
}

export function createBoiteMcpServer(client: CoreClient, threadId: string, waitClientFactory?: McpWaitClientFactory): McpServer {
  requireMcpIdentity(client, threadId);
  const server = new McpServer({ name: 'boite', version: CORE_VERSION });
  const outputSchema = schemaForMcp(z.strictObject({ result: z.unknown().optional(), truncated: z.boolean(),
    bytes: z.number().optional(), maxBytes: z.number().optional(), preview: z.string().optional(), next: z.string().optional() }));
  for (const [name, tool] of Object.entries(MCP_TOOLS)) {
    server.registerTool<ReturnType<typeof schemaForMcp>, ReturnType<typeof schemaForMcp>>(name, { description: tool.description, inputSchema: schemaForMcp(tool.schema), outputSchema,
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly, openWorldHint: false } },
    async (input, context) => {
      try { return await dispatchMcpTool(client, threadId, name, input, context.mcpReq.signal, waitClientFactory); }
      catch (error) { return boundedMcpResult({ error: error instanceof Error ? error.message : 'Boite MCP request failed' }, true); }
    });
  }
  return server;
}

/** SDK owns framing, schema validation, negotiation and cancellation. stdout is protocol only. */
export async function runBoiteMcp(client: CoreClient, threadId: string, err: (text: string) => void, waitClientFactory?: McpWaitClientFactory): Promise<void> {
  requireMcpIdentity(client, threadId);
  const closed = Promise.withResolvers<void>();
  const handle = serveStdio(() => {
    const server = createBoiteMcpServer(client, threadId, waitClientFactory);
    server.server.onclose = () => closed.resolve();
    return server;
  }, { transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 64 * 1024 }),
    onerror: error => { err(`boite mcp: ${error.message.slice(0, 1000)}\n`); closed.resolve(); } });
  const finish = () => closed.resolve();
  process.stdin.once('end', finish);
  process.once('SIGINT', finish);
  process.once('SIGTERM', finish);
  try { await closed.promise; }
  finally {
    process.stdin.removeListener('end', finish);
    process.removeListener('SIGINT', finish);
    process.removeListener('SIGTERM', finish);
    await handle.close();
  }
}
