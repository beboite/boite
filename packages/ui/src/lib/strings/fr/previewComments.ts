import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  previewComments: {
  annotate: 'Référencer un élément',
  picking: 'Sélectionnez un élément dans la page. Échap annule.',
  add: 'Ajouter au message',
  added: 'Élément ajouté à votre message.',
  unavailable: 'Cet élément est inaccessible. Utilisez l’application de bureau pour les pages d’une autre origine.',
  failed: 'La sélection a échoué. Rechargez la page et réessayez.',
  reveal: 'Montrer cet élément dans l’aperçu',
  remove: 'Retirer la référence à cet élément',
  stale: 'Cet aperçu a changé de page. Rouvrez la page d’origine ou sélectionnez à nouveau l’élément.',
  missing: 'Cet élément n’existe plus dans la page. Sélectionnez-le à nouveau.',
  tooMany: 'Un message peut référencer au maximum 8 éléments de page.',
  activityUnsupported: 'Les références ne sont pas disponibles avec /goal ou /loop. Envoyez un message ordinaire ou retirez les références.',
  stashUnsupported: 'Ce brouillon contient des références et ne peut pas être mis de côté. Envoyez-le ou retirez les références.'
}
};
