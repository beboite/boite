import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  homeCards: {
    region: 'Cartes de statut',
    refresh: 'Actualiser {title}',
    refreshing: 'Actualisation',
    updated: 'Mis à jour {age}',
    never: 'Pas encore actualisée',
    every: 'Actualisée toutes les {minutes} min',
    buttonOnly: 'Actualisée par ce bouton',
    failed: 'Dernière actualisation en échec : {reason}',
    about: 'À propos de {title}',
    details: 'Détails de {label}',
    more: '+{count}',
    refused: '{id} n\'a pas pu être lue',
  },
};
