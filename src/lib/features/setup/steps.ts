import type { Component } from "svelte";
import type { Shortcut } from "$lib/types";
import AgentsStep from "./AgentsStep.svelte";

/// What the wizard hands to `completeSetup` on the last step. Nothing is
/// persisted before then, so quitting mid-wizard leaves the install untouched.
export interface SetupDraft {
  shortcuts: Shortcut[];
}

export interface SetupStepProps {
  draft: SetupDraft;
}

export interface SetupStep {
  id: string;
  component: Component<SetupStepProps>;
}

/// One entry per screen after the welcome. The dots, the back/next wiring and
/// the finish button all read this list, so a new screen is a line here plus
/// its component. The MCP switches are the next one.
export const SETUP_STEPS: SetupStep[] = [{ id: "agents", component: AgentsStep }];
