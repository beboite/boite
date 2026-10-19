import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  files: {
    tree: 'Fichiers du répertoire de travail',
    noRoot: 'Aucun répertoire de travail',
    filter: 'Filtrer',
    filterHint: 'Restreindre les lignes déjà chargées',
    reading: 'Lecture de ce dossier',
    empty: 'Ce dossier est vide',
    noMatch: 'Aucune ligne chargée ne correspond',
    failed: 'Ce dossier est illisible. {reason}',
    capped: 'Seules les {count} premières entrées de ce dossier sont listées.',
    readFailed: 'Ce fichier est illisible. {reason}',
    writeFailed: "Ce fichier n'a pas pu être enregistré. {reason}",
    readingFile: 'Lecture de ce fichier',
    noFile: 'Cet onglet ne porte aucun chemin',
    truncated: "Ce fichier a été coupé à sa limite de taille : ce qui suit n'est pas le fichier entier et ne peut pas être enregistré.",
    readOnly: "Enregistrer un fichier appartient au propriétaire, celui-ci s'ouvre donc en lecture seule.",
    saving: 'Enregistrement',
    unsaved: 'Modifications non enregistrées',
    discardOne: 'Fermer {name} sans enregistrer ?',
    discardMany: 'Fermer {count} fichiers sans enregistrer ?',
    discardBody: 'Le texte saisi depuis le dernier enregistrement sera perdu.',
    discardConfirm: 'Fermer sans enregistrer',
    editorLabel: 'Contenu du fichier',
    zoomIn: 'Agrandir',
    zoomOut: 'Réduire',
    fit: 'Ajuster',
    actual: '1:1',
    natural: '{width} x {height}',
    picture: "L'image de ce fichier",
    download: 'Télécharger ce fichier',
    binary: 'Rien ici ne se lit comme du texte.'
  }
};
