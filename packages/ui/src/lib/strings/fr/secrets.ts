import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  secrets: {
    cardLabel: "Secret demandé par l'agent",
    fieldLabel: 'Valeur de {name}',
    save: 'Envoyer',
    neverShown: "Jamais montrée à l'agent",
    decline: 'Refuser',
    plainLink: 'Réponds depuis le PC ou en HTTPS',
    saved: '{name} envoyé pour un usage unique',
    declined: '{name} refusé',
    cancelled: "{name} n'est plus demandé",
    timedOut: 'La demande de {name} a expiré',
    heading: 'Secret Drop',
    transit: "En mémoire uniquement. Usage unique. Expire après 10 minutes, à la fin du tour ou à l'arrêt de Boite.",
    info: "Chaque demande ouvre une nouvelle carte. Boite efface sa copie temporaire au premier usage, après 10 minutes, à la fin du tour ou à son arrêt. Rien ne reste pour le projet. Un agent peut toujours relire un fichier dans lequel il écrit le secret ; cette valeur peut alors parvenir à son fournisseur. Le masquage fonctionne uniquement dans Boite."
  }
};
