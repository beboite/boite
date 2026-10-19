import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  board: {
    tab: 'Tableau',
    terminalTab: 'Terminal',
    tabs: 'Tiroir',
    open: 'Tableau du projet',
    hide: 'Masquer le tableau',
    columns: { todo: 'À faire', doing: 'En cours', review: 'En revue', done: 'Fini' },
    doingHint: 'Une carte posée ici lance une conversation /goal2 avec la carte pour objectif. Sa barre est la checklist de cet objectif.',
    add: 'Ajouter une carte',
    addPlaceholder: 'Ce qu\'il faut faire',
    actions: 'Actions de la carte',
    moveTo: 'Déplacer vers {column}',
    openThread: 'Ouvrir sa conversation',
    remove: 'Supprimer la carte',
    reviewing: 'En relecture',
    awaiting: 'Vous attend',
    starting: 'Lancement',
    pages: 'Colonnes',
    page: '{column}, {count}'
  }
} as const;
