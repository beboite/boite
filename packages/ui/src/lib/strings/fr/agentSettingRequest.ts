import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  agentSettingRequest: {
    heading: 'Changement suggéré pour {name}',
    apply: 'Appliquer',
    show: 'Ouvrir ses réglages',
    refuse: 'Refuser',
    guestHint: "Seul l'ordinateur qui fait tourner Boite peut changer les réglages d'un agent.",
    projectsHint: 'Décochez un projet pour le laisser de côté.',
    entrust: 'Confier',
    takeBack: 'Reprendre',
    loadFailed: "Cette carte de réglage d'agent n'a pas chargé.",
    to: 'vers',
    applied: 'Appliqué',
    changed: 'Réglé sur {value} à la place',
    refused: 'Refusé',
    closed: 'Fermé sans réponse',
    on: 'Activé',
    off: 'Désactivé',
    none: 'Aucun',
    noProjects: 'Aucun projet',
    defaultEffort: 'Par défaut',
    dollars: '{amount} $ par jour',
    noCap: 'Sans limite',
    send: 'Envoyer',
    keys: {
      projects: 'Projets',
      model: 'Modèle',
      effort: 'Niveau de raisonnement',
      autoMemory: 'Mettre à jour la mémoire après chaque tâche',
      subagents: 'Sous-agents',
      dailyBudget: 'Budget quotidien de ses réveils',
    },
  }
};
