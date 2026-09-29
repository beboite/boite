import pkg from '../../../package.json';
import type { Account } from '@boite/contracts';
import type { AcpLoginInput, AcpLoginRun } from '../acp/login.ts';
import { CodexRpc } from './rpc.ts';
import { CLIENT_NAME } from './protocol.ts';

type AuthInput = Omit<AcpLoginInput, 'methodId'>;
interface AccountResponse {
  account: { type: string; email?: string | null } | null;
  requiresOpenaiAuth: boolean;
}

/** Auth requests never create a conversation or send a model prompt. */
function connection(input: AuthInput) {
  const child = input.spawnChild(input.executable, input.args, { cwd: input.cwd, env: input.env });
  child.stderr.resume();
  const exited = new Promise<void>(resolve => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
  let notification = (_method: string, _params: unknown): void => {};
  const rpc = new CodexRpc(child, {
    notification: (method, params) => notification(method, params),
    request: () => Promise.reject(new Error('No turn is running during sign-in')),
    log: () => {},
  });
  const died = new Promise<never>((_, reject) => {
    child.once('exit', code => reject(new Error(`Codex closed during sign-in (exit ${code ?? 'unknown'}). Retry the connection.`)));
    child.once('error', () => reject(new Error('Codex could not start. Check its installation.')));
  });
  // Initialization starts after the caller has installed its login state.
  const initialize = async () => {
    await rpc.request('initialize', { clientInfo: { name: CLIENT_NAME, title: null, version: pkg.version }, capabilities: null });
    rpc.notify('initialized', {});
  };
  const kill = () => {
    rpc.fail('The Codex connection is closed');
    child.stdin.end();
    child.kill();
  };
  return { rpc, exited, died, initialize, kill, listen: (fn: typeof notification) => { notification = fn; } };
}

export function runCodexLogin(input: AuthInput): AcpLoginRun {
  const peer = connection(input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = (async () => {
    let complete!: () => void;
    let fail!: (error: Error) => void;
    let expected: string | null = null;
    const finished = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    peer.listen((method, params) => {
      if (method !== 'account/login/completed') return;
      const result = params as { loginId: string; success: boolean; error: string | null };
      if (expected !== null && result.loginId !== expected) return;
      if (result.success) complete();
      else fail(new Error(result.error ?? 'Codex sign-in failed. Start a new connection.'));
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The sign-in code expired. Start a new connection.')), 15 * 60_000);
    });
    const login = async () => {
      await peer.initialize();
      const response = await peer.rpc.request<{ type: string; loginId: string; verificationUrl: string; userCode: string }>('account/login/start', { type: 'chatgptDeviceCode' });
      if (response.type !== 'chatgptDeviceCode' || !response.verificationUrl || !response.userCode) throw new Error('Codex did not return a sign-in code. Update Codex and retry.');
      expected = response.loginId;
      input.onLine(`${response.verificationUrl}\n${response.userCode}`);
      await finished;
    };
    try { await Promise.race([login(), peer.died, timeout]); }
    finally { clearTimeout(timer); }
  })();
  return { done, exited: peer.exited, kill: peer.kill };
}

export async function readCodexAccount(input: AuthInput): Promise<Pick<Account, 'status' | 'identity'>> {
  const peer = connection(input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Codex did not verify the connection within 20 seconds.')), 20_000);
    });
    const read = async () => {
      await peer.initialize();
      const response = await peer.rpc.request<AccountResponse>('account/read', { refreshToken: true });
      return { status: response.account !== null || response.requiresOpenaiAuth === false ? 'ok' : 'unauthenticated', identity: response.account?.email ?? null } as const;
    };
    return await Promise.race([read(), peer.died, timeout]);
  } finally {
    clearTimeout(timer);
    peer.kill();
    await peer.exited;
  }
}
