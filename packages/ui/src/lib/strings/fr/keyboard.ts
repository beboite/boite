import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  keyboard: {
    heading: 'Raccourcis',
    intro: 'Cliquez sur un raccourci, puis appuyez sur les touches voulues. Le changement s\'applique aussitôt sur cette machine.',
    search: 'Filtrer les commandes',
    groups: { general: 'Général', surfaces: 'Panneau latéral', thread: 'Conversation et message', jump: 'Aller à une conversation', theme: 'Thème', terminal: 'Terminal' },
    record: 'Appuyez sur les touches',
    change: 'Changer le raccourci',
    reset: 'Revenir au défaut',
    resetAll: 'Tout réinitialiser',
    clear: 'Retirer le raccourci',
    conflict: '{chord} lance déjà "{command}". Le déplacer ici ?',
    replace: 'Le déplacer ici',
    needsModifier: "Tenez Ctrl, Alt ou Win avec la touche. Une touche seule, ou avec Maj seulement, c'est de la frappe.",
    noMatch: 'Aucune commande ne correspond.',
    file: 'Fichier des raccourcis',
    openFile: 'Ouvrir le fichier',
    copyPath: 'Copier le chemin',
    openFailed: 'Impossible d’ouvrir le fichier : {reason}',
    fileHint:
      'Des identifiants de commande associés à des raccourcis comme "mod+shift+k", ou null pour retirer une touche. mod vaut Ctrl ici et Cmd sur un Mac. Les entrées absentes gardent leur valeur par défaut.',
    id: 'Identifiant',
    none: 'Non défini',
    custom: 'modifié',
    problems: 'Refusé',
    problemsHint: 'Ces lignes du fichier n\'ont pas été appliquées. Corrigez-les et enregistrez.',
    commands: {
      palette: 'Ouvrir la palette de commandes',
      browser: 'Ouvrir la surface navigateur',
      changes: 'Ouvrir la surface des modifications',
      files: "Ouvrir l'arbre des fichiers",
      tasks: 'Ouvrir la surface des tâches',
      closeSurface: 'Fermer la surface active',
      stash: 'Mettre le message de côté, ou le reprendre',
      sendAndDraft: 'Envoyer et ouvrir une nouvelle conversation',
      pin: 'Épingler ou désépingler cette conversation',
      reopenThread: 'Rouvrir la dernière conversation archivée',
      copyAnswer: 'Copier la dernière réponse',
      find: 'Chercher dans cette conversation',
      terminalNew: 'Nouveau terminal',
      terminalSplit: 'Diviser le terminal à droite',
      terminalSplitVertical: 'Diviser le terminal en bas',
      terminalClose: 'Fermer le terminal',
      terminalFind: 'Chercher dans le terminal',
      terminalHistory: 'Commandes récentes du shell',
      terminalPreviousCommand: 'Aller à la commande précédente',
      terminalNextCommand: 'Aller à la commande suivante',
      thread: 'Aller à la conversation {n}'
    }
  }
};
