import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  permissionModeLong: {
    default: 'Lit librement, demande avant de modifier un fichier ou de lancer une commande',
    acceptEdits: 'Modifie les fichiers sans demander, demande avant de lancer une commande',
    bypassPermissions: 'Exécute tout sans demander, partout sur cet ordinateur',
    yolo: 'Autorise tous les outils ; ignore les hooks Claude et Codex',
    plan: 'Plan seulement, aucune modification',
    dontAsk: 'Refuser tout ce qui demanderait une autorisation'
  }
};
