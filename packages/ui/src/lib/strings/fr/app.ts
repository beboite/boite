import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  app: {
    name: 'Boite',
    nightlyName: 'boite (de nuit)',
    channelDev: 'Dev',
    channelDevTitle: 'Le canal dev, sur son propre répertoire de données',
    loading: 'Démarrage',
    compacting: "Libération d'espace disque dans l'historique. Cela n'arrive qu'une fois et peut prendre quelques minutes.",
    noEndpointTitle: 'Aucun cœur à joindre',
    noEndpointBody:
      "Sur l'une de vos machines, ouvrez Réglages, Machines, Ajouter un appareil, puis scannez ou tapez son code ici.",
    openSettings: 'Ouvrir les réglages'
  }
};
