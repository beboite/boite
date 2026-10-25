import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  taskManager: {
    title: 'Gestionnaire des tâches', scope: 'Toutes les machines connectées et les processus actifs de celle que vous choisissez, regroupés par agent.',
    agents: 'Agents', live: 'Actualisé toutes les 2 secondes', paused: 'Actualisation en pause', disconnected: 'Machine déconnectée',
    loading: 'Lecture de la consommation des agents', unsupported: 'Mettez Boite à jour sur cette machine pour voir la consommation des agents.',
    loadFailed: 'Le gestionnaire des tâches n’a pas pu se charger. Réessayez.',
    search: 'Trouver un agent', noMatches: 'Aucun agent correspondant.', sortBy: 'Trier par consommation',
    sort: { memory: 'Plus de mémoire', cpu: 'Plus de CPU', gpu: 'Plus de GPU', disk: 'Plus d’activité disque', network: 'Plus d’activité réseau' },
    disk: 'Disque', network: 'Réseau', read: 'Lecture', write: 'Écriture', download: 'Réception', upload: 'Envoi',
    observed: 'Observé', unavailableHint: 'Aucune mesure disponible pour le moment, ou ce compteur est non pris en charge. Une valeur absente ne signifie pas une consommation nulle.',
    partialHint: 'Ce total comprend seulement les agents dont la consommation peut être mesurée.',
    diskHint: 'Lectures et écritures sur le stockage observées pendant que cette vue est ouverte. Les processus brefs peuvent échapper à la mesure. Il s’agit d’activité, pas de la taille du dossier.',
    tcpHint: 'Réception et envoi TCP observés pendant que cette vue est ouverte. Les connexions brèves et le trafic UDP peuvent échapper à la mesure.',
    gpuHint: 'Utilisation du moteur GPU le plus sollicité par cet agent, mesurée par Windows.',
    stop: 'Arrêter les processus', stopConfirm: 'Arrêter tous les processus de cette conversation ?', stopping: 'Arrêt des processus',
    machines: 'Machines', online: (online: number, total: number) => `${online} sur ${total} en ligne`, memoryInUse: 'Mémoire utilisée',
    agentsOn: (machine: string) => `Agents sur ${machine}`,
    machine: {
      cpu: 'CPU', gpu: 'GPU', memory: 'Mémoire', storage: 'Stockage',
      agentCount: (count: number) => count === 1 ? `1 agent` : `${count} agents`,
      boite: (amount: string) => `Boite ${amount}`,
      vram: (used: string, total: string) => `VRAM ${used} sur ${total}`,
      of: (used: string, total: string) => `${used} sur ${total}`,
      free: (amount: string) => `${amount} libres`,
      lowSpace: 'Moins de 10 % libres',
      noGpu: 'Aucun GPU détecté', gpuUnmeasured: 'Non mesuré sur ce système', noVolumes: 'Aucun disque fixe détecté',
      offline: 'Éteinte ou inaccessible', connecting: 'Connexion en cours', reading: 'Lecture de la charge',
      unsupported: 'Mettez Boite à jour sur cette machine pour voir sa charge.', failed: 'Impossible de lire la charge de cette machine.',
      show: (machine: string) => `Afficher les agents sur ${machine}`,
    },
  }
};
