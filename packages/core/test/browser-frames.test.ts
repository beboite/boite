import { afterAll, beforeAll, expect } from 'bun:test';
import { createBrowserFixture } from './browser/fixture.ts';
import { thrown } from './settle.ts';
import { AGENT_ENV } from '@boite/contracts';
import { runCli } from '../src/cli.ts';

const browserFixture = createBrowserFixture();
const { real } = browserFixture;

// A payment form inside a frame: what it posts says whether the click was native input.
const CARD = (who: string, inner = '') => `<!doctype html><title>Card</title><style>body{margin:0}</style>
<label>Card number <input id="number"></label>
<button id="pay" onclick="top.postMessage('${who} ' + number.value + ' ' + event.isTrusted, '*')">Pay</button>${inner}`;

let checkout: ReturnType<typeof Bun.serve>, sameSite: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  // 127.0.0.1 on another port is another origin of the same site, so the same renderer;
  // localhost is another site, so a frame of its own process.
  sameSite = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => new Response(CARD(new URL(request.url).searchParams.get('who') ?? 'billing'), { headers: { 'content-type': 'text/html' } }) });
  checkout = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => {
    const { pathname, port, searchParams } = new URL(request.url);
    // The card form embeds a check of a third origin, so a frame inside a frame of another process.
    if (pathname === '/card' && searchParams.get('who') === 'local') return new Response(CARD('local'), { headers: { 'content-type': 'text/html' } });
    if (pathname === '/card') return new Response(CARD('card', `<iframe title="Verify" src="http://127.0.0.1:${sameSite.port}/?who=verify" style="display:block;margin-left:40px;width:300px;height:60px;border:2px solid #000"></iframe>`), { headers: { 'content-type': 'text/html' } });
    return new Response(`<!doctype html><title>Checkout</title><style>body{margin:0;font:16px sans-serif}</style>
<h1>Checkout</h1><p id="status">waiting</p>
<iframe title="Local" src="/card?who=local" style="margin-left:60px;width:300px;height:80px;border:3px solid #000"></iframe>
<iframe title="Card" src="http://localhost:${port}/card" style="width:400px;height:150px;border:4px solid #000;padding:6px"></iframe>
<div style="height:1400px"></div>
<iframe title="Billing" src="http://127.0.0.1:${sameSite.port}/" style="width:400px;height:150px;border:0"></iframe>
<script>addEventListener('message', event => { document.querySelector('#status').textContent = event.data })</script>`, { headers: { 'content-type': 'text/html' } });
  } });
});
afterAll(() => { checkout.stop(true); sameSite.stop(true); });

