import type { Timestamp } from './ids';
import type { PairingRole } from './pairing';
import type { Os } from './providers';

/**
 * One machine of a group. `coreId` is the fingerprint of its Ed25519 public
 * key, the same identity agent coordination signs with, so it survives a
 * change of address or of name.
 */
export interface GroupCore {
  coreId: string;
  name: string;
  os?: Os;
  /**
   * Origins the other members and their clients dial, best first: the public
   * HTTPS address, the tailnet name, the tailnet address, then the LAN one.
   */
  addresses: string[];
  /**
   * Which admission this is: 1 when the machine first joined, one more each
   * time it is admitted again after a removal. A client that was told the
   * group dropped a machine tells a member that has not caught up, which
   * still lists the old admission, from the machine having come back.
   */
  epoch: number;
}

/**
 * A phone or a browser of the group. It holds one Ed25519 key, `id` is the
 * fingerprint of it, and every member lets it in on a signature of that key
 * (`hello` `device`). A device paired before device keys still shows here
 * under `<home core id>:<session id>`, with `legacy`, until it next connects
 * and sends its key.
 */
export interface GroupDevice {
  id: string;
  name: string;
  role: PairingRole;
  /** The member that admitted it. */
  by?: string;
  /** When it was admitted, as the admitting member's clock said. */
  addedAt?: Timestamp;
  /** A pairing of the older kind, one key per member: it moves to a device key the next time it connects. */
  legacy?: true;
}

/**
 * The machines that trust each other. Every member holds the same roster and
 * accepts what another member vouches for: a client of one member is handed a
 * key by each of the others, at the role it already has.
 */
export interface Group {
  id: string;
  name: string;
  /** The core that answered. */
  self: string;
  cores: GroupCore[];
  /** The phones and browsers of the group. A device reads only its own entry. */
  devices: GroupDevice[];
  /** The id of the device that asked, when a device asked. */
  device?: string;
  /**
   * The member whose settings every other member follows (`SYNCED_SETTINGS`,
   * keybindings, brain switches), the same for every member. Absent: each
   * machine keeps its own. A core before `features.settingsHome` leaves it out.
   */
  settingsHome?: string;
}

/**
 * What "Add a device" shows: one link, drawn as a QR code. A phone scans it:
 * it is admitted to the group with its device key and reaches every member. A
 * computer pastes it: its core joins the group with the invitation the link
 * carries after `#`. Both secrets are one-time and expire.
 */
export interface DeviceInvite {
  url: string;
  expiresAt: Timestamp;
}

/**
 * Where the phone app is served from: a page that belongs to no core. Every
 * core accepts its sockets, as it does the desktop shell's, and the app reaches
 * the machines of the group it was added to from there. A core's
 * `BOITE_APP_ORIGIN` and the UI's `VITE_BOITE_APP_ORIGIN` name another one, for
 * tests and for a fork that serves its own.
 */
export const APP_ORIGIN = 'https://boite.mtsu.dev';

/** The fragment key of a device link that carries a machine's group invitation. */
export const DEVICE_LINK_JOIN = 'join';

/**
 * What a device signs to say hello to one core: the core it means, the time and
 * a one-time nonce. Nothing in it can be used on another core or twice.
 */
export function deviceHelloInput(coreId: string, at: number, nonce: string): string {
  return `boite-device-hello\n${coreId}\n${at}\n${nonce}`;
}

/** What a device signs when it is admitted: the grant it redeems, so its key is proven held by the one who scanned. */
export function deviceAdmitInput(grant: string, publicKey: string): string {
  return `boite-device-admit\n${grant}\n${publicKey}`;
}

/** A device's signed hello for one core. */
export interface DeviceHello {
  id: string;
  at: number;
  nonce: string;
  sig: string;
}

/**
 * What a machine in no group signs to tell a device so: the machine and the
 * nonce of the device's hello. Said once, for that hello only.
 */
export function ungroupedInput(coreId: string, nonce: string): string {
  return `boite-group-ungrouped
${coreId}
${nonce}`;
}

/**
 * The `data` of the Unavailable error a machine in no group answers a device's
 * signed hello with: removed or gone, its key opens nothing there, which is the
 * machine's own word that it is in no group, as a `group.get` answering null.
 * Signed with its key, so another machine at its address cannot say it in its
 * place. It says nothing of any other machine. A core older than it says only
 * "come back"; so does one joining a group, which may know the device.
 */
export interface UngroupedData {
  reason: 'ungrouped';
  /** The machine's key, SPKI PEM: its `coreId` is the SHA-256 of this text. */
  publicKey: string;
  /** Ed25519 over `ungroupedInput(coreId, nonce)`, base64. */
  sig: string;
}

/**
 * What a machine pastes to join. It names the group, the member that minted
 * it, that member's addresses and key fingerprint, and a one-time grant good
 * until `expiresAt`. It is a credential: whoever holds it joins.
 */
export interface GroupInvite {
  invite: string;
  expiresAt: Timestamp;
}

/**
 * A member's signed word that the caller may connect to another member. The
 * caller says `hello` with it there, once, within `expiresAt`, and receives a
 * session key of its own for that core.
 */
