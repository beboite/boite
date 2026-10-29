import type { PermissionMode } from './threads';
import type { RequestId, ThreadId, Timestamp, TurnId } from './ids';

// ---------------------------------------------------------------------------
// Permissions: one gate for every tool call, whatever the driver.
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  id: RequestId;
  threadId: ThreadId;
  turnId: TurnId;
  toolName: string;
  input: unknown;
  description: string | null;
  createdAt: Timestamp;
}

export interface PermissionsRpcMethods {

  /**
   * The requests still unanswered, in the order they were created; every thread
   * when `threadId` is omitted. A client that connects while a turn waits reads
   * the card here, since `permission.requested` only reached the sockets that
   * were subscribed when it fired.
   */
  'permissions.list': { params: { threadId?: ThreadId }; result: PermissionRequest[] };
  'permissions.answer': {
    params: { requestId: RequestId; decision: 'allow' | 'deny' };
    result: { ok: true };
  };
}

export interface PermissionsRpcEvents {

  /** A client that missed this one reads the request from `permissions.list`. */
  'permission.requested': PermissionRequest;
  'permission.resolved': { requestId: RequestId; threadId: ThreadId; decision: 'allow' | 'deny' };
}

/** A live permission selection settles pending requests by the same rule on both transports. */
export function permissionAutoDecision(mode: PermissionMode): 'allow' | 'deny' | null {
  return mode === 'bypassPermissions' || mode === 'yolo' ? 'allow'
    : mode === 'plan' || mode === 'dontAsk' ? 'deny' : null;
}