real('a snapshot lists the elements of frames from other origins with refs, and commands act on them with native input', async () => {
  const { agent, threadId } = browserFixture;
  const command = async (action: Record<string, unknown>) => (await agent.call('browser.command', { threadId, action: action as never })).value as Record<string, unknown>;
  await command({ kind: 'open', url: `http://127.0.0.1:${checkout.port}/` });
  await command({ kind: 'wait', load: 'load' });
  const interactive = String((await command({ kind: 'snapshot', interactive: true })).text);
  const refOf = (text: string, line: RegExp) => { const found = line.exec(text); expect(found, `${line} in\n${text}`).not.toBeNull(); return `@${found![1]}`; };
  const local = refOf(interactive, /iframe "Local" \[ref=e\d+\]\n- textbox "Card number" \[ref=(e\d+)\]/);
  const localPay = refOf(interactive, /iframe "Local"[^]*?button "Pay" \[ref=(e\d+)\]/);
  const card = refOf(interactive, /iframe "Card" \[ref=e\d+\]\n- textbox "Card number" \[ref=(e\d+)\]/);
  const pay = refOf(interactive, /iframe "Card"[^]*?button "Pay" \[ref=(e\d+)\]/);
  const billing = refOf(interactive, /iframe "Billing" \[ref=e\d+\]\n- textbox "Card number" \[ref=(e\d+)\]/);
  const billingPay = refOf(interactive, /iframe "Billing"[^]*?button "Pay" \[ref=(e\d+)\]/);
  const verify = refOf(interactive, /iframe "Verify" \[ref=e\d+\]\n- textbox "Card number" \[ref=(e\d+)\]/);
  const verifyPay = refOf(interactive, /iframe "Verify"[^]*?button "Pay" \[ref=(e\d+)\]/);
  const status = async () => String(await command({ kind: 'evaluate', expression: 'document.querySelector("#status").textContent' }) ?? '');
  const settled = async (wanted: string) => {
    for (const end = Date.now() + 5000; Date.now() < end && await status() !== wanted;) await Bun.sleep(50);
    return status();
  };

  // A frame of the page's own origin is read through its iframe, and clicked at its place on the page.
  await command({ kind: 'fill', selector: local, text: '77' });
  expect((await command({ kind: 'click', selector: localPay })).note).toBeUndefined();
  expect(await settled('local 77 true')).toBe('local 77 true');

  await command({ kind: 'fill', selector: card, text: '4242 4242' });
  const clicked = await command({ kind: 'click', selector: pay });
  expect(clicked.note).toBeUndefined();
  expect(await settled('card 4242 4242 true')).toBe('card 4242 4242 true');
  expect(await command({ kind: 'get', what: 'value', selector: card }) as unknown).toBe('4242 4242');

  // Below the fold: the frame is scrolled into view before the click lands in it.
  await command({ kind: 'fill', selector: billing, text: '5555' });
  expect((await command({ kind: 'click', selector: billingPay })).note).toBeUndefined();
  expect(await settled('billing 5555 true')).toBe('billing 5555 true');

  // Two frames deep, each in a process of its own: both iframes' offsets add up.
  await command({ kind: 'fill', selector: verify, text: '123' });
  expect((await command({ kind: 'click', selector: verifyPay })).note).toBeUndefined();
  expect(await settled('verify 123 true')).toBe('verify 123 true');

  const full = String((await command({ kind: 'snapshot' })).text);
  expect(full).toMatch(/^- iframe "Card" \[ref=e\d+\]\n {2}- text: Card number\n {2}- textbox "Card number" \[ref=e\d+\]: "4242 4242"$/m);
  expect(full).toMatch(/^ {2}- iframe "Verify" \[ref=e\d+\]\n {4}- text: Card number\n {4}- textbox "Card number" \[ref=e\d+\]: "123"$/m);
  // A ref read in a frame belongs to that document: after the page moves on, it is refused by name.
  await command({ kind: 'open', url: `http://127.0.0.1:${checkout.port}/?again` });
  expect(await thrown(agent.call('browser.command', { threadId, action: { kind: 'click', selector: verifyPay } }))).toThrow(`ref ${verifyPay}`);

  // The same payment in one call: a script reads the frame's refs, fills, pays and waits.
  const script = String.raw`
await page.wait({ load: 'load' })
const tree = await page.snapshot({ interactive: true })
const ref = pattern => '@' + pattern.exec(tree)[1]
await page.fill(ref(/iframe "Card" \[ref=e\d+\]\n- textbox "Card number" \[ref=(e\d+)\]/), args[0])
await page.click(ref(/iframe "Card"[^]*?button "Pay" \[ref=(e\d+)\]/))
await page.wait({ fn: () => document.querySelector('#status').textContent !== 'waiting' })
return page.get('text', '#status')`;
  let out = '', error = '';
  const code = await runCli(['browser', 'run', '-', '1111'], { cwd: browserFixture.harness.dataDir, stdin: async () => script,
    env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: browserFixture.harness.url, [AGENT_ENV.token]: browserFixture.harness.core.agents.tokenFor(threadId) },
    out: text => out += text, err: text => error += text });
  expect({ code, error }).toEqual({ code: 0, error: '' });
  expect(out).toEndWith('card 1111 true\n');
}, 120_000);
