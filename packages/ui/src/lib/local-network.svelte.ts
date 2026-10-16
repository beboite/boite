/**
 * Chrome's permission for a public page to reach a private address.
 *
 * The phone app is served from a public address (`APP_ORIGIN`), and the
 * machines it talks to sit on the owner's network or tailnet, whose addresses
 * are private. Since Chrome 147 a socket from the one to the other fails with
 * `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` until the user allows "Local
 * network" for the page, and the page only ever sees a socket error. Chrome
 * 145 named the permission `local-network`; 142 to 144 knew it as
 * `local-network-access`. A browser without either (Safari, Firefox, an older
 * Chrome) never blocks such a socket: `unknown` asks nothing of the user.
 */
export type LocalNetworkAccess = 'granted' | 'prompt' | 'denied' | 'unknown';

const NAMES = ['local-network', 'local-network-access'] as const;

class LocalNetwork {
  state = $state<LocalNetworkAccess>('unknown');

  /**
   * Reads the permission and follows it. `allowed` runs each time it turns to
   * granted, so every machine is tried at once rather than at its next retry.
   * Only the app's own page starts it: a page a machine serves is on the
   * private side already, and nothing blocks its sockets.
   */
  start(allowed: () => void): () => void {
    let stopped = false;
    let status: PermissionStatus | null = null;
    const changed = () => {
      if (status === null) return;
      const was = this.state;
      this.state = status.state;
      if (status.state === 'granted' && was !== 'granted') allowed();
    };
    void (async () => {
      const permissions = typeof navigator === 'undefined' ? undefined : navigator.permissions;
      if (permissions === undefined) return;
      for (const name of NAMES) {
        let found: PermissionStatus;
        // Not in TypeScript's PermissionName yet; a browser that does not know the name throws.
        try { found = await permissions.query({ name: name as PermissionName }); }
        catch { continue; }
        if (stopped) return;
        status = found;
        this.state = found.state;
        found.addEventListener('change', changed);
        return;
      }
    })();
    return () => {
      stopped = true;
      status?.removeEventListener('change', changed);
      this.state = 'unknown';
    };
  }
}

export const localNetwork = new LocalNetwork();
