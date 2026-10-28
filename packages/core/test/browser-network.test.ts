import { expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV, type BrowserNetworkCall, type BrowserNetworkDetail, type BrowserRecipe } from '@boite/contracts';
import { maskBody } from '../src/browser/network.ts';
import { runCli } from '../src/cli.ts';
import { createBrowserFixture } from './browser/fixture.ts';
import { thrown } from './settle.ts';

const browserFixture = createBrowserFixture();
const { real, url } = browserFixture;

test('masking keeps pagination tokens and hides credentials in JSON that does not parse whole', () => {
  const masked = JSON.parse(maskBody(JSON.stringify({ pageToken: 'p1', next_page_token: 'p2', nextToken: 'p3', pageAccessToken: 'EAAB1', page_access_token: 'EAAB2', cursorSecret: 'c1', client_secret_key: 'sk', signingKey: 'k2' })));
  expect(masked).toEqual({ pageToken: 'p1', next_page_token: 'p2', nextToken: 'p3', pageAccessToken: '<hidden, 5 characters>', page_access_token: '<hidden, 5 characters>', cursorSecret: '<hidden, 2 characters>', client_secret_key: '<hidden, 2 characters>', signingKey: '<hidden, 2 characters>' });
  // A guard prefix, a stream of values and a cut-off text fail JSON.parse; their pairs are masked one by one.
  expect(maskBody(`)]}'\n{"token":"abc","n":1}`, 'application/json')).toBe(`)]}'\n{"token":"<hidden, 3 characters>","n":1}`);
  expect(maskBody('{"a":1}\n{"apiKey": "k-1"}\n', 'application/x-ndjson')).toBe('{"a":1}\n{"apiKey": "<hidden, 3 characters>"}\n');
  expect(maskBody('<script>window.state = {"sessionId":"s-42","pin":1234}</script>', 'text/html')).toBe('<script>window.state = {"sessionId":"<hidden, 4 characters>","pin":"<hidden, 4 characters>"}</script>');
  expect(maskBody('{"rows":[1,2],"password":"hunt', 'application/json')).toBe('{"rows":[1,2],"password":"<hidden, 4 characters>"');
});

