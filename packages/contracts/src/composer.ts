import type { Attachment, PreviewReference } from './messages';
import type { PermissionMode } from './threads';

export interface ComposerChoice {
  providerId: string;
  accountId: string;
  permissionMode: PermissionMode;
  model: string | null;
  effort: string | null;
  speed?: string | null;
}

export interface ComposerDraft {
  id?: string;
  createdAt?: number;
  projectId: string | null;
  worktree: boolean;
  worktreeExplicit?: true;
  incognito?: true;
}

export interface ComposerAttachment {
  kind: 'image' | 'file';
  mimeType: string;
  name: string | null;
  assetId: string;
}

export interface ComposerQueuedPrompt {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
  previewReferences?: PreviewReference[];
  afterBoundary?: string;
  choice?: ComposerChoice;
  request?: {
    id: string;
    choice: ComposerChoice | null;
    queuedAt: number;
    failed?: string;
    sent?: true;
    start?: { projectId: string; worktree: boolean; incognito: boolean };
  };
}

export interface ComposerInput {
  text: string;
  attachments: ComposerAttachment[];
  previewReferences?: PreviewReference[];
  queued: ComposerQueuedPrompt[];
  paused: boolean;
  editing?: string | null;
}

export interface ComposerValue {
  input: ComposerInput;
  draft?: ComposerDraft;
  choice?: ComposerChoice | null;
  parked?: number;
}

export interface ComposerRecord {
  section: 'inputs' | 'drafts';
  id: string;
  revision: number;
  updatedAt: number;
  value: ComposerValue | null;
}

export interface ComposerRpcMethods {
  'composer.list': { params: {}; result: ComposerRecord[] };
  'composer.put': { params: Pick<ComposerRecord, 'section' | 'id' | 'value'> & { expectedRevision: number; sendNow?: true }; result: { accepted: boolean; record: ComposerRecord } };
  'composer.asset.put': { params: { attachment: Attachment; incognito?: true }; result: { assetId: string } };
  'composer.asset.get': { params: { assetId: string }; result: Attachment };
}

export interface ComposerRpcEvents {
  'composer.updated': ComposerRecord;
}
