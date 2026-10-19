import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  taskManager: {
    title: 'Gestionnaire des tâches', scope: 'Processus actifs sur cette machine, regroupés par agent.',
    agents: 'Agents', live: 'Actualisé toutes les 2 secondes', paused: 'Actualisation en pause', disconnected: 'Machine déconnectée',
    loading: 'Lecture de la consommation des agents', unsupported: 'Mettez Boite à jour sur cette machine pour voir la consommation des agents.',
    loadFailed: 'Le gestionnaire des tâches n’a pas pu se charger. Réessayez.',
    search: 'Trouver un agent', noMatches: 'Aucun agent correspondant.', sortBy: 'Trier par consommation',
    sort: { memory: 'Plus de mémoire', cpu: 'Plus de CPU', disk: 'Plus d’activité disque', network: 'Plus d’activité réseau' },
    disk: 'Disque', network: 'Réseau', read: 'Lecture', write: 'Écriture', download: 'Réception', upload: 'Envoi',
    observed: 'Observé', unavailableHint: 'Aucune mesure disponible pour le moment, ou ce compteur est non pris en charge. Une valeur absente ne signifie pas une consommation nulle.',
    partialHint: 'Ce total comprend seulement les agents dont la consommation peut être mesurée.',
    diskHint: 'Lectures et écritures sur le stockage observées pendant que cette vue est ouverte. Les processus brefs peuvent échapper à la mesure. Il s’agit d’activité, pas de la taille du dossier.',
    tcpHint: 'Réception et envoi TCP observés pendant que cette vue est ouverte. Les connexions brèves et le trafic UDP peuvent échapper à la mesure.',
    stop: 'Arrêter les processus', stopConfirm: 'Arrêter tous les processus de cette conversation ?', stopping: 'Arrêt des processus',
  }
};
