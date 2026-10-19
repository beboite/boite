import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  browserTools: {
    title: 'Outils de test du navigateur', desktop: 'Ordinateur', laptop: 'Portable', portrait: 'Portrait', landscape: 'Paysage',
    system: 'Apparence du système', light: 'Page claire', dark: 'Page sombre', diagnostics: 'Diagnostics et actions de la page',
    startRecording: 'Enregistrer cet onglet', stopRecording: 'Arrêter la vidéo', reviewRecording: 'Vidéo enregistrée',
    clear: 'Effacer', pageEvents: 'Événements de la page', actions: 'Actions', noEvents: 'Aucun événement capturé.', noActions: 'Aucune action enregistrée pour le moment.',
    omitted: '{count} événements anciens ou trop volumineux omis.', recorded: '{seconds} secondes · {fps} i/s · {mb} Mo · {format} sans son',
    recordingError: 'Enregistrement arrêté après une erreur.', recordingLimit: 'Enregistrement arrêté de lui-même à la limite de {mb} Mo. La vidéo se lit jusqu’à ce point.',
    frameRate: 'Enregistrer à {rate} images par seconde', codec: 'Encoder en {codec}', codecUnavailable: 'Cet ordinateur ne sait pas l’encoder',
    unplayable: 'Cette vue ne peut pas lire la vidéo {codec}. Téléchargez-la pour la regarder dans un autre lecteur.',
    download: 'Télécharger la vidéo', discard: 'Supprimer la vidéo',
  }
};
