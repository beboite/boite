import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LAZY_MCP_ROUTE } from '../src/mcp/lazy.ts';
import { answerEach, calls, claudeThread, harness, runTurn, scripted, useClaudeHarness } from './fixtures/claude-query.ts';

useClaudeHarness();

test('the CLI reaches the stdio servers of its account through the core, until it exits', async () => {
  const client = await harness.connect();
  const threadId = await claudeThread(client);
  const account = (await client.call('accounts.list', {})).find(entry => entry.providerId === 'claude' && entry.isolationDir !== null)!;
  writeFileSync(join(account.isolationDir!, '.claude.json'), JSON.stringify({ mcpServers: {
    fixture: { type: 'stdio', command: process.execPath, args: [resolve(import.meta.dir, 'fixtures', 'stdio-mcp.ts')] },
    remote: { type: 'http', url: 'https://example.com/mcp' },
  } }));
  scripted(() => {}, answerEach('sess-lazy'));
  expect(await runTurn(client, threadId, 'hello')).toBe('done');

  const servers = calls.at(-1)!.options.mcpServers as Record<string, { type: string; url: string; headers: Record<string, string> }>;
  // The token stays in the CLI's environment: the command line carries its name only.
  expect(servers.fixture).toMatchObject({ type: 'http', headers: { Authorization: 'Bearer ${BOITE_AGENT_TOKEN}' } });
  expect(servers.fixture!.url.startsWith(`${harness.core.baseUrl()}${LAZY_MCP_ROUTE}`)).toBe(true);
  // A remote server is the CLI's own business.
  expect(servers.remote).toBeUndefined();

  // The turn's CLI is gone with the turn, and so is its way to the servers.
  const token = harness.core.agents.tokenFor(threadId as never);
  const ping = async () => (await fetch(servers.fixture!.url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }) })).status;
  let status = await ping();
  for (const deadline = Date.now() + 5000; status !== 404 && Date.now() < deadline; status = await ping()) await Bun.sleep(50);
  expect(status).toBe(404);
});
