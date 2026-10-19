import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  agentShape: {
    open: "Ce que voit l'agent",
    title: "Ce que voit l'agent",
    intro: 'Le prompt système et les outils de la dernière requête, tels que Claude Code les a notés.',
    loading: 'Lecture du transcript',
    failed: 'Lecture du transcript impossible : {error}',
    noSession: 'Aucune requête pour l\'instant : envoyez un premier message.',
    noTranscript: "Le transcript de la session n'est plus sur cette machine.",
    unrecorded: 'Cette version de Claude Code ne note pas le détail des requêtes. Passez à la 2.1.300 ou plus récente.',
    system: 'Prompt système',
    tools: 'Outils',
    block: 'Bloc {n}',
    truncated: 'Coupé ici ; le bloc fait {chars} caractères.',
    description: 'description {chars}',
    omitted: '{n} de plus, comptés dans le total',
    estimate: 'environ {tokens} tokens',
    estimateHint: 'Caractères divisés par quatre : une estimation, pas le compte du fournisseur.',
    chars: '{n} car.',
    model: 'Modèle',
    effort: 'Effort',
    thinking: 'Réflexion',
    maxTokens: 'Sortie max',
    betas: 'Bêtas',
    version: 'Claude Code',
    sent: 'Envoyée',
  }
};
