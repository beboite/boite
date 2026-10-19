import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  changes: {
    clean: 'Copie de travail propre',
    noBranch: 'Aucune branche',
    ahead: '{count} en avance',
    behind: '{count} en retard',
    count: '{count} modifiés',
    oneCount: '1 modifié',
    staged: 'Indexé',
    stagedShort: 'I',
    binary: 'Fichier binaire, rien à montrer ligne par ligne',
    truncated: "Ce fichier a été tronqué : le diff ci-dessous n'est pas le fichier entier.",
    pick: 'Choisissez un fichier pour voir son diff',
    loading: 'Lecture de la copie de travail',
    renamedFrom: 'Renommé depuis {path}',
    backToList: 'Toutes les modifications',
    previousFile: 'Fichier précédent',
    nextFile: 'Fichier suivant',
    position: '{index} sur {count}',
    status: {
      added: 'Ajouté',
      modified: 'Modifié',
      deleted: 'Supprimé',
      renamed: 'Renommé',
      copied: 'Copié',
      untracked: 'Non suivi',
      conflict: 'Conflit'
    }
  }
};
