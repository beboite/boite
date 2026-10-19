import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  hooks: {
    heading: 'Hooks',
    description: 'Les scripts que vos agents lancent sur leurs propres événements. Les compteurs et la liste récente partent du démarrage de Boite sur cette machine.',
    refresh: 'Actualiser les hooks',
    missing: 'Mettez Boite à jour sur cette machine pour voir vos hooks.',
    hookOne: '{count} hook', hookMany: '{count} hooks',
    moduleOne: '{count} module', moduleMany: '{count} modules',
    none: 'Aucun hook pour l\'instant',
    notFound: 'Rien trouvé',
    runOne: '{count} exécution', runMany: '{count} exécutions',
    noRuns: 'Aucune exécution pour l\'instant',
    blockedOne: '{count} bloquée', blockedMany: '{count} bloquées',
    failedOne: '{count} en échec', failedMany: '{count} en échec',
    skippedOne: '{count} ignorée', skippedMany: '{count} ignorées',
    sourceMissing: 'Introuvable',
    sourceError: 'Illisible',
    unreadable: 'Impossible de lire {path}',
    configOnly: 'Boite lit cette configuration mais ne voit pas chaque exécution.',
    sharedOne: 'Partagé avec {count} compte séparé', sharedMany: 'Partagé avec {count} comptes séparés',
    accountMisses: '{account} ne reçoit pas {path}',
    withoutOne: '{names} n\'exécute pas de hooks.', withoutMany: '{names} n\'exécutent pas de hooks.',
    recent: 'Récemment',
    since: 'Depuis {time}',
    quiet: 'Rien de bloqué ni en échec.',
    more: 'Afficher {count} de plus',
    outcomes: { blocked: 'Bloqué', failed: 'Échec', stopped: 'Arrêté', skipped: 'Ignoré' },
  }
};
