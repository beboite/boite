import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  media: {
    sourceTooLarge: '{name} pèse {size} : Boite réduit les images de {max} au plus, elle a donc été laissée de côté.',
    viewer: 'Visionneuse',
    previous: 'Précédente',
    next: 'Suivante',
    position: '{index} sur {total}',
    share: 'Partager ou enregistrer',
    shareFailed: 'Impossible de partager {name}.',
    shareReady: '{name} est prêt : touchez Partager à nouveau.',
    answerFiles: 'Fichiers joints : {names}',
    answerFileCount: '{count} fichiers'
  }
};
