import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  imports: {
    title: 'Importer une session dans {project}',
    intro: "Sessions Claude Code lancées dans ce dossier. L'une d'elles devient une conversation avec son historique, et le tour suivant la continue.",
    loading: 'Recherche des sessions',
    empty: 'Aucune session Claude Code pour ce dossier.',
    imported: 'Importée',
    chooseAccount: 'Choisir un compte pour {title}',
    accounts: '{count} comptes',
    importing: 'Import en cours',
  }
};
