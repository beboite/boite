export interface CliPreset {
  id: string;
  label: string;
  command: string;
  iconKey: string;
  executable: string;
  docUrl: string;
}

export interface SetupRecommendation {
  id: string;
  label: string;
  iconKey: string;
  executable: string;
  docUrl: string;
  description: string;
  linkLabel: string;
}

export const SETUP_RECOMMENDATIONS: SetupRecommendation[] = [
  {
    id: "bun",
    label: "Bun",
    iconKey: "bun",
    executable: "bun",
    docUrl: "https://bun.sh",
    description: "Bun accelere l'installation des dependances et l'execution des projets qui utilisent JavaScript ou TypeScript.",
    linkLabel: "Site de Bun",
  },
  {
    id: "codex-everywhere",
    label: "Codex Everywhere",
    iconKey: "codex",
    executable: "codex",
    docUrl: "https://docs.codex-everywhere.com/quickstart/",
    description: "Passerelle API compatible pour connecter Codex avec une cle API Codex Everywhere. Le service annonce GPT-5.4/5.5 a 3 % du tarif OpenAI.",
    linkLabel: "Guide Codex Everywhere",
  },
];
export const CLI_PRESETS: CliPreset[] = [
	{
		id: "claude",
		label: "Claude",
		command: "claude",
		iconKey: "claude",
		executable: "claude",
		docUrl: "https://code.claude.com/docs/en/overview",
	},
	{
		id: "codex",
		label: "Codex",
		command: "codex --no-alt-screen",
		iconKey: "codex",
		executable: "codex",
		docUrl: "https://github.com/openai/codex",
	},
	{
		id: "opencode",
		label: "Opencode",
		command: "opencode",
		iconKey: "opencode",
		executable: "opencode",
		docUrl: "https://opencode.ai/docs",
	},
	{
		id: "cursor",
		label: "Cursor Agent",
		command: "cursor-agent",
		iconKey: "cursor",
		executable: "cursor-agent",
		docUrl: "https://cursor.com/fr/cli",
	},
	{
		id: "antigravity",
		label: "Antigravity",
		command: "agy",
		iconKey: "antigravity",
		executable: "agy",
		docUrl: "https://antigravity.google/docs/cli",
	},
	{
		id: "copilot",
		label: "Copilot",
		command: "gh copilot",
		iconKey: "copilot",
		executable: "gh",
		docUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
	},
	{
		id: "grok",
		label: "Grok",
		command: "grok",
		iconKey: "grok",
		executable: "grok",
		docUrl: "https://x.ai/blog/grok-2",
	},
	{
		id: "hermes",
		label: "Hermes",
		command: "hermes",
		iconKey: "hermes",
		executable: "hermes",
		docUrl: "https://github.com/NousResearch/hermes-agent#installation",
	},
];
