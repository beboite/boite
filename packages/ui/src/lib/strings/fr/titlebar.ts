import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  titlebar: {
    minimize: 'Réduire',
    maximize: 'Agrandir',
    restore: 'Restaurer',
    quitHold: 'Maintenez Ctrl+Q pour quitter',
    quitHoldHint: 'ou appuyez deux fois',
    quitTitle: 'Fermer Boite ?',
    quitWorkingOne: '1 agent travaille encore ou est en attente. Êtes-vous sûr de vouloir fermer Boite ?',
    quitWorkingMany: '{count} agents travaillent encore ou sont en attente. Êtes-vous sûr de vouloir fermer Boite ?',
    quitUnknownBody: 'Le travail sur une machine déconnectée n’a pas pu être vérifié.',
    quitResidentBody: 'Les moteurs résidents continuent de travailler après la fermeture. Ceux configurés pour s’arrêter avec l’application s’arrêteront.',
    quitConfirm: 'Fermer Boite',
    quitCancel: 'Garder ouvert'
  }
};
