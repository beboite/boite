/**
 * One mark per provider, drawn on a 24 by 24 box in `currentColor`.
 *
 * Four come verbatim from simple-icons, which is CC0: Anthropic for `claude`,
 * OpenCode, Google Gemini for `antigravity` and X for `grok`. The two others
 * are drawn here, because no CC0 pack carries them: `codex` as six lobes around
 * a hexagonal hole, and `pi` as the letter itself. A provider that is not in
 * this map falls back to its initial (`ProviderLogo.svelte`).
 */
export interface ProviderLogo {
  /** Path data on a 24 by 24 viewBox. */
  path: string;
  /** Set when the drawing is a line: the width, in the same 24 units. Filled otherwise. */
  stroke?: number;
}

export const providerLogos: Record<string, ProviderLogo> = {
  // simple-icons, `anthropic.svg`.
  claude: {
    path: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z'
  },
  // simple-icons, `opencode.svg`.
  opencode: {
    path: 'M22 24H2V0h20zM17 4.8H7v14.4h10z'
  },
  // simple-icons, `googlegemini.svg`: Antigravity is Google's agent.
  antigravity: {
    path: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81'
  },
  // simple-icons, `x.svg`: Grok is xAI's.
  grok: {
    path: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z'
  },
  // Six loops at 60 degrees around a hexagonal hole: the family the OpenAI knot
  // belongs to, not that knot's own coordinates, which no CC0 pack carries.
  codex: {
    path: 'M12 10.5A3.85 2.35 -90 0 1 12 2.8A3.85 2.35 -90 0 1 12 10.5ZM13.3 11.25A3.85 2.35 -30 0 1 19.97 7.4A3.85 2.35 -30 0 1 13.3 11.25ZM13.3 12.75A3.85 2.35 30 0 1 19.97 16.6A3.85 2.35 30 0 1 13.3 12.75ZM12 13.5A3.85 2.35 90 0 1 12 21.2A3.85 2.35 90 0 1 12 13.5ZM10.7 12.75A3.85 2.35 150 0 1 4.03 16.6A3.85 2.35 150 0 1 10.7 12.75ZM10.7 11.25A3.85 2.35 210 0 1 4.03 7.4A3.85 2.35 210 0 1 10.7 11.25Z',
    stroke: 1.6
  },
  // The letter, as one filled comb: the bar, then the two legs.
  pi: {
    path: 'M3 4.6H21V7.4H16.8V19.4H14V7.4H10V19.4H7.2V7.4H3Z'
  }
};
