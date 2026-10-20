import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  remoteBrowser: {
    display: 'Affichage', resolution: 'Résolution de la page', fitPhone: 'Adapter à cet écran', phone: 'Téléphone', tablet: 'Tablette', rotate: 'Pivoter', width: 'Largeur', height: 'Hauteur', apply: 'Appliquer', sharedSize: 'La résolution change aussi la page que voit l’agent.', restoreSize: 'Revenir à la taille par défaut', previewZoom: 'Zoom de l’aperçu (cet appareil seulement)', fit: 'Ajuster', panHint: 'Glissez pour déplacer l’aperçu. Utilisez les flèches pour défiler dans la page.',
    address: 'Adresse', addressPlaceholder: 'Saisir une adresse', back: 'Précédent', forward: 'Suivant', reload: 'Recharger', badAddress: 'Saisissez une adresse web (http ou https).',
    title: 'Navigateur de l’agent', waiting: 'En attente de la page', paused: 'En pause', reconnecting: 'Reconnexion', pause: 'Pause', resume: 'Reprendre',
    interact: 'Toucher ou faire défiler la page partagée', interactDesk: 'La page partagée : cliquez dessus, puis écrivez',
    deskHint: 'Cliquez dans la page, puis écrivez. Glissez pour sélectionner, double-cliquez un mot, défilez à la molette. Copier, couper et coller passent par le clavier.',
    copy: 'Copier le texte sélectionné', copied: 'Copié.', nothingSelected: 'Rien n’est sélectionné dans la page. Touchez deux fois un mot d’abord.', copyCut: 'La sélection était trop longue : son début a été copié.', image: 'Vue en direct du navigateur de l’agent', scrollUp: 'Défiler vers le haut', scrollDown: 'Défiler vers le bas', options: 'Options de la liste',
    text: 'Touchez un champ de la page, puis écrivez ici', send: 'Envoyer le texte à la page', gesture: 'Touchez pour cliquer. Glissez pour défiler. Retour envoie le texte puis Entrée ; ⌫ sur un champ vide efface dans la page.'
  }
};