real('network finds the API call behind a page with its credentials hidden, and a recipe repeats it with page.fetch', async () => {
  const { harness, agent, threadId } = browserFixture;
  const command = (action: Parameters<typeof agent.call<'browser.command'>>[1]['action']) => agent.call('browser.command', { threadId, action });
  const cli = async (args: string[], stdin?: string) => {
    let out = '', error = '';
    const code = await runCli(['browser', ...args], { cwd: harness.dataDir, ...(stdin === undefined ? {} : { stdin: async () => stdin }),
      env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
      out: text => out += text, err: text => error += text });
    return { code, out, error };
  };
  const loaded = async () => {
    for (let tries = 0; tries < 100; tries++) {
      if ((await command({ kind: 'get', what: 'title' })).value === 'loaded 2') return;
      await Bun.sleep(50);
    }
    throw new Error('the page never loaded its items');
  };

  await command({ kind: 'open', url: url('/app') });
  // Capture starts on the first call, so a page that loaded before keeps no body.
  expect((await command({ kind: 'network' })).value).toEqual({ capturing: true, started: true, calls: [] });
  await command({ kind: 'click', selector: '#load' });
  await loaded();
  const { calls } = (await command({ kind: 'network', filter: 'api' })).value as { calls: BrowserNetworkCall[] };
  expect(calls).toEqual([expect.objectContaining({ method: 'POST', type: 'Fetch', status: 200, mimeType: 'application/json' })]);
  const call = calls[0]!;
  // A query token is hidden; a page number is not, an agent pages through with it.
  expect(call.url).toBe(url('/api/items?page=2&token=<hidden, 6 characters>'));

  // Re-enabling the domain with buffers is what lets Chromium hand the body back.
  const detail = (await command({ kind: 'network-detail', callId: call.id })).value as BrowserNetworkDetail;
  expect(detail.requestHeaders.authorization).toBe('<hidden, 19 characters>');
  expect(JSON.parse(detail.requestBody!)).toEqual({ query: 'shoes', password: '<hidden, 7 characters>' });
  expect(JSON.parse(detail.responseBody!)).toEqual({ items: ['red', 'blue'], query: 'shoes', next: 'cursor-2', sessionToken: '<hidden, 7 characters>' });
  expect(detail.fetch).toBe(`await page.fetch(${JSON.stringify(call.url)}, { method: "POST", headers: { "authorization": "<hidden, 19 characters>", "content-type": "application/json" }, body: JSON.stringify({"query":"shoes","password":"<hidden, 7 characters>"}) })`);
  expect(detail.notes).toEqual([expect.stringContaining('read the hidden values in the page each time')]);
  const printed = await cli(['network', call.id]);
  // The headers the browser sets itself are left out: page.fetch sends them anyway.
  expect(printed.out).toContain('request headers:\n  authorization: <hidden, 19 characters>\n  content-type: application/json\nrequest body:');
  expect(printed.out).not.toMatch(/s3cret|hunter2|abc123|tok-999/);

  // Bodies past what detail shows are masked before they are cut: cut first, their JSON no longer parses.
  await command({ kind: 'evaluate', expression: "fetch('/api/big', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'hunter2', rows: 'x'.repeat(60000) }) }).then(r => r.text()).then(t => t.length)" });
  const bigCall = ((await command({ kind: 'network', filter: 'big' })).value as { calls: BrowserNetworkCall[] }).calls[0]!;
  const bigDetail = (await command({ kind: 'network-detail', callId: bigCall.id })).value as BrowserNetworkDetail;
  expect(bigDetail.requestBody).toStartWith('{"password":"<hidden, 7 characters>","rows":"xxx');
  expect(bigDetail.responseBody).toStartWith('{"sessionToken":"<hidden, 7 characters>","rows":"yyy');
  expect(bigDetail.notes).toEqual(expect.arrayContaining([expect.stringContaining('the request body is cut at 50000'), expect.stringContaining('the response body is cut at 50000')]));

  // Stopping forgets the calls and the bodies Chromium kept.
  await command({ kind: 'network-stop' });
  expect(await thrown(command({ kind: 'network-detail', callId: call.id }))).toThrow('network capture is off');

  // The call made from a script gets the data back without a click; an error status fails its step.
  // A JSON reply sent as text after a space is still read as JSON.
  expect((await cli(['run', '-'], "return (await page.fetch('/api/big')).json.sessionToken")).out).toEndWith('tok-big\n');
  // A reply past 2,000,000 characters is cut while it is read.
  expect((await cli(['run', '-'], "const reply = await page.fetch('/api/huge'); return [reply.truncated, reply.text.length]")).out).toEndWith(`${JSON.stringify([true, 2_000_000], null, 2)}\n`);
  const tooLong = await cli(['run', '-'], "await page.fetch('/api/items', { method: 'POST', body: 'x'.repeat(40000) })");
  expect(tooLong.out).toContain('✗ step 1, fetch POST /api/items: page.fetch sends at most 32000 characters of address, headers and body, this one 40');
  const fetched = await cli(['run', '-'], "return (await page.fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: args[0] }) })).json");
  expect(fetched.code).toBe(0);
  expect(fetched.out).toContain('"query": null');
  const failed = await cli(['run', '-'], "await page.fetch('/api/fail')");
  expect(failed.code).toBe(1);
  expect(failed.out).toContain('✗ step 1, fetch GET /api/fail: HTTP 500: {"error":"the shelf is empty"}');

  // A recipe is kept once its run passed, under the site it worked on, and the next open names it.
  const script = `await page.open(${JSON.stringify(url('/app'))})\nconst reply = await page.fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: args[0] }) })\nreturn reply.json.items.map(item => args[0] + ' ' + item)`;
  const saved = await cli(['recipe', 'save', 'list-items', '-', '--about', 'Lists the items of a query', '--usage', '<query>', 'hats'], script);
  expect(saved.code).toBe(0);
  expect(saved.out).toContain('✓ Kept recipe list-items\n  boite browser recipe run list-items <query>\n  127.0.0.1; 1 run, last passed');
  expect(statSync(join(harness.dataDir, 'browser-recipes', 'list-items.json')).mode & 0o777).toBe(0o600);
  const ran = await cli(['recipe', 'run', 'list-items', 'caps']);
  expect(ran.code).toBe(0);
  expect(ran.out).toEndWith(`${JSON.stringify(['caps red', 'caps blue'], null, 2)}\n`);
  expect(((await command({ kind: 'recipes' })).value as { recipes: BrowserRecipe[] }).recipes).toEqual([expect.objectContaining({ name: 'list-items', sites: ['127.0.0.1'], runs: 2, lastRun: expect.objectContaining({ ok: true }) })]);
  expect((await cli(['open', url('/shop')])).out).toContain('recipes kept for this site: list-items (Lists the items of a query); browser recipe run <name> runs one');
}, 60_000);
