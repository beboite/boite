import type { BrowserDiagnostic } from '@boite/contracts';
import type { AgentPage } from './automation.ts';

const DIALOGS_MAX = 20;
const DIAGNOSTICS_MAX = 200;

/** What of a tab its page's events write to. */
export interface WatchedPage {
  /** An agent command is running: the dialogs it raises follow `page.dialogPolicy`. */
  acting: boolean;
  page: AgentPage;
  diagnostics: BrowserDiagnostic[];
  dropped: number;
  requests: Map<string, string>;
}

/** Credentials, query and fragment never enter diagnostics: they can carry tokens. */
export function bareUrl(raw: string): string {
  try { const url = new URL(raw); return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 2000); } catch { return raw.slice(0, 200); }
}

/**
 * Listens to one tab's page: its top frame's navigations, its dialogs, its
 * console, exceptions and failed requests, the diagnostics an agent reads.
 * `on` subscribes to an event of this tab's session only.
 */
export function watchPage(
  tab: WatchedPage,
  on: (method: string, listener: (params: Record<string, unknown>) => void) => void,
  answerDialog: (accept: boolean, promptText?: string) => void,
  navigated: (url: string) => void,
): void {
  const note = (entry: Omit<BrowserDiagnostic, 'at'>) => {
    tab.diagnostics.push({ at: Date.now(), ...entry, text: entry.text.slice(0, 2000) });
    if (tab.diagnostics.length > DIAGNOSTICS_MAX) { tab.diagnostics.shift(); tab.dropped++; }
  };
  on('Page.frameNavigated', params => {
    const frame = params.frame as { parentId?: string; url: string };
    if (!frame.parentId) navigated(frame.url);
  });
  on('Page.javascriptDialogOpening', params => {
    // Nobody can answer a dialog in a headless page. One an agent command raised follows
    // `dialog accept|dismiss` and is reported to it; any other alert is accepted and a
    // question declined, so a person acting in the panel never confirms by accident.
    const type = String(params.type), message = String(params.message ?? '');
    note({ kind: 'console', level: 'info', text: `${type} dialog: ${message}` });
    const policy = tab.page.dialogPolicy;
    const accept = tab.acting && type !== 'beforeunload' ? policy.accept : type === 'alert' || type === 'beforeunload';
    const promptText = accept && type === 'prompt' ? policy.text ?? String(params.defaultPrompt ?? '') : undefined;
    if (tab.acting && (type === 'alert' || type === 'confirm' || type === 'prompt')) {
      tab.page.dialogs.push({ type, message: message.slice(0, 500), accepted: accept, ...(type === 'prompt' ? { value: accept ? promptText ?? '' : null } : {}) });
      if (tab.page.dialogs.length > DIALOGS_MAX) tab.page.dialogs.shift();
    }
    answerDialog(accept, promptText);
  });
  on('Runtime.consoleAPICalled', params => {
    const args = (params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
    note({ kind: 'console', level: String(params.type ?? 'log'), text: args.map(arg => arg.description ?? (typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value))).join(' ') });
  });
  on('Runtime.exceptionThrown', params => {
    const details = params.exceptionDetails as { text?: string; exception?: { description?: string }; url?: string };
    note({ kind: 'exception', level: 'error', text: details.exception?.description ?? details.text ?? 'exception', ...(details.url ? { url: bareUrl(details.url) } : {}) });
  });
  on('Network.requestWillBeSent', params => {
    tab.requests.set(String(params.requestId), String((params.request as { url: string }).url));
    if (tab.requests.size > 500) tab.requests.delete(tab.requests.keys().next().value!);
  });
  on('Network.responseReceived', params => {
    const response = params.response as { status: number; statusText?: string; url: string };
    if (response.status >= 400) note({ kind: 'network', level: 'error', text: `HTTP ${response.status} ${response.statusText ?? ''}`.trim(), url: bareUrl(response.url) });
  });
  on('Network.loadingFailed', params => {
    if (params.canceled) return;
    const url = tab.requests.get(String(params.requestId));
    note({ kind: 'network', level: 'error', text: String(params.errorText ?? 'request failed'), ...(url ? { url: bareUrl(url) } : {}) });
  });
}
