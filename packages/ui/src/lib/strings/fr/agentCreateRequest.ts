import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  agentCreateRequest: {
    heading: 'Nouveau bot suggéré',
    create: 'Créer',
    refuse: 'Refuser',
    show: 'Ouvrir',
    guestHint: "Seul l'ordinateur qui fait tourner Boite peut créer un bot.",
    access: "Il tourne avec un accès complet, comme un bot créé sur la page Bots, et se présente après sa création.",
    loadFailed: "Cette carte de création de bot n'a pas chargé.",
    name: 'Nom',
    domain: 'Rôle',
    model: 'Modèle',
    projects: 'Projets',
    instructions: 'Instructions',
    noProjects: 'Aucun projet',
    noInstructions: "Aucune pour l'instant",
    defaultEffort: 'Niveau de raisonnement par défaut',
    created: 'Créé',
    refused: 'Refusé',
    closed: 'Fermé sans réponse',
  }
};
