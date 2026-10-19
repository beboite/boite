import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  serverUpdate: {
    heading: 'Serveur',
    updates: 'Mises à jour',
    current: 'À jour',
    waiting: 'En attente de la fin du travail',
    installing: 'Redémarrage du serveur',
    reconnecting: 'Reconnexion',
    progress: 'Téléchargement de la mise à jour du serveur',
    release: 'Nouveautés',
    details: 'Détails',
    timing: 'Les agents terminent leur outil en cours, 30 secondes au plus, puis le serveur se met à jour, redémarre et les reprend. Une mise à jour d’agent en cours se termine d’abord.',
    backup: 'Conversations et réglages sauvegardés. Si le démarrage échoue, la version précédente est restaurée.',
    reconnect: 'Les appareils connectés se reconnectent automatiquement.',
    confirmTitle: 'Mettre à jour {machine} ?',
    confirmBody: 'Les agents terminent leur outil en cours, 30 secondes au plus. La version {version} s’installe ensuite et ils reprennent après le redémarrage. Vos conversations sont sauvegardées.',
    manualTitle: 'Mise à jour manuelle',
    docker: 'Après la fin des agents, exécutez ceci dans le dossier Compose :',
    manual: 'Consultez le guide pour mettre à jour cette installation.',
    legacy: 'Une première mise à jour manuelle est nécessaire pour activer ce bouton.',
    guide: 'Guide de mise à jour'
  }
};
