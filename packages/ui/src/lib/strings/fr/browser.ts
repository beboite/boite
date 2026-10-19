import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  browser: {
    resetViewport: 'Adapter la page à la fenêtre',
    enlarge: 'Agrandir le navigateur',
    restore: 'Réduire le panneau',
    detach: 'Afficher en popup dans l’application',
    dock: 'Ramener dans le panneau',
    move: 'Déplacer le panneau flottant',
    loading: 'Chargement de la page',
    failed: "La page n'a pas pu être ouverte. {reason}",
    invalidUrl: 'Saisissez une adresse HTTP ou HTTPS valide, ou une recherche.',
    resetZoom: 'Réinitialiser le zoom de la page',
    back: 'Précédent',
    forward: 'Suivant',
    reload: 'Recharger',
    urlPlaceholder: 'Rechercher ou saisir une URL',
    openExternal: 'Ouvrir dans le navigateur du système',
    slotEmpty: "La page s'affiche ici dès que la coque fournit la vue web",
    slotLinux: "Le navigateur intégré n'est pas encore disponible dans l'app Linux. Ouvrez la page dans votre navigateur."
  }
};
