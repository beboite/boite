import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {executionIdentity} from '../../execution-policy.ts';
import type {ProtectionRunner} from '../protected.ts';

export const windowsHelperVersion = 'boite-windows-protected 2';
export type WindowsLaunchMode = 'run' | 'run-null-broker';
// Windows may update ChangeTime on execution. Pin the object and its bytes.
export const windowsHelperIdentity = (path: string) => `${executionIdentity(path)}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

export interface WindowsAdmission {
  helper: string;
  identity: string;
  profile: string;
  checkout: string;
  probe: string;
  ambient: string;
  scratch: string;
  env: Record<string, string>;
}

/** The trusted native probe must execute inside the actual selected boundary. */
export async function admitWindowsExecution(input: WindowsAdmission, run: ProtectionRunner): Promise<WindowsLaunchMode> {
  const check = () => {
    if (windowsHelperIdentity(input.helper) !== input.identity) throw new Error('execution.windows.helper: captured launcher bytes or file identity changed');
  };
  const attempt = async (mode: WindowsLaunchMode) => {
    check();
    const result = await run(input.helper, [mode, input.profile, input.checkout, input.probe, '--probe', input.ambient], input.scratch, input.env);
    check();
    return result;
  };
  let mode: WindowsLaunchMode = 'run', result = await attempt(mode);
  const denied = 'execution.windows.probe.null-device: native call failed (5); no unprotected fallback';
  const diagnostic = result.stderr.trim().replaceAll('\r\n', '\n');
  if (result.code === 125 && result.stdout === '' && (diagnostic === denied || diagnostic === `${denied}\nexecution.windows.child: exit status 125`)) {
    mode = 'run-null-broker';
    result = await attempt(mode);
  }
  if (result.code || result.stdout !== windowsHelperVersion) throw new Error(`execution.windows.lpac: native protected launch failed (${result.code}): ${result.stderr.trim()}; no unprotected fallback`);
  return mode;
}
