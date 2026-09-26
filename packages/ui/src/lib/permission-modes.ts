import type { Component } from 'svelte';
import { FilePen, ShieldAlert, ShieldCheck } from '@lucide/svelte';
import type { PermissionMode, ProviderSummary } from '@boite/contracts';
import { strings } from './strings';

/** What the composer offers, the most open first. */
const OFFERED: PermissionMode[] = ['bypassPermissions', 'acceptEdits', 'default'];

/**
 * The modes worth offering for this agent. Codex gives `acceptEdits` the same
 * sandbox and approval pair as `default` (`drivers/codex.ts`, `MODE_POLICY`),
 * so a second entry would promise a difference that does not exist. An agent
 * that never asks (`capabilities.approvals` false, pi today) gets no choice at
 * all: every entry would describe something it does not do.
 */
export function modesFor(provider: ProviderSummary | null | undefined): PermissionMode[] {
  if (provider && !provider.capabilities.approvals) return [];
  if (provider?.protocol === 'codex-appserver') return OFFERED.filter((mode) => mode !== 'acceptEdits');
  return OFFERED;
}

/**
 * The mode the chip shows. A choice made for another agent can hold a mode this
 * one does not offer: Codex runs `acceptEdits` as its default, so the chip says
 * so and a menu entry stays active. A legacy mode (`plan`, `dontAsk`) keeps its
 * own label until another is picked. The stored choice is left as it was.
 */
export function shownMode(mode: PermissionMode, provider: ProviderSummary | null | undefined): PermissionMode {
  const offered = modesFor(provider);
  return offered.length === 0 || offered.includes(mode) || !OFFERED.includes(mode) ? mode : 'default';
}

/** The chip's word for the mode, as this agent actually applies it. */
export function modeLabel(mode: PermissionMode, provider: ProviderSummary | null | undefined): string {
  if (mode === 'default' && provider?.protocol === 'codex-appserver') return strings.permissionModeCodex.default;
  return strings.permissionMode[mode];
}

/** The one sentence saying what the mode lets the agent do without asking. */
export function modeHint(mode: PermissionMode, provider: ProviderSummary | null | undefined): string {
  if (mode === 'default' && provider?.protocol === 'codex-appserver') return strings.permissionModeCodex.defaultLong;
  return strings.permissionModeLong[mode];
}

/** One icon per mode, the chip's and the menu row's: the open one reads as a warning. */
export function modeIcon(mode: PermissionMode): Component<{ size?: number; strokeWidth?: number }> {
  if (mode === 'bypassPermissions') return ShieldAlert as Component<{ size?: number; strokeWidth?: number }>;
  if (mode === 'acceptEdits') return FilePen as Component<{ size?: number; strokeWidth?: number }>;
  return ShieldCheck as Component<{ size?: number; strokeWidth?: number }>;
}
