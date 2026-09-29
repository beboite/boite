import type { Account } from '@boite/contracts';
import type { AcpLoginInput } from '../acp/login.ts';

/** Ask the CLI which account it uses, including Keychain logins on macOS. */
export async function readClaudeAccount(input: Omit<AcpLoginInput, 'methodId'>): Promise<Pick<Account, 'status' | 'identity'>> {
  const child = input.spawnChild(input.executable, [...input.args, 'auth', 'status', '--json'], { cwd: input.cwd, env: input.env });
  child.stderr.resume();
  let output = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
  try {
    const result = new Promise<Pick<Account, 'status' | 'identity'>>((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 64 * 1024) reject(new Error('Claude returned too much connection output.'));
      });
      child.once('error', () => reject(new Error('Claude could not start. Check its installation.')));
      child.once('close', () => {
        try {
          const status = JSON.parse(output) as { loggedIn?: boolean; email?: string };
          if (typeof status.loggedIn !== 'boolean') throw new Error('invalid status');
          resolve({ status: status.loggedIn ? 'ok' : 'unauthenticated', identity: status.loggedIn && typeof status.email === 'string' ? status.email : null });
        } catch { reject(new Error('Claude did not return a connection status. Update Claude and retry.')); }
      });
      timer = setTimeout(() => reject(new Error('Claude did not check its connection within 20 seconds.')), 20_000);
    });
    return await result;
  } finally {
    clearTimeout(timer);
    child.kill();
    await exited;
  }
}
