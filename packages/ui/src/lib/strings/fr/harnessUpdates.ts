import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  harnessUpdates: {
    heading: 'Mises à jour des agents',
    intro: 'Chaque machine vérifie ses agents toutes les six heures.',
    auto: 'Mettre les agents à jour automatiquement',
    autoHint: "Un agent se met à jour sans que personne ne soit connecté : une conversation en cours se met en pause après son appel d'outil et reprend une fois la mise à jour faite",
    checking: 'Vérification',
    available: (name: string, version: string) => `${name} ${version} est disponible`,
    availableShort: 'Mise à jour disponible',
    installed: (version: string) => `Version installée : ${version}`,
    on: (machine: string) => `Sur ${machine}`,
    update: 'Mettre à jour', skip: 'Ignorer',
    updating: (name: string) => `Mise à jour de ${name}`,
    waiting: (count: number) => count === 1 ? "Attend la pause d'une conversation" : `Attend la pause de ${count} conversations`,
    failed: (name: string) => `La mise à jour de ${name} a échoué`,
    upToDate: 'À jour', unknown: 'Vérifie lui-même', runUpdater: 'Lancer sa mise à jour',
    skipped: (version: string) => `${version} ignorée`,
    unskip: 'Proposer à nouveau', none: "Aucun agent sur cette machine ne possède de programme de mise à jour que Boite peut lancer.",
    route: { managed: 'Installé par Boite', self: 'Votre installation' }
  }
};
