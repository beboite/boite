import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  devicePanel: {
    cover: 'Cet agent contrôle un appareil sur {machine}', coverHint: 'Rien n’est diffusé vers cet appareil avant que vous l’affichiez.',
    show: 'Afficher', hide: 'Masquer', hideHint: 'Arrêter de regarder et recouvrir la vue',
    empty: "Aucun appareil n'est ouvert dans cette conversation. Un agent en ouvre un avec boite device open, ou ouvrez-en un ici.",
    onMachine: 'Sur cette machine', add: 'Ouvrir un appareil',
    none: 'Aucun simulateur ni émulateur trouvé sur cette machine.',
    starting: 'Démarrage de {name}. Cela peut prendre une minute.', failed: "{name} n'a pas démarré",
    stopped: 'Éteint', running: 'Allumé', booting: 'Démarrage',
    viewOnly: "Lecture seule. L'agent pilote les simulateurs iOS avec xcrun simctl.",
    back: 'Retour', home: 'Accueil', recents: 'Applications récentes', rotate: 'Pivoter', power: "Bouton d'alimentation", enter: 'Entrée', backspace: 'Effacer le caractère précédent',
    text: 'Écrire dans le champ actif', send: 'Envoyer le texte', ascii: "Seuls les caractères ASCII imprimables atteignent l'appareil.",
    screenshot: "Enregistrer une capture d'écran", close: 'Fermer {name}', shutdown: 'Éteindre',
    interact: "Touchez ou glissez sur l'écran de l'appareil", interactDesk: "L'écran de l'appareil : cliquez dessus, puis écrivez",
    deskHint: "Cliquez sur l'écran, puis écrivez. Glissez pour balayer, défilez à la molette, Échap revient en arrière. Coller écrit le presse-papiers ; copier depuis l'appareil n'est pas disponible.", image: 'Vue en direct de {name}', gesture: 'Touchez pour appuyer. Glissez pour balayer.'
  }
};