export interface GroupTicket {
  ticket: string;
  coreId: string;
  /** Where that member answers, best first. */
  addresses: string[];
  /**
   * The one address the ticket is good at: the one asked for, else the first a
   * key may be sent to. The member refuses a ticket made for an address it no
   * longer gives, so one sent where the member used to be opens nothing.
   */
  url: string;
  expiresAt: Timestamp;
}

/** The prefix of an invitation, so a pasted pairing link is told apart from one. */
export const GROUP_INVITE_PREFIX = 'boite-group:';
/** How long a ticket stays good: the time to open one socket, no more. */
export const GROUP_TICKET_TTL_MS = 60 * 1000;
/** A group is one person's machines; the roster travels whole in every exchange. */
export const GROUP_MAX_CORES = 32;
/**
 * Where a member carries a client to another member it cannot reach itself:
 * `<member>/group/relay/<core id>`, under which the other member's `/rpc`,
 * `/file/` and `/view/` answer as they would at its own address.
 */
export const GROUP_RELAY_ROUTE = '/group/relay';

/** The vendor family of a proprietary model. */
export type ModelFamily = 'anthropic' | 'openai' | 'google' | 'xai' | 'meta';

/**
 * Gateway route prefixes named after a vendor's own subscription. Behind one,
 * `claude/claude-opus-5-5` is the agent's native `claude-opus-5-5`: the core
 * lists it once, and a choice saved under the route still means that model.
 */
export const MODEL_ROUTE_FAMILIES: Readonly<Record<string, ModelFamily>> = {
  claude: 'anthropic', anthropic: 'anthropic', codex: 'openai', openai: 'openai', chatgpt: 'openai',
  gemini: 'google', google: 'google', xai: 'xai', grok: 'xai', muse: 'meta',
};

/** A model id without a vendor route prefix: `codex/gpt-6.1-sol` is `gpt-6.1-sol`, `antigravity/claude-sonnet-5` stays. */
export function nativeModelId(id: string): string {
  const slash = id.indexOf('/');
  return slash > 0 && Object.hasOwn(MODEL_ROUTE_FAMILIES, id.slice(0, slash).toLowerCase()) ? id.slice(slash + 1) : id;
}

/** `url` without its trailing slashes; a loop, since `/\/+$/` backtracks quadratically on a long run of them. */
export function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
  return url.slice(0, end);
}

/** The address a client reaches `coreId` at through the member at `memberUrl`. */
export function groupRelayUrl(memberUrl: string, coreId: string): string {
  return `${withoutTrailingSlashes(memberUrl)}${GROUP_RELAY_ROUTE}/${coreId}`;
}

/** The member and the machine a relay address names, or null for an address that is no relay. */
export function parseGroupRelayUrl(url: string): { member: string; coreId: string } | null {
  const match = /^(https?:\/\/[^/?#]+)\/group\/relay\/([0-9a-f]{64})\/?$/.exec(url);
  return match === null ? null : { member: match[1]!, coreId: match[2]! };
}

export interface GroupRpcMethods {
  /** The group this core belongs to, or null. A paired device reads the machines and its own device entry. */
  'group.get': { params: Record<string, never>; result: Group | null };
  /** Starts a group with this core as its only member. Refused while it belongs to one. Owner only. */
  'group.create': { params: { name: string }; result: Group };
  /** Rename the shared group; owner only. */
  'group.rename': { params: { name: string }; result: Group };
  /** The member every other one takes its settings from, a live member's id, or null for none. Every member hears of it. Owner only. */
  'group.settingsHome': { params: { coreId: string | null }; result: Group };
  /** A one-time invitation another machine joins with. Owner only. */
  'group.invite': { params: Record<string, never>; result: GroupInvite };
  /** Joins the group an invitation names: this core calls the member that minted it. Owner only. */
  'group.join': { params: { invite: string }; result: Group };
  /** Leaves the group and drops every key it handed out here. Owner only. */
  'group.leave': { params: Record<string, never>; result: { ok: true } };
  /** Removes another member: the others stop trusting it as each one hears of it. Owner only. */
  'group.remove': { params: { coreId: string }; result: Group };
  /** A ticket for the caller to connect to another member at its own role. */
  'group.ticket': { params: { coreId: string; url?: string }; result: GroupTicket };
  /**
   * "Add a device": one link and one code. A phone redeems it with its device
   * key and joins the group; a computer pastes the link and its core joins.
   * A core in no group starts one named after itself first. Owner only.
   */
  'group.addDevice': { params: Record<string, never>; result: DeviceInvite };
  /** Takes a device out of the group: every member refuses it from then on. Owner only. */
  'group.revokeDevice': { params: { id: string }; result: Group };
  /**
   * A client paired the older way, one key per member, hands over its device
   * key: from then on it says hello with a signature on every member. The
   * key it called with keeps working until it is revoked. A core in no group
   * starts one named after itself first.
   */
  'group.enrollDevice': { params: { publicKey: string; name?: string; at: number; sig: string }; result: { id: string; group: Group } };
}

export interface GroupRpcEvents {
  /** The roster changed, or this core joined or left a group: re-read `group.get`. */
  'group.updated': Record<string, never>;
  /** A contact, a request, a link state or the contact settings changed: re-read `contacts.get`. */
  'contacts.updated': Record<string, never>;
}
