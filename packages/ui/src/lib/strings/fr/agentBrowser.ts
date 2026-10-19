import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  agentBrowser: {
    cover: 'Cet agent contrôle un navigateur sur {machine}', coverHint: 'Rien n’est diffusé vers cet appareil avant que vous l’affichiez.',
    show: 'Afficher', hide: 'Masquer', hideHint: 'Arrêter de regarder et recouvrir la vue',
    none: 'L’agent n’a pas de navigateur ouvert', noneHint: 'Il apparaît ici quand l’agent ouvre une page.',
    unavailable: 'Pas de navigateur d’agent sur {machine}', tabs: 'Onglets de l’agent', untitled: 'Page sans titre',
    newTab: 'Nouvel onglet', closeTab: 'Fermer {name}', newTabHint: 'Ouvrez une page dans le navigateur de cette conversation sur {machine}. L’agent la voit et peut s’en servir.'
  }
};
