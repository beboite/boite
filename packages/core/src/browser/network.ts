/*
 * `boite browser network`: the calls a tab's page makes to its servers, so an
 * agent finds the API behind a page and repeats it with `page.fetch` instead
 * of clicking through it. Off until an agent asks: a tab keeps no response
 * body otherwise (`Network.enable` with empty buffers in `browser.ts`).
 */
import { BROWSER_NETWORK_BODY_MAX, BROWSER_NETWORK_CALLS_MAX, type BrowserNetworkCall, type BrowserNetworkDetail } from '@boite/contracts';

/** What a page fetches for itself rather than draws: scripts, styles, images, fonts and media are left out. */
const CALL_TYPES = new Set(['Fetch', 'XHR', 'Document', 'EventSource']);
/** What Chromium keeps of the responses while capture runs, for `Network.getResponseBody`. */
export const NETWORK_BUFFERS = { maxTotalBufferSize: 20 * 1024 * 1024, maxResourceBufferSize: 4 * 1024 * 1024, maxPostDataSize: 64 * 1024 };
export const NO_NETWORK_BUFFERS = { maxTotalBufferSize: 0, maxResourceBufferSize: 0 };

interface Captured {
  call: BrowserNetworkCall;
  requestId: string;
  started: number;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  hasPostData: boolean;
  /** The page that sent it: a call to another origin needs `credentials: 'include'` to carry its cookies. */
  documentUrl?: string;
  /** A redirect's own response: the body Chromium keeps is the final one's. */
  redirected: boolean;
  finished: boolean;
}

export interface NetworkCapture { seq: number; calls: Captured[]; byRequest: Map<string, Captured> }

export const networkCapture = (): NetworkCapture => ({ seq: 0, calls: [], byRequest: new Map() });

/**
 * A name that carries a credential: a cookie, an authorization, a password, a
 * secret, a key, a session or a token, but not a page or cursor token, which
 * an agent needs to page through results. Compared in snake case.
 */
const SECRET_NAME = /(^|_)(cookie|set_cookie|authorization|auth|pass|passwd|password|pwd|secret|api_?key|access_?key|private_?key|session|session_?id|sess_?id|otp|totp|pin|cvc|cvv|csrf|xsrf|credentials?|signature|token)$/;
function secretName(name: string): boolean {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s.]+/g, '_').toLowerCase();
  return SECRET_NAME.test(snake) && !/page|cursor|continuation/.test(snake);
}
const hidden = (value: string) => `<hidden, ${value.length} characters>`;

function maskHeaders(headers: unknown): Record<string, string> {
  const masked: Record<string, string> = {};
  if (!headers || typeof headers !== 'object') return masked;
  for (const [name, raw] of Object.entries(headers as Record<string, unknown>).slice(0, 100)) {
    const value = String(raw);
    masked[name.toLowerCase()] = secretName(name) ? hidden(value) : value.slice(0, 2000);
  }
  return masked;
}

function maskJson(value: unknown, depth = 0): unknown {
  if (depth > 20 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => maskJson(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, secretName(key) && (typeof inner === 'string' || typeof inner === 'number') ? hidden(String(inner)) : maskJson(inner, depth + 1)]));
}

/** Hides the credential fields of a JSON or form body, and of a query string. */
export function maskBody(body: string, mimeType = ''): string {
  const trimmed = body.trimStart();
  if (/json/i.test(mimeType) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.stringify(maskJson(JSON.parse(body))); } catch { /* not JSON after all */ }
  }
  if (/x-www-form-urlencoded/i.test(mimeType) || (/^[^\s{[<]+=/.test(trimmed) && !trimmed.includes('\n'))) {
    const form = new URLSearchParams(body);
    let changed = false;
    for (const [key, value] of [...form]) if (secretName(key)) { form.set(key, hidden(value)); changed = true; }
    return changed ? form.toString() : body;
  }
  return body;
}

const decoded = (text: string) => { try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; } };

