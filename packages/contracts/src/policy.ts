import type { ProviderId, Timestamp } from './ids';

/**
 * The admin policy: a machine-wide file only an administrator can write
 * (`docs/enterprise.md`). Each key locks one behaviour of Boite; a key that is
 * absent leaves the user's own choice. The core reads it, enforces it and
 * tells its clients what it locks. Only the file changes it.
 */

/** `off`: nothing is checked nor downloaded. `check`: checked and shown, the user installs. `auto`: installed by itself. */
export type UpdatePolicy = 'off' | 'check' | 'auto';

export interface AdminPolicy {
  /** A ceiling on usage analytics: `basic` forbids enhanced, `off` sends nothing, consent receipts included. */
  analytics?: 'off' | 'basic';
  updates?: {
    /** The desktop app's own updater. */
    app?: UpdatePolicy;
    /** A standalone server core's updater. */
    server?: UpdatePolicy;
    /** The agent CLIs Boite updates. */
    agents?: UpdatePolicy;
  };
  /** Which providers may run. `allow` lists the only ones; `deny` removes some. Both apply when both are set. */
  providers?: { allow?: ProviderId[]; deny?: ProviderId[] };
  /** False forbids the subscription gateway and moving credentials into it; `allowedBaseUrls` limits where it may point. */
  gateway?: boolean | { allowedBaseUrls: string[] };
  /** False stops every quota read and reset that sends an account's OAuth token. */
  quotaReads?: boolean;
  plugins?: {
    /** False refuses installing a plugin, from the catalog or from a URL. */
    install?: boolean;
    /** False stops reading the recommended plugins' repositories for new releases. */
    recommended?: boolean;
  };
  /** False refuses the bug report to GitHub. */
  issueReports?: boolean;
  /** `local` forbids the cloud engines and their fallback; `off` forbids dictation, downloads included. */
  dictation?: 'local' | 'off';
  previews?: {
    /** False keeps agent-made HTML previews from loading anything outside the preview itself. */
    remoteResources?: boolean;
  };
  /** False refuses the agent browser; `searchUrl` replaces the address bar's search for text that is not an address. */
  agentBrowser?: boolean | { searchUrl: string };
  network?: {
    /** False keeps the core on loopback: no LAN listening. */
    lan?: boolean;
    /** False refuses serving this core over Tailscale HTTPS. */
    tailscaleServe?: boolean;
    /** False refuses creating or joining a group and stops requests to its members. */
    groups?: boolean;
    /** False refuses contacts: invitations, joins, links and the Tailscale API. */
    contacts?: boolean;
    /** False refuses Web Push notifications. */
    push?: boolean;
  };
  /** False stops reading pull requests through `gh`: discovery, links, watches and the merged-PR archive. */
  pullRequests?: boolean;
}

/** Every key a policy can lock, as messages and `PolicyState.locked` name them. */
export const POLICY_KEYS = [
  'analytics',
  'updates.app', 'updates.server', 'updates.agents',
  'providers.allow', 'providers.deny',
  'gateway', 'gateway.allowedBaseUrls',
  'quotaReads',
  'plugins.install', 'plugins.recommended',
  'issueReports',
  'dictation',
  'previews.remoteResources',
  'agentBrowser', 'agentBrowser.searchUrl',
  'network.lan', 'network.tailscaleServe', 'network.groups', 'network.contacts', 'network.push',
  'pullRequests',
] as const;
export type PolicyKey = typeof POLICY_KEYS[number];

/** One thing wrong with the policy file: which file, which field, and what was expected there. */
export interface PolicyProblem {
  file: string;
  /** The dotted field, or `(file)` when the file itself could not be read as JSON. */
  field: string;
  expected: string;
  message: string;
}

export interface PolicyState {
  /** The file that was read, or the first place one is looked for when none exists. */
  file: string | null;
  /** A policy file exists. False: no key is locked and nothing changes for the user. */
  present: boolean;
  /** The values in force, after validation. A key absent here is the user's. */
  values: AdminPolicy;
  /** The keys in force, in `POLICY_KEYS` order. */
  locked: PolicyKey[];
  problems: PolicyProblem[];
  /** The file could not be parsed: every key takes its strictest value until it is fixed. */
  failedClosed: boolean;
  readAt: Timestamp;
}

/** What a client gets when the policy refuses: the key, the file and the message. */
export interface PolicyRefusalData {
  policy: PolicyKey;
  file: string | null;
}

export interface PolicyRpcMethods {
  /** The policy as the core enforces it. A paired device reads it to draw its locked controls. */
  'policy.get': { params: Record<string, never>; result: PolicyState };
}

export interface PolicyRpcEvents {
  /** The file appeared, changed or went away. */
  'policy.changed': PolicyState;
}
