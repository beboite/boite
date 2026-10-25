/** A selected environment, with all unselected host/account/live opt-ins removed. */
export function selectedEnvironment(values: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
    'INCLUDE', 'LIB', 'LIBPATH', 'VCINSTALLDIR', 'WindowsSdkDir', 'WindowsSDKVersion']) {
    const actual = Object.keys(process.env).find(name => name.toUpperCase() === key.toUpperCase());
    if (actual) env[key] = process.env[actual];
  }
  return {...env, BOITE_HOST_AGENTS: '0', BOITE_TAILNET: '0', ...values};
}