/** The address without its user info, a credential in its query left readable as hidden: the agent sees what to replace. */
export function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const query = url.search.slice(1).split('&').map(pair => {
      const at = pair.indexOf('=');
      return at > 0 && secretName(decoded(pair.slice(0, at))) ? `${pair.slice(0, at)}=${hidden(decoded(pair.slice(at + 1)))}` : pair;
    }).join('&');
    return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`.slice(0, 4000);
  } catch { return raw.slice(0, 4000); }
}

/**
 * Records one tab's calls while `capture()` returns its capture. `on`
 * subscribes to an event of the tab's session. A hosted tab's events carry
 * only the fields `compactPageEvent` relays (packages/ui/src/lib/browser-host.ts).
 */
export function watchNetwork(capture: () => NetworkCapture | null, on: (method: string, listener: (params: Record<string, unknown>) => void) => void): void {
  on('Network.requestWillBeSent', params => {
    const into = capture();
    const type = String(params.type ?? '');
    if (!into || !CALL_TYPES.has(type)) return;
    const request = params.request as { url?: string; method?: string; headers?: unknown; postData?: string; hasPostData?: boolean } | undefined;
    const url = String(request?.url ?? '');
    if (!/^https?:/.test(url)) return;
    const requestId = String(params.requestId);
    // A redirect reuses the request id: the call that was redirected ends with that status.
    const before = into.byRequest.get(requestId);
    const redirect = params.redirectResponse as { status?: number; headers?: unknown; mimeType?: string } | undefined;
    if (before && redirect) {
      before.redirected = true; before.finished = true;
      before.call.status = redirect.status;
      before.call.durationMs = Date.now() - before.started;
      before.responseHeaders = maskHeaders(redirect.headers);
    }
    const captured: Captured = {
      call: { id: `n${++into.seq}`, at: Date.now(), method: String(request?.method ?? 'GET'), url: maskUrl(url), type },
      requestId, started: Date.now(), requestHeaders: maskHeaders(request?.headers),
      ...(typeof request?.postData === 'string' ? { postData: request.postData.slice(0, BROWSER_NETWORK_BODY_MAX) } : {}),
      hasPostData: request?.hasPostData === true || typeof request?.postData === 'string',
      ...(typeof params.documentURL === 'string' ? { documentUrl: params.documentURL } : {}),
      redirected: false, finished: false,
    };
    into.calls.push(captured);
    into.byRequest.set(requestId, captured);
    if (into.calls.length > BROWSER_NETWORK_CALLS_MAX) {
      const gone = into.calls.shift()!;
      if (into.byRequest.get(gone.requestId) === gone) into.byRequest.delete(gone.requestId);
    }
  });
  on('Network.responseReceived', params => {
    const captured = capture()?.byRequest.get(String(params.requestId));
    const response = params.response as { status?: number; mimeType?: string; headers?: unknown } | undefined;
    if (!captured || !response) return;
    if (typeof response.status === 'number') captured.call.status = response.status;
    if (typeof response.mimeType === 'string' && response.mimeType) captured.call.mimeType = response.mimeType;
    captured.responseHeaders = maskHeaders(response.headers);
  });
  on('Network.loadingFinished', params => {
    const captured = capture()?.byRequest.get(String(params.requestId));
    if (!captured) return;
    captured.finished = true;
    captured.call.durationMs = Date.now() - captured.started;
    if (typeof params.encodedDataLength === 'number') captured.call.bytes = params.encodedDataLength;
  });
  on('Network.loadingFailed', params => {
    const captured = capture()?.byRequest.get(String(params.requestId));
    if (!captured) return;
    captured.finished = true;
    captured.call.durationMs = Date.now() - captured.started;
    captured.call.failed = params.canceled ? 'canceled' : String(params.errorText ?? 'failed').slice(0, 300);
  });
}

export function networkCalls(capture: NetworkCapture, filter?: string): BrowserNetworkCall[] {
  const wanted = filter?.toLowerCase();
  return capture.calls.map(captured => ({ ...captured.call }))
    .filter(call => !wanted || `${call.method} ${call.url} ${call.type}`.toLowerCase().includes(wanted));
}

/** Text a body can be read as; anything else is described, never sent as base64. */
const TEXT_TYPE = /^(text\/|application\/(json|[\w.+-]*\+json|javascript|ecmascript|xml|[\w.+-]*\+xml|x-www-form-urlencoded|graphql)|image\/svg\+xml)/i;
/** Headers the browser sets itself: a `page.fetch` call leaves them out. */
export const BROWSER_HEADERS = /^(cookie|host|origin|referer|user-agent|content-length|connection|accept-encoding|accept-language|sec-.*|priority|upgrade-insecure-requests|cache-control|pragma)$/i;

const quote = (text: string) => JSON.stringify(text);

/** A JSON body is written as the value it sends, which reads and edits better than an escaped string. */
function bodyCode(body: string): string {
  try { return `JSON.stringify(${JSON.stringify(JSON.parse(body))})`; } catch { return quote(body); }
}

/** The `page.fetch` call that sends the same request from the page, with its cookies. */
function fetchLine(captured: Captured, body: string | undefined): { line: string; notes: string[] } {
  const notes: string[] = [];
  const init: string[] = [];
  if (captured.call.method !== 'GET') init.push(`method: ${quote(captured.call.method)}`);
  const headers = Object.entries(captured.requestHeaders).filter(([name]) => !BROWSER_HEADERS.test(name));
  if (headers.length) init.push(`headers: { ${headers.map(([name, value]) => `${quote(name)}: ${quote(value)}`).join(', ')} }`);
  if (body !== undefined) {
    if (body.length <= 4000) init.push(`body: ${bodyCode(body)}`);
    else { init.push('body: BODY'); notes.push('BODY stands for the request body shown above'); }
  }
  try {
    if (captured.documentUrl && new URL(captured.documentUrl).origin !== new URL(captured.call.url).origin) {
      init.push('credentials: "include"');
      notes.push('the call goes to another origin than the page: page.fetch must run on a page of the same site, which open reaches first');
    }
  } catch { /* an address the page could not parse either */ }
  if ([captured.call.url, ...headers.map(([, value]) => value), body ?? ''].some(text => text.includes('<hidden, '))) notes.push('read the hidden values in the page each time (a meta tag, a cookie the page reads, an earlier call): they change');
  return { line: `await page.fetch(${quote(captured.call.url)}${init.length ? `, { ${init.join(', ')} }` : ''})`, notes };
}

type Send = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

export async function networkDetail(capture: NetworkCapture, callId: string, send: Send): Promise<BrowserNetworkDetail | null> {
  const captured = capture.calls.find(one => one.call.id === callId);
  if (!captured) return null;
  const notes: string[] = [];
  let requestBody = captured.postData;
  if (requestBody === undefined && captured.hasPostData) {
    const read = await send<{ postData?: string }>('Network.getRequestPostData', { requestId: captured.requestId }).catch(() => null);
    if (typeof read?.postData === 'string') requestBody = read.postData;
    else notes.push('the browser no longer holds the request body');
  }
  const requestType = captured.requestHeaders['content-type'] ?? '';
  if (requestBody !== undefined) {
    if (requestBody.length >= BROWSER_NETWORK_BODY_MAX) notes.push(`the request body is cut at ${BROWSER_NETWORK_BODY_MAX} characters`);
    requestBody = maskBody(requestBody.slice(0, BROWSER_NETWORK_BODY_MAX), requestType);
  }
  let responseBody: string | undefined;
  if (captured.redirected) notes.push('a redirect: the next call holds the page it led to');
  else if (captured.call.failed) notes.push(`the call failed (${captured.call.failed}) and has no body`);
  else if (!captured.finished) notes.push('the response is still loading; read it again in a moment');
  else if (captured.call.type === 'EventSource') notes.push('an event stream keeps no body to read');
  else {
    const read = await send<{ body?: string; base64Encoded?: boolean }>('Network.getResponseBody', { requestId: captured.requestId }).catch(() => null);
    const mime = captured.call.mimeType ?? '';
    if (typeof read?.body !== 'string') notes.push('the browser no longer holds the response body: repeat the call, then read it sooner');
    else if (read.base64Encoded && !TEXT_TYPE.test(mime)) notes.push(`a binary body (${mime || 'no type'}, ${Math.floor(read.body.length * 3 / 4)} bytes), not shown`);
    else {
      const text = read.base64Encoded ? Buffer.from(read.body, 'base64').toString('utf8') : read.body;
      if (text.length > BROWSER_NETWORK_BODY_MAX) notes.push(`the response body is cut at ${BROWSER_NETWORK_BODY_MAX} of its ${text.length} characters`);
      responseBody = maskBody(text.slice(0, BROWSER_NETWORK_BODY_MAX), mime);
    }
  }
  const fetch = fetchLine(captured, requestBody);
  return {
    ...captured.call, requestHeaders: captured.requestHeaders, ...(captured.responseHeaders ? { responseHeaders: captured.responseHeaders } : {}),
    ...(requestBody !== undefined ? { requestBody } : {}), ...(responseBody !== undefined ? { responseBody } : {}),
    notes: [...notes, ...fetch.notes], fetch: fetch.line,
  };
}
