import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  desktopUpdate: {
    heading: 'Application de bureau',
    progress: 'Téléchargement de la mise à jour de l’application',
    ready: 'Téléchargée, prête à installer',
    installing: 'Installation, Boite redémarre là-bas',
    current: 'À jour',
    elsewhere: 'Installez cette mise à jour sur la machine elle-même : son installateur peut demander une confirmation.',
    confirmTitle: 'Mettre à jour Boite sur {machine} ?',
    confirmBody: 'La version {version} s’installe quand les agents de cette machine ont fini. Boite redémarre sur {machine} et le travail en cours reprend.',
    requested: 'Une autre machine installe Boite {version} ici. Boite redémarre dans un instant.'
  }
};
