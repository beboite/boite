export const strings = {
  /** Temporary secret cards: metadata only, never the value. */
  secrets: {
    cardLabel: 'Secret requested by the agent',
    fieldLabel: 'Value of {name}',
    save: 'Send',
    neverShown: 'Never shown to the agent',
    decline: 'Decline',
    plainLink: 'Answer from the PC or over HTTPS',
    saved: '{name} sent for one use',
    declined: '{name} declined',
    cancelled: '{name} not asked anymore',
    timedOut: '{name} timed out',
    heading: 'Secret Drop',
    transit: 'Memory only. One use. Expires after 10 minutes or when the turn ends or Boite stops.',
    info: 'Each request opens a new card. Boite erases its temporary copy after the first use, after 10 minutes, when the turn ends or when Boite stops. Nothing is kept for the project. An agent can still read a file it writes the secret to; that value can then reach its provider. Masking works only inside Boite.'
  }
} as const;
