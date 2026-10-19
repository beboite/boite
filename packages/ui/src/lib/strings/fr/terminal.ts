import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  terminal: {
    title: 'Terminal',
    hide: 'Masquer le terminal',
    close: 'Fermer le shell',
    resize: 'Redimensionner le terminal',
    tab: 'Terminal {n}',
    tabs: 'Terminaux',
    new: 'Nouveau terminal',
    splitRight: 'Diviser à droite',
    splitDown: 'Diviser en bas',
    closeTab: "Fermer l'onglet",
    resizePanes: 'Redimensionner la division',
    find: 'Chercher dans le terminal',
    history: 'Commandes récentes',
    historySearch: 'Chercher une commande',
    historyEmpty: "Aucune commande dans l'historique de ce shell pour l'instant",
    historyNone: 'Aucune commande ne correspond',
    historyOld: 'Cette machine a une version de Boite trop ancienne pour les lister',
    historyLoading: "Lecture de l'historique",
    historyHint: 'Entrée la lance, Maj+Entrée la met au prompt',
    running: 'Une commande tourne',
    failed: 'La dernière commande a échoué (code {code})'
  }
};
